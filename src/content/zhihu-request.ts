import { observeVoters as safeObserve, type VoterObserver } from "./voter-observation.ts";

export const MAX_RETRIES = 3;
export type RemoteFetch = typeof fetch;
export type Delay = (milliseconds: number) => Promise<void>;

export interface RetryOptions {
  readonly isStopped?: () => boolean;
  readonly delay?: Delay;
}

export interface PageObserver {
  readonly observer?: VoterObserver;
  readonly now?: () => number;
  readonly order: "default" | "newest";
  readonly page: number;
}

function observationTime(observation: PageObserver | undefined): number | undefined {
  if (!observation?.observer) return undefined;
  try {
    const value = observation.now ? observation.now() : performance.now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function observeAttempt(
  observation: PageObserver | undefined,
  start: number | undefined,
  attempt: number,
  response?: Response,
): void {
  if (!observation?.observer) return;
  const end = observationTime(observation);
  const durationMs =
    start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
  const reason = response ? (responseReason(response) ?? "response") : "network";
  safeObserve(observation.observer, {
    kind: "page",
    order: observation.order,
    page: observation.page,
    stage: "attempt",
    attempt: attempt + 1,
    reason,
    ...(response ? { status: response.status } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
  });
}

export function responseReason(
  response: Response,
): "authentication" | "rate-limit" | "http" | null {
  if (response.status === 429) return "rate-limit";
  if (isAuthenticationStatus(response.status)) return "authentication";
  return response.ok ? null : "http";
}

export type RetriedFetchResult =
  | { readonly status: "response"; readonly response: Response }
  | { readonly status: "stopped" }
  | { readonly status: "network-failure" }
  | { readonly status: "rate-limit" };

export function isAuthenticationStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}

export function canRetryNetworkError(error: unknown, attempt: number): boolean {
  return error instanceof TypeError && attempt < MAX_RETRIES;
}

export async function fetchWithRetry(
  fetchImpl: RemoteFetch,
  input: string,
  init: RequestInit,
  options: RetryOptions & { readonly observation?: PageObserver } = {},
): Promise<RetriedFetchResult> {
  const wait = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (options.isStopped?.()) {
      return { status: "stopped" };
    }
    const start = observationTime(options.observation);
    try {
      const response = await fetchImpl(input, init);
      observeAttempt(options.observation, start, attempt, response);
      if (response.status !== 429) {
        return { status: "response", response };
      }
      if (attempt === MAX_RETRIES) {
        return { status: "rate-limit" };
      }
    } catch (error) {
      observeAttempt(options.observation, start, attempt);
      if (!canRetryNetworkError(error, attempt)) {
        return { status: "network-failure" };
      }
    }
    await wait(retryDelay(attempt));
  }
  return { status: "network-failure" };
}

export function getJsonRequestInit(): RequestInit {
  return {
    credentials: "same-origin",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  };
}

export async function readJson(response: Response): Promise<unknown | null> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
