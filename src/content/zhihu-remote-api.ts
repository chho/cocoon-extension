import type { ZhihuContentSource } from "./zhihu-content-source.ts";

const ZHIHU_ORIGIN = "https://www.zhihu.com";
export const VOTER_PAGE_SIZE = 50;
export const MAX_PAGES_PER_VOTER_ORDER = 100;
export const MAX_UNIQUE_VOTERS =
  VOTER_PAGE_SIZE * MAX_PAGES_PER_VOTER_ORDER * 2;
const MAX_RETRIES = 3;
const MAX_RELATION_PAGES = 100;

export type RemoteFetch = typeof fetch;
export type Delay = (milliseconds: number) => Promise<void>;

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
      readonly reason:
        | FatalRemoteReason
        | "network"
        | "http"
        | "invalid-response";
    };

export type RemoteBlockResult =
  | { readonly status: "success"; readonly endpoint: "primary" | "fallback" }
  | { readonly status: "stopped" }
  | {
      readonly status: "failed";
      readonly reason:
        | FatalRemoteReason
        | "csrf"
        | "network"
        | "http";
    };

interface RetryOptions {
  readonly isStopped?: () => boolean;
  readonly delay?: Delay;
}

type RetriedFetchResult =
  | { readonly status: "response"; readonly response: Response }
  | { readonly status: "stopped" }
  | { readonly status: "network-failure" }
  | { readonly status: "rate-limit" };

interface ParsedPage<T> {
  readonly data: readonly T[];
  readonly isEnd: boolean;
  readonly next: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAuthenticationStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
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

async function fetchWithRetry(
  fetchImpl: RemoteFetch,
  input: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<RetriedFetchResult> {
  const wait = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (options.isStopped?.()) {
      return { status: "stopped" };
    }
    try {
      const response = await fetchImpl(input, init);
      if (response.status !== 429) {
        return { status: "response", response };
      }
      if (attempt === MAX_RETRIES) {
        return { status: "rate-limit" };
      }
    } catch (error) {
      if (!isTransientNetworkError(error) || attempt === MAX_RETRIES) {
        return { status: "network-failure" };
      }
    }
    await wait(retryDelay(attempt));
  }
  return { status: "network-failure" };
}

function parsePaging(value: unknown): { isEnd: boolean; next: string | null } | null {
  if (!isRecord(value) || typeof value.is_end !== "boolean") {
    return null;
  }
  if (value.next !== null && value.next !== undefined && typeof value.next !== "string") {
    return null;
  }
  const next = typeof value.next === "string" && value.next.length > 0
    ? value.next
    : null;
  if (!value.is_end && next === null) {
    return null;
  }
  return { isEnd: value.is_end, next };
}

function parseVoterPage(value: unknown): ParsedPage<unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > VOTER_PAGE_SIZE) {
    return null;
  }
  const paging = parsePaging(value.paging);
  return paging ? { data: value.data, ...paging } : null;
}

function parseBlockedUsersPage(value: unknown): ParsedPage<unknown> | null {
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

function createVoterPageUrl(
  source: ZhihuContentSource,
  order: "default" | "newest",
): string {
  const url = new URL(voterPath(source), ZHIHU_ORIGIN);
  url.searchParams.set("order", order);
  url.searchParams.set("limit", String(VOTER_PAGE_SIZE));
  url.searchParams.set("offset", "0");
  return url.toString();
}

export function validateAndNormalizeNextUrl(
  next: string,
  expectedPath: string,
  expectedOrder: "default" | "newest" | null,
): string | null {
  try {
    const url = new URL(next, `${ZHIHU_ORIGIN}/`);
    if (url.origin !== ZHIHU_ORIGIN || url.pathname !== expectedPath) {
      return null;
    }
    if (
      expectedOrder !== null &&
      url.searchParams.get("order") !== expectedOrder
    ) {
      return null;
    }
    url.searchParams.set("limit", String(VOTER_PAGE_SIZE));
    return url.toString();
  } catch {
    return null;
  }
}

function getJsonRequestInit(): RequestInit {
  return {
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
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
  return userId
    ? { status: "success", userId }
    : { status: "failed", reason: "invalid-response" };
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
    const result = await fetchWithRetry(
      fetchImpl,
      nextUrl,
      getJsonRequestInit(),
      options,
    );
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
    const parsed = parseBlockedUsersPage(await readJson(result.response));
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
      nextUrl = parsed.next
        ? validateAndNormalizeNextUrl(parsed.next, path, null)
        : null;
    }
  }

  return { userIds, complete, fatalReason: null };
}

export async function fetchZhihuVoters(
  fetchImpl: RemoteFetch,
  source: ZhihuContentSource,
  options: RetryOptions & {
    readonly onProgress?: (progress: VoterFetchProgress) => void;
  } = {},
): Promise<VoterFetchResult> {
  const users = new Map<string, ZhihuVoter>();
  const path = voterPath(source);
  let fetched = 0;
  let invalid = 0;
  let duplicates = 0;
  let requestFailures = 0;
  let fatalReason: FatalRemoteReason | null = null;
  let safetyLimitReached = false;

  async function fetchOrder(order: "default" | "newest"): Promise<boolean> {
    let nextUrl: string | null = createVoterPageUrl(source, order);
    const visited = new Set<string>();
    for (
      let page = 0;
      page < MAX_PAGES_PER_VOTER_ORDER && nextUrl;
      page += 1
    ) {
      if (options.isStopped?.() || fatalReason !== null || safetyLimitReached) {
        return false;
      }
      if (visited.has(nextUrl)) {
        requestFailures += 1;
        return false;
      }
      visited.add(nextUrl);
      const result = await fetchWithRetry(
        fetchImpl,
        nextUrl,
        getJsonRequestInit(),
        {
          delay: options.delay,
          isStopped: () =>
            options.isStopped?.() === true || fatalReason !== null,
        },
      );
      if (result.status === "rate-limit") {
        fatalReason = "rate-limit";
        return false;
      }
      if (safetyLimitReached) {
        return false;
      }
      if (result.status !== "response") {
        if (result.status !== "stopped") {
          requestFailures += 1;
        }
        return false;
      }
      if (isAuthenticationStatus(result.response.status)) {
        fatalReason = "authentication";
        return false;
      }
      if (!result.response.ok) {
        requestFailures += 1;
        return false;
      }
      const parsed = parseVoterPage(await readJson(result.response));
      if (!parsed) {
        requestFailures += 1;
        return false;
      }
      for (const item of parsed.data) {
        fetched += 1;
        const voter = parseVoter(item);
        if (!voter) {
          invalid += 1;
          continue;
        }
        if (users.has(voter.userId)) {
          duplicates += 1;
          continue;
        }
        users.set(voter.userId, voter);
        if (users.size >= MAX_UNIQUE_VOTERS) {
          safetyLimitReached = true;
          break;
        }
      }
      options.onProgress?.({ fetched, unique: users.size, complete: false });
      if (parsed.isEnd) {
        return true;
      }
      const validatedNext = parsed.next
        ? validateAndNormalizeNextUrl(parsed.next, path, order)
        : null;
      if (!validatedNext) {
        requestFailures += 1;
        return false;
      }
      nextUrl = validatedNext;
    }
    return false;
  }

  const completedOrders = await Promise.all([
    fetchOrder("default"),
    fetchOrder("newest"),
  ]);
  const complete =
    completedOrders.every(Boolean) &&
    fatalReason === null &&
    !safetyLimitReached &&
    options.isStopped?.() !== true;
  options.onProgress?.({ fetched, unique: users.size, complete });
  return {
    users: [...users.values()],
    fetched,
    invalid,
    duplicates,
    complete,
    fatalReason,
    requestFailures,
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
      if (
        isAuthenticationStatus(primary.status) ||
        isAuthenticationStatus(fallback.status)
      ) {
        return { status: "failed", reason: "authentication" };
      }
      if (primary.status !== 429 && fallback.status !== 429) {
        return { status: "failed", reason: "http" };
      }
      if (attempt === MAX_RETRIES) {
        return { status: "failed", reason: "rate-limit" };
      }
    } catch (error) {
      if (!isTransientNetworkError(error) || attempt === MAX_RETRIES) {
        return { status: "failed", reason: "network" };
      }
    }
    await wait(retryDelay(attempt));
  }

  return { status: "failed", reason: "network" };
}
