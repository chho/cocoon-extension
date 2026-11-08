import type { ZhihuContentSource } from "./zhihu-content-source.ts";
import {
  MAX_RETRIES,
  defaultDelay,
  retryDelay,
  canRetryNetworkError,
  isAuthenticationStatus,
  fetchWithRetry,
  getJsonRequestInit,
  readJson,
  responseReason,
  type PageObserver,
} from "./zhihu-request.ts";
import type { RemoteFetch, RetryOptions, RetriedFetchResult } from "./zhihu-request.ts";
import { observeVoters as safeObserve } from "./voter-observation.ts";
import type { VoterObserver, VoterPageReason } from "./voter-observation.ts";

import {
  ZHIHU_ORIGIN,
  VOTER_PAGE_SIZE,
  validateAndNormalizeNextUrl,
} from "./zhihu-pagination-url.ts";
export { VOTER_PAGE_SIZE, validateAndNormalizeNextUrl } from "./zhihu-pagination-url.ts";
export const MAX_PAGES_PER_VOTER_ORDER = 100;
export const MAX_UNIQUE_VOTERS = VOTER_PAGE_SIZE * MAX_PAGES_PER_VOTER_ORDER * 2;
const MAX_RELATION_PAGES = 100;

export type { RemoteFetch, Delay } from "./zhihu-request.ts";

export interface ZhihuVoter {
  readonly userId: string;
  readonly authorName: string;
}

export type FatalRemoteReason = "authentication" | "rate-limit";

export interface VoterFetchProgress {
  readonly fetched: number;
  readonly unique: number;
  readonly complete: boolean;
}

export interface VoterFetchResult {
  readonly users: readonly ZhihuVoter[];
  readonly fetched: number;
  readonly invalid: number;
  readonly duplicates: number;
  readonly complete: boolean;
  readonly fatalReason: FatalRemoteReason | null;
  readonly requestFailures: number;
}

export interface BlockedUsersResult {
  readonly userIds: ReadonlySet<string>;
  readonly complete: boolean;
  readonly fatalReason: FatalRemoteReason | null;
}

export type CurrentUserResult =
  | { readonly status: "success"; readonly userId: string }
  | {
      readonly status: "failed";
      readonly reason: FatalRemoteReason | "network" | "http" | "invalid-response";
    };

export type RemoteBlockResult =
  | { readonly status: "success"; readonly endpoint: "primary" | "fallback" }
  | { readonly status: "stopped" }
  | {
      readonly status: "failed";
      readonly reason: FatalRemoteReason | "csrf" | "network" | "http";
    };

interface VoterFetchOptions extends RetryOptions {
  readonly onProgress?: (progress: VoterFetchProgress) => void;
  readonly observer?: VoterObserver;
  readonly now?: () => number;
}

interface ParsedPage<T> {
  readonly data: readonly T[];
  readonly isEnd: boolean;
  readonly next: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeUserId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const userId = value.trim();
  if (
    !userId ||
    userId !== value ||
    userId.includes("/") ||
    userId.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(userId)
  ) {
    return null;
  }
  return userId;
}

function parsePaging(value: unknown): { isEnd: boolean; next: string | null } | null {
  if (!isRecord(value) || typeof value.is_end !== "boolean") {
    return null;
  }
  if (value.next !== null && value.next !== undefined && typeof value.next !== "string") {
    return null;
  }
  const next = typeof value.next === "string" && value.next.length > 0 ? value.next : null;
  if (!value.is_end && next === null) {
    return null;
  }
  return { isEnd: value.is_end, next };
}

function parseMemberPage(value: unknown): ParsedPage<unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > VOTER_PAGE_SIZE) {
    return null;
  }
  const paging = parsePaging(value.paging);
  return paging ? { data: value.data, ...paging } : null;
}

function parseVoter(value: unknown): ZhihuVoter | null {
  if (!isRecord(value)) {
    return null;
  }
  const userId = normalizeUserId(value.url_token);
  if (!userId || typeof value.name !== "string") {
    return null;
  }
  const authorName = value.name.trim();
  return authorName ? { userId, authorName } : null;
}

function voterPath(source: ZhihuContentSource): string {
  return source.kind === "answer"
    ? `/api/v4/answers/${source.contentId}/upvoters`
    : `/api/v4/articles/${source.contentId}/likers`;
}

function createVoterPageUrl(source: ZhihuContentSource, order: "default" | "newest"): string {
  const url = new URL(voterPath(source), ZHIHU_ORIGIN);
  url.searchParams.set("order", order);
  url.searchParams.set("limit", String(VOTER_PAGE_SIZE));
  url.searchParams.set("offset", "0");
  return url.toString();
}

export function readXsrfToken(cookie: string): string | null {
  const values = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if ((name === "xsrf" || name === "_xsrf") && value) {
      values.set(name, value);
    }
  }
  const encoded = values.get("xsrf") ?? values.get("_xsrf");
  if (!encoded) {
    return null;
  }
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

export async function fetchCurrentZhihuUser(
  fetchImpl: RemoteFetch,
  options: RetryOptions = {},
): Promise<CurrentUserResult> {
  const result = await fetchWithRetry(
    fetchImpl,
    `${ZHIHU_ORIGIN}/api/v4/me`,
    getJsonRequestInit(),
    options,
  );
  if (result.status === "rate-limit") {
    return { status: "failed", reason: "rate-limit" };
  }
  if (result.status !== "response") {
    return { status: "failed", reason: "network" };
  }
  if (isAuthenticationStatus(result.response.status)) {
    return { status: "failed", reason: "authentication" };
  }
  if (!result.response.ok) {
    return { status: "failed", reason: "http" };
  }
  const value = await readJson(result.response);
  const userId = isRecord(value) ? normalizeUserId(value.url_token) : null;
  return userId ? { status: "success", userId } : { status: "failed", reason: "invalid-response" };
}

export async function fetchZhihuBlockedUserIds(
  fetchImpl: RemoteFetch,
  options: RetryOptions = {},
): Promise<BlockedUsersResult> {
  const path = "/api/v3/settings/blocked_users";
  const firstUrl = new URL(path, ZHIHU_ORIGIN);
  firstUrl.searchParams.set("limit", String(VOTER_PAGE_SIZE));
  firstUrl.searchParams.set("offset", "0");
  let nextUrl: string | null = firstUrl.toString();
  let complete = false;
  const userIds = new Set<string>();
  const visited = new Set<string>();

  for (let page = 0; page < MAX_RELATION_PAGES && nextUrl; page += 1) {
    if (options.isStopped?.()) {
      break;
    }
    if (visited.has(nextUrl)) {
      break;
    }
    visited.add(nextUrl);
    const result = await fetchWithRetry(fetchImpl, nextUrl, getJsonRequestInit(), options);
    if (result.status === "rate-limit") {
      return { userIds, complete: false, fatalReason: "rate-limit" };
    }
    if (result.status !== "response") {
      break;
    }
    if (isAuthenticationStatus(result.response.status)) {
      return { userIds, complete: false, fatalReason: "authentication" };
    }
    if (!result.response.ok) {
      break;
    }
    const parsed = parseMemberPage(await readJson(result.response));
    if (!parsed) {
      break;
    }
    for (const item of parsed.data) {
      if (isRecord(item)) {
        const userId = normalizeUserId(item.url_token);
        if (userId) {
          userIds.add(userId);
        }
      }
    }
    if (parsed.isEnd) {
      complete = true;
      nextUrl = null;
    } else {
      nextUrl = parsed.next ? validateAndNormalizeNextUrl(parsed.next, path, null) : null;
    }
  }

  return { userIds, complete, fatalReason: null };
}

interface VoterFetchState {
  readonly users: Map<string, ZhihuVoter>;
  fetched: number;
  invalid: number;
  duplicates: number;
  requestFailures: number;
  fatalReason: FatalRemoteReason | null;
  safetyLimitReached: boolean;
}

function voterRequestFailure(
  result: RetriedFetchResult,
  state: VoterFetchState,
): VoterPageReason | null {
  if (result.status === "rate-limit") {
    state.fatalReason = "rate-limit";
    return "rate-limit";
  }
  if (state.safetyLimitReached) return "user-limit";
  if (result.status === "stopped") return state.fatalReason ?? "stopped";
  if (result.status === "network-failure") {
    state.requestFailures += 1;
    return "network";
  }
  const reason = responseReason(result.response);
  if (reason === "authentication") state.fatalReason = reason;
  else if (reason) state.requestFailures += 1;
  return reason;
}

function collectVoterRows(data: readonly unknown[], state: VoterFetchState) {
  let invalid = 0;
  let duplicates = 0;
  let added = 0;
  for (const item of data) {
    state.fetched += 1;
    const voter = parseVoter(item);
    if (!voter) {
      invalid += 1;
      continue;
    }
    if (state.users.has(voter.userId)) {
      duplicates += 1;
      continue;
    }
    state.users.set(voter.userId, voter);
    added += 1;
    if (state.users.size >= MAX_UNIQUE_VOTERS) {
      state.safetyLimitReached = true;
      break;
    }
  }
  state.invalid += invalid;
  state.duplicates += duplicates;
  return { rows: data.length, invalid, duplicates, added, unique: state.users.size };
}

function voterNextPage(
  parsed: ParsedPage<unknown>,
  path: string,
  order: "default" | "newest",
): { next: string | null; reason: VoterPageReason } {
  if (parsed.isEnd) return { next: null, reason: "end" };
  const next = parsed.next ? validateAndNormalizeNextUrl(parsed.next, path, order) : null;
  return { next, reason: next ? "next" : "invalid-next" };
}

interface VoterOrderContext {
  readonly fetchImpl: RemoteFetch;
  readonly source: ZhihuContentSource;
  readonly options: VoterFetchOptions;
}

function voterOrderStop(options: RetryOptions, state: VoterFetchState): VoterPageReason | null {
  if (options.isStopped?.()) return "stopped";
  if (state.fatalReason) return state.fatalReason;
  return state.safetyLimitReached ? "user-limit" : null;
}

function acceptVoterPage(
  parsed: ParsedPage<unknown>,
  state: VoterFetchState,
  { source, options }: VoterOrderContext,
  observation: PageObserver,
): string | null {
  const counts = collectVoterRows(parsed.data, state);
  options.onProgress?.({ fetched: state.fetched, unique: state.users.size, complete: false });
  const next = voterNextPage(parsed, voterPath(source), observation.order);
  if (next.reason === "invalid-next") state.requestFailures += 1;
  let reason = next.reason;
  if (reason !== "invalid-next" && state.safetyLimitReached) reason = "user-limit";
  else if (reason === "next" && observation.page === MAX_PAGES_PER_VOTER_ORDER)
    reason = "page-limit";
  safeObserve(options.observer, {
    kind: "page",
    order: observation.order,
    page: observation.page,
    stage: "end",
    ...counts,
    reason,
    isEnd: parsed.isEnd,
    hasNext: next.next !== null,
  });
  return next.next;
}

function observeRejectedVoterPage(
  observation: PageObserver,
  unique: number,
  reason: VoterPageReason,
  rows?: number,
): void {
  safeObserve(observation.observer, {
    kind: "page",
    order: observation.order,
    page: observation.page,
    stage: "end",
    reason,
    ...(rows === undefined ? {} : { rows }),
    invalid: 0,
    duplicates: 0,
    added: 0,
    unique,
  });
}

function rawPageRows(input: unknown): number | undefined {
  return isRecord(input) && Array.isArray(input.data) ? input.data.length : undefined;
}

async function fetchVoterOrder(
  order: "default" | "newest",
  state: VoterFetchState,
  context: VoterOrderContext,
): Promise<boolean> {
  const { fetchImpl, source, options } = context;
  let nextUrl: string | null = createVoterPageUrl(source, order);
  const visited = new Set<string>();
  for (let page = 1; page <= MAX_PAGES_PER_VOTER_ORDER && nextUrl; page += 1) {
    const observation = { observer: options.observer, now: options.now, order, page };
    safeObserve(options.observer, { kind: "page", order, page, stage: "start" });
    const stop = voterOrderStop(options, state);
    if (stop) {
      observeRejectedVoterPage(observation, state.users.size, stop, 0);
      return false;
    }
    if (visited.has(nextUrl)) {
      state.requestFailures += 1;
      observeRejectedVoterPage(observation, state.users.size, "repeated-next", 0);
      return false;
    }
    visited.add(nextUrl);
    const result = await fetchWithRetry(fetchImpl, nextUrl, getJsonRequestInit(), {
      delay: options.delay,
      isStopped: () => options.isStopped?.() === true || state.fatalReason !== null,
      observation,
    });
    const failure = voterRequestFailure(result, state);
    if (failure) {
      observeRejectedVoterPage(observation, state.users.size, failure);
      return false;
    }
    if (result.status !== "response") return false;
    const input = await readJson(result.response);
    const parsed = parseMemberPage(input);
    if (!parsed) {
      state.requestFailures += 1;
      const rows = rawPageRows(input);
      observeRejectedVoterPage(observation, state.users.size, "invalid-response", rows);
      return false;
    }
    nextUrl = acceptVoterPage(parsed, state, context, observation);
    if (parsed.isEnd) return true;
  }
  return false;
}

export async function fetchZhihuVoters(
  fetchImpl: RemoteFetch,
  source: ZhihuContentSource,
  options: VoterFetchOptions = {},
): Promise<VoterFetchResult> {
  const state: VoterFetchState = {
    users: new Map(),
    fetched: 0,
    invalid: 0,
    duplicates: 0,
    requestFailures: 0,
    fatalReason: null,
    safetyLimitReached: false,
  };
  const context = { fetchImpl, source, options };
  const completedOrders = await Promise.all([
    fetchVoterOrder("default", state, context),
    fetchVoterOrder("newest", state, context),
  ]);
  // Live read-only checks (2026-11-01): an answer with >5,000 reported votes ended at
  // 2,000 rows for both sorts and with order omitted; rows need not be unique users.
  // This is observed API behavior, not a guaranteed cap for all answers or articles.
  // Do not impose a 2,000-user client limit: follow validated pagination as usual.
  // "complete" means API pagination ended, not that every reported voter was returned.
  const complete =
    completedOrders.every(Boolean) &&
    state.fatalReason === null &&
    !state.safetyLimitReached &&
    options.isStopped?.() !== true;
  options.onProgress?.({ fetched: state.fetched, unique: state.users.size, complete });
  return {
    users: [...state.users.values()],
    fetched: state.fetched,
    invalid: state.invalid,
    duplicates: state.duplicates,
    complete,
    fatalReason: state.fatalReason,
    requestFailures: state.requestFailures,
  };
}

export async function blockZhihuUser(
  fetchImpl: RemoteFetch,
  userId: string,
  cookie: string,
  options: RetryOptions = {},
): Promise<RemoteBlockResult> {
  const normalizedUserId = normalizeUserId(userId);
  const csrfToken = readXsrfToken(cookie);
  if (!normalizedUserId || !csrfToken) {
    return { status: "failed", reason: "csrf" };
  }

  const encodedUserId = encodeURIComponent(normalizedUserId);
  const primaryUrl = `${ZHIHU_ORIGIN}/api/v4/members/${encodedUserId}/actions/block`;
  const fallbackUrl = `${ZHIHU_ORIGIN}/api/v4/members/${encodedUserId}/block`;
  const init: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "x-xsrftoken": csrfToken,
    },
  };
  const wait = options.delay ?? defaultDelay;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (options.isStopped?.()) {
      return { status: "stopped" };
    }
    try {
      const primary = await fetchImpl(primaryUrl, init);
      if (primary.ok) {
        return { status: "success", endpoint: "primary" };
      }
      if (options.isStopped?.()) {
        return { status: "stopped" };
      }

      const fallback = await fetchImpl(fallbackUrl, init);
      if (fallback.ok) {
        return { status: "success", endpoint: "fallback" };
      }
      if (isAuthenticationStatus(primary.status) || isAuthenticationStatus(fallback.status)) {
        return { status: "failed", reason: "authentication" };
      }
      if (primary.status !== 429 && fallback.status !== 429) {
        return { status: "failed", reason: "http" };
      }
      if (attempt === MAX_RETRIES) {
        return { status: "failed", reason: "rate-limit" };
      }
    } catch (error) {
      if (!canRetryNetworkError(error, attempt)) {
        return { status: "failed", reason: "network" };
      }
    }
    await wait(retryDelay(attempt));
  }

  return { status: "failed", reason: "network" };
}
