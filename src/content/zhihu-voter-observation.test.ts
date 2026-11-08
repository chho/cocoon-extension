import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { VoterObserver, VoterPageObservation } from "./voter-observation.ts";
import {
  fetchZhihuVoters,
  MAX_PAGES_PER_VOTER_ORDER,
  VOTER_PAGE_SIZE,
  type RemoteFetch,
} from "./zhihu-remote-api.ts";

const source = { kind: "answer", questionId: "1", contentId: "42" } as const;
const path = "/api/v4/answers/42/upvoters";
const row = (id: string) => ({ url_token: id, name: `Name ${id}` });
const response = (data: unknown[] = [], isEnd = true, next: string | null = null) =>
  Response.json({ data, paging: { is_end: isEnd, next } });
const noDelay = async () => {};
function recorder() {
  const events: VoterPageObservation[] = [];
  const observer: VoterObserver = (event) => {
    if (event.kind === "page") events.push(event);
  };
  return { events, observer };
}

test("DIAG-004 invalid paging retains only a known raw count, not a fabricated zero", async () => {
  for (const known of [true, false]) {
    const { events, observer } = recorder();
    const result = await fetchZhihuVoters(
      async () =>
        Response.json({
          data: known ? Array.from({ length: 20 }, (_, i) => row(`synthetic-${i}`)) : null,
          paging: null,
        }),
      source,
      { observer },
    );
    strictEqual(result.fetched, 0);
    strictEqual(result.users.length, 0);
    strictEqual(result.complete, false);
    const rejected = events.filter((event) => event.stage === "end");
    strictEqual(rejected.length, 2);
    for (const event of rejected) {
      strictEqual(event.reason, "invalid-response");
      strictEqual(event.rows, known ? 20 : undefined);
    }
    strictEqual(JSON.stringify(events).includes("synthetic-"), false);
  }
});

test("DIAG-004 accounts for multiple pages and cross-order duplicates without identities", async () => {
  const { events, observer } = recorder();
  const result = await fetchZhihuVoters(
    async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("order") === "newest") return response([row("shared")]);
      if (url.searchParams.get("offset") !== "0") return response([row("shared"), row("second")]);
      return response([row("first"), {}, row("shared")], false, `${path}?order=default&offset=50`);
    },
    source,
    { observer, delay: noDelay, now: () => 10 },
  );
  strictEqual(result.complete, true);
  const ends = events.filter((event) => event.stage === "end");
  strictEqual(ends.length, 3);
  strictEqual(
    ends.reduce((sum, event) => sum + (event.rows ?? 0), 0),
    6,
  );
  strictEqual(
    ends.reduce((sum, event) => sum + (event.invalid ?? 0), 0),
    1,
  );
  strictEqual(
    ends.reduce((sum, event) => sum + (event.duplicates ?? 0), 0),
    2,
  );
  strictEqual(
    ends.reduce((sum, event) => sum + (event.added ?? 0), 0),
    3,
  );
  strictEqual(ends.at(-1)?.unique, 3);
  deepStrictEqual(
    ends
      .filter((event) => event.order === "default")
      .map((event) => [event.page, event.reason, event.isEnd, event.hasNext]),
    [
      [1, "next", false, true],
      [2, "end", true, false],
    ],
  );
  strictEqual(events.filter((event) => event.stage === "start").length, 3);
  strictEqual(events.filter((event) => event.stage === "attempt").length, 3);
  ok(
    events
      .filter((event) => event.stage === "attempt")
      .every((event) => event.attempt === 1 && event.status === 200 && event.durationMs === 0),
  );
  const allowed = new Set([
    "kind",
    "order",
    "page",
    "stage",
    "attempt",
    "durationMs",
    "status",
    "reason",
    "rows",
    "invalid",
    "duplicates",
    "added",
    "unique",
    "isEnd",
    "hasNext",
  ]);
  ok(events.every((event) => Object.keys(event).every((key) => allowed.has(key))));
  ok(!/shared|Name|https|upvoters/.test(JSON.stringify(events)));
});

for (const reason of ["invalid-next", "invalid-response", "repeated-next"] as const) {
  test(`DIAG-004 observes ${reason} without changing partial results`, async () => {
    const { events, observer } = recorder();
    let calls = 0;
    const result = await fetchZhihuVoters(
      async (input) => {
        calls += 1;
        const url = new URL(String(input));
        if (url.searchParams.get("order") === "newest") return response();
        if (reason === "invalid-response") return Response.json({ data: [], paging: null });
        return response(
          [row("one")],
          false,
          reason === "repeated-next" ? String(input) : "https://example.com/private",
        );
      },
      source,
      { observer, delay: noDelay },
    );
    strictEqual(calls, 2);
    strictEqual(result.complete, false);
    strictEqual(result.requestFailures, 1);
    ok(events.some((event) => event.stage === "end" && event.reason === reason));
  });
}

for (const scenario of ["authentication", "rate-limit", "network", "http", "recover"] as const) {
  test(`DIAG-004 observes ${scenario} attempts and throwing diagnostics preserve behavior`, async () => {
    async function run(mode: "none" | "record" | "throw" | "clock") {
      const { events, observer } = recorder();
      const calls: string[] = [];
      const waits: number[] = [];
      const attempts = new Map<string, number>();
      let tick = 0;
      const fetchImpl: RemoteFetch = async (input) => {
        const order = new URL(String(input)).searchParams.get("order") ?? "";
        calls.push(String(input));
        const attempt = (attempts.get(order) ?? 0) + 1;
        attempts.set(order, attempt);
        if (scenario === "network" || (scenario === "recover" && attempt === 1))
          throw new TypeError("secret error");
        if (scenario === "recover" && attempt > 2) return response([row(order)]);
        return new Response(null, {
          status: scenario === "authentication" ? 403 : scenario === "http" ? 500 : 429,
        });
      };
      const result = await fetchZhihuVoters(fetchImpl, source, {
        delay: async (ms) => {
          waits.push(ms);
        },
        observer:
          mode === "none"
            ? undefined
            : mode === "throw"
              ? () => {
                  throw new Error("secret observer");
                }
              : observer,
        now: () => {
          if (mode === "clock") throw new Error("secret clock");
          return tick++;
        },
      });
      return { events, calls, waits, result };
    }
    const baseline = await run("none");
    for (const mode of ["record", "throw", "clock"] as const) {
      const actual = await run(mode);
      deepStrictEqual(actual.result, baseline.result);
      deepStrictEqual(actual.calls, baseline.calls);
      deepStrictEqual(actual.waits, baseline.waits);
      if (mode === "throw") continue;
      const attempts = actual.events.filter((event) => event.stage === "attempt");
      strictEqual(attempts.length, actual.calls.length);
      ok(
        attempts.every((event) =>
          mode === "clock" ? event.durationMs === undefined : Number.isFinite(event.durationMs),
        ),
      );
      ok(
        attempts.some((event) => event.reason === (scenario === "recover" ? "network" : scenario)),
      );
      ok(!JSON.stringify(actual.events).includes("secret"));
    }
  });
}

test("DIAG-004 observes explicit stop without requesting a page", async () => {
  const { events, observer } = recorder();
  const result = await fetchZhihuVoters(
    async () => {
      throw new Error("must not request");
    },
    source,
    { observer, isStopped: () => true },
  );
  strictEqual(result.complete, false);
  strictEqual(events.filter((event) => event.stage === "attempt").length, 0);
  deepStrictEqual(
    events.filter((event) => event.stage === "end").map((event) => event.reason),
    ["stopped", "stopped"],
  );
});

for (const fullPages of [false, true]) {
  test(`DIAG-004 records ${fullPages ? "user" : "page"} safety cap`, async () => {
    const { events, observer } = recorder();
    const result = await fetchZhihuVoters(
      async (input) => {
        const url = new URL(String(input));
        const order = url.searchParams.get("order");
        const offset = Number(url.searchParams.get("offset"));
        return response(
          Array.from({ length: fullPages ? VOTER_PAGE_SIZE : 1 }, (_, index) =>
            row(`${order}-${offset}-${index}`),
          ),
          false,
          `${path}?order=${order}&offset=${offset + VOTER_PAGE_SIZE}`,
        );
      },
      source,
      { observer, delay: noDelay },
    );
    strictEqual(result.complete, false);
    strictEqual(result.requestFailures, 0);
    strictEqual(
      events.filter((event) => event.stage === "attempt").length,
      MAX_PAGES_PER_VOTER_ORDER * 2,
    );
    ok(
      events.some(
        (event) =>
          event.stage === "end" && event.reason === (fullPages ? "user-limit" : "page-limit"),
      ),
    );
  });
}
