import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_PAGES_PER_VOTER_ORDER,
  MAX_UNIQUE_VOTERS,
  VOTER_PAGE_SIZE,
  blockZhihuUser,
  fetchCurrentZhihuUser,
  fetchZhihuBlockedUserIds,
  fetchZhihuVoters,
  readXsrfToken,
  validateAndNormalizeNextUrl,
  type RemoteFetch,
} from "./zhihu-remote-api.ts";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function voterPage(
  data: readonly unknown[],
  isEnd = true,
  next: string | null = null,
): unknown {
  return { data, paging: { is_end: isEnd, next } };
}

const noDelay = async (): Promise<void> => {};

test("REMOTE-002 reads only xsrf/_xsrf and prefers xsrf", () => {
  strictEqual(readXsrfToken("a=1; _xsrf=backup; xsrf=primary%20token"), "primary token");
  strictEqual(readXsrfToken("_xsrf=backup"), "backup");
  strictEqual(readXsrfToken("myxsrf=wrong; xsrf_extra=wrong"), null);
  strictEqual(readXsrfToken("xsrf=%E0%A4%A"), null);
});

test("VOTER-002 validates paging.next origin, path, content, and sorting", () => {
  const path = "/api/v4/answers/42/upvoters";
  const valid = validateAndNormalizeNextUrl(
    `${path}?order=default&limit=20&offset=20`,
    path,
    "default",
  );
  strictEqual(new URL(valid ?? "").searchParams.get("limit"), "50");
  strictEqual(
    validateAndNormalizeNextUrl(
      "https://example.com/api/v4/answers/42/upvoters?order=default",
      path,
      "default",
    ),
    null,
  );
  strictEqual(
    validateAndNormalizeNextUrl(
      "/api/v4/answers/43/upvoters?order=default",
      path,
      "default",
    ),
    null,
  );
  strictEqual(
    validateAndNormalizeNextUrl(
      `${path}?order=newest&offset=20`,
      path,
      "default",
    ),
    null,
  );
});

test("VOTER-002/003 fetches both answer sorts with limit 50 and deduplicates stable tokens", async () => {
  const urls: string[] = [];
  const progress: Array<{ fetched: number; unique: number; complete: boolean }> = [];
  const fetchImpl: RemoteFetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const order = new URL(url).searchParams.get("order");
    return response(
      voterPage(
        order === "default"
          ? [
              { url_token: "user-a", name: "User A" },
              { url_token: "shared", name: "Shared" },
              { name: "Missing token" },
            ]
          : [
              { url_token: "shared", name: "Shared renamed" },
              { url_token: "user-b", name: "User B" },
            ],
      ),
    );
  };

  const result = await fetchZhihuVoters(
    fetchImpl,
    { kind: "answer", questionId: "1", contentId: "42" },
    {
      delay: noDelay,
      onProgress(value) {
        progress.push(value);
      },
    },
  );

  strictEqual(result.complete, true);
  strictEqual(result.fetched, 5);
  strictEqual(result.invalid, 1);
  strictEqual(result.duplicates, 1);
  deepStrictEqual(
    result.users.map((user) => user.userId).sort(),
    ["shared", "user-a", "user-b"],
  );
  deepStrictEqual(progress.at(-1), {
    fetched: 5,
    unique: 3,
    complete: true,
  });
  strictEqual(urls.length, 2);
  strictEqual(
    urls.every((url) =>
      url.startsWith("https://www.zhihu.com/api/v4/answers/42/upvoters?") &&
      new URL(url).searchParams.get("limit") === "50"
    ),
    true,
  );
});

test("VOTER-002 uses article likers only and never the rejected voters endpoint", async () => {
  const urls: string[] = [];
  const result = await fetchZhihuVoters(
    async (input) => {
      urls.push(String(input));
      return response(voterPage([]));
    },
    { kind: "article", contentId: "123" },
    { delay: noDelay },
  );

  strictEqual(result.complete, true);
  strictEqual(urls.length, 2);
  strictEqual(urls.every((url) => url.includes("/articles/123/likers")), true);
  strictEqual(urls.some((url) => url.includes("/voters")), false);
});

test("VOTER-003 marks an invalid or off-contract next link partial", async () => {
  const result = await fetchZhihuVoters(
    async (input) => {
      const order = new URL(String(input)).searchParams.get("order");
      return order === "default"
        ? response(
            voterPage(
              [{ url_token: "partial-user", name: "Partial" }],
              false,
              "https://example.com/api/v4/answers/42/upvoters?order=default",
            ),
          )
        : response(voterPage([]));
    },
    { kind: "answer", questionId: "1", contentId: "42" },
    { delay: noDelay },
  );

  strictEqual(result.complete, false);
  strictEqual(result.requestFailures, 1);
  deepStrictEqual(result.users, [
    { userId: "partial-user", authorName: "Partial" },
  ]);
});

test("VOTER-003/009 marks one sorting candidate partial at its 100-page limit", async () => {
  const calls = new Map<string, number>();
  const result = await fetchZhihuVoters(
    async (input) => {
      const url = new URL(String(input));
      const order = url.searchParams.get("order") ?? "";
      const count = (calls.get(order) ?? 0) + 1;
      calls.set(order, count);
      if (order === "newest") {
        return response(voterPage([]));
      }
      return response(
        voterPage(
          [{ url_token: `default-${count}`, name: `Default ${count}` }],
          false,
          `/api/v4/answers/42/upvoters?order=default&offset=${count * VOTER_PAGE_SIZE}`,
        ),
      );
    },
    { kind: "answer", questionId: "1", contentId: "42" },
    { delay: noDelay },
  );

  strictEqual(calls.get("default"), MAX_PAGES_PER_VOTER_ORDER);
  strictEqual(calls.get("newest"), 1);
  strictEqual(result.fetched, MAX_PAGES_PER_VOTER_ORDER);
  strictEqual(result.users.length, MAX_PAGES_PER_VOTER_ORDER);
  strictEqual(result.complete, false);
  strictEqual(result.requestFailures, 0);
});

test("VOTER-003/009 stops paging at the total unique-voter safety limit", async () => {
  const calls = new Map<string, number>();
  const result = await fetchZhihuVoters(
    async (input) => {
      const url = new URL(String(input));
      const order = url.searchParams.get("order") ?? "";
      const page = (calls.get(order) ?? 0) + 1;
      calls.set(order, page);
      const data = Array.from({ length: VOTER_PAGE_SIZE }, (_, index) => ({
        url_token: `${order}-${page}-${index}`,
        name: `Voter ${order} ${page} ${index}`,
      }));
      return response(
        voterPage(
          data,
          false,
          `/api/v4/answers/42/upvoters?order=${order}&offset=${page * VOTER_PAGE_SIZE}`,
        ),
      );
    },
    { kind: "answer", questionId: "1", contentId: "42" },
    { delay: noDelay },
  );

  strictEqual(result.users.length, MAX_UNIQUE_VOTERS);
  strictEqual(result.fetched, MAX_UNIQUE_VOTERS);
  strictEqual(result.complete, false);
  strictEqual(result.requestFailures, 0);
  strictEqual(calls.get("default"), MAX_PAGES_PER_VOTER_ORDER);
  strictEqual(calls.get("newest"), MAX_PAGES_PER_VOTER_ORDER);
  strictEqual(
    [...calls.values()].every(
      (count) => count <= MAX_PAGES_PER_VOTER_ORDER,
    ),
    true,
  );
});

test("VOTER-009 retries 429 at most three times after the initial GET", async () => {
  const calls = new Map<string, number>();
  const result = await fetchZhihuVoters(
    async (input) => {
      const order = new URL(String(input)).searchParams.get("order") ?? "";
      const count = (calls.get(order) ?? 0) + 1;
      calls.set(order, count);
      if (order === "default" && count < 4) {
        return response({}, 429);
      }
      return response(voterPage([]));
    },
    { kind: "answer", questionId: "1", contentId: "42" },
    { delay: noDelay },
  );

  strictEqual(result.complete, true);
  strictEqual(calls.get("default"), 4);
  strictEqual(calls.get("newest"), 1);
});

test("VOTER-007 stops both candidates after continuous rate limiting", async () => {
  let calls = 0;
  const result = await fetchZhihuVoters(
    async () => {
      calls += 1;
      return response({}, 429);
    },
    { kind: "answer", questionId: "1", contentId: "42" },
    { delay: noDelay },
  );

  strictEqual(result.complete, false);
  strictEqual(result.fatalReason, "rate-limit");
  strictEqual(calls <= 8, true, "at most two already-running candidates retry four times");
});

test("VOTER-005 confirms current user and remote block-list tokens with strict JSON", async () => {
  const calls: string[] = [];
  const fetchImpl: RemoteFetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/v4/me")) {
      return response({ url_token: "current-user" });
    }
    return response({
      data: [{ url_token: "blocked-user" }, { url_token: 12 }],
      paging: { is_end: true, next: null },
    });
  };

  deepStrictEqual(await fetchCurrentZhihuUser(fetchImpl, { delay: noDelay }), {
    status: "success",
    userId: "current-user",
  });
  const blocked = await fetchZhihuBlockedUserIds(fetchImpl, { delay: noDelay });
  strictEqual(blocked.complete, true);
  deepStrictEqual([...blocked.userIds], ["blocked-user"]);
  strictEqual(calls.every((url) => url.startsWith("https://www.zhihu.com/")), true);
});

test("VOTER-005 fails closed when the current user response is not reliable", async () => {
  deepStrictEqual(
    await fetchCurrentZhihuUser(async () => response({ id: "not-a-token" }), {
      delay: noDelay,
    }),
    { status: "failed", reason: "invalid-response" },
  );
});

test("REMOTE-002 posts primary once with same-origin credentials and no Cookie header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await blockZhihuUser(
    async (input, init) => {
      calls.push({ url: String(input), init });
      return response({}, 204);
    },
    "user/name",
    "xsrf=secret",
    { delay: noDelay },
  );

  strictEqual(result.status, "failed", "invalid stable tokens are rejected before POST");
  strictEqual(calls.length, 0);

  const success = await blockZhihuUser(
    async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    },
    "stable-user",
    "xsrf=secret",
    { delay: noDelay },
  );
  deepStrictEqual(success, { status: "success", endpoint: "primary" });
  strictEqual(calls.length, 1);
  strictEqual(calls[0]?.url.endsWith("/stable-user/actions/block"), true);
  strictEqual(calls[0]?.init?.credentials, "same-origin");
  strictEqual(calls[0]?.init?.redirect, "error");
  const headers = new Headers(calls[0]?.init?.headers);
  strictEqual(headers.has("Cookie"), false);
  strictEqual(headers.get("x-xsrftoken"), "secret");
});

test("REMOTE-002 tries fallback only after an actual primary non-2xx", async () => {
  const calls: string[] = [];
  const result = await blockZhihuUser(
    async (input) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("/actions/block")
        ? response({}, 405)
        : new Response(null, { status: 204 });
    },
    "stable-user",
    "_xsrf=secret",
    { delay: noDelay },
  );

  deepStrictEqual(result, { status: "success", endpoint: "fallback" });
  strictEqual(calls.length, 2);
  strictEqual(calls[1]?.endsWith("/stable-user/block"), true);
});

test("REMOTE-002 stop after a deferred primary failure prevents fallback POST", async () => {
  let stopped = false;
  let calls = 0;
  let markPrimaryStarted: () => void = () => {};
  let resolvePrimary: (response: Response) => void = () => {};
  const primaryStarted = new Promise<void>((resolve) => {
    markPrimaryStarted = resolve;
  });
  const primaryResponse = new Promise<Response>((resolve) => {
    resolvePrimary = resolve;
  });

  const running = blockZhihuUser(
    async () => {
      calls += 1;
      if (calls === 1) {
        markPrimaryStarted();
        return primaryResponse;
      }
      return new Response(null, { status: 204 });
    },
    "stable-user",
    "xsrf=secret",
    { delay: noDelay, isStopped: () => stopped },
  );

  await primaryStarted;
  stopped = true;
  resolvePrimary(response({}, 405));

  deepStrictEqual(await running, { status: "stopped" });
  strictEqual(calls, 1);
});

test("REMOTE-005 retries transient primary network failures without trying fallback", async () => {
  const calls: string[] = [];
  const result = await blockZhihuUser(
    async (input) => {
      calls.push(String(input));
      if (calls.length < 4) {
        throw new TypeError("temporary network failure");
      }
      return new Response(null, { status: 204 });
    },
    "stable-user",
    "xsrf=secret",
    { delay: noDelay },
  );

  strictEqual(result.status, "success");
  strictEqual(calls.length, 4);
  strictEqual(calls.every((url) => url.endsWith("/actions/block")), true);
});

test("REMOTE-005 classifies missing CSRF and authentication without exposing response JSON", async () => {
  let calls = 0;
  deepStrictEqual(
    await blockZhihuUser(
      async () => {
        calls += 1;
        return response({ secret: "must not be read" });
      },
      "stable-user",
      "other=value",
      { delay: noDelay },
    ),
    { status: "failed", reason: "csrf" },
  );
  strictEqual(calls, 0);

  const auth = await blockZhihuUser(
    async (input) =>
      response({}, String(input).endsWith("/actions/block") ? 403 : 404),
    "stable-user",
    "xsrf=secret",
    { delay: noDelay },
  );
  deepStrictEqual(auth, { status: "failed", reason: "authentication" });
});
