import { strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createZhihuVoterBatch } from "./voter-runtime.ts";
import { createVoterDiagnostics } from "../../diagnostics/voter-session.ts";
import { createDiagnosticStore } from "../../diagnostics/storage.ts";
import { DIAGNOSTIC_STORAGE_KEY, type DiagnosticIncident } from "../../diagnostics/contract.ts";
import { parseVoterSummary } from "../../diagnostics/voter-summary.ts";

function storageHarness() {
  let stored: Record<string, unknown> = {};
  const store = createDiagnosticStore({
    now: () => 1_000,
    storage: {
      async get() {
        return stored;
      },
      async set(next) {
        stored = next;
      },
      async remove(key) {
        delete stored[key];
      },
    },
    locks: {
      async request(_name, _options, callback) {
        return callback();
      },
    },
  });
  return { store, read: () => stored[DIAGNOSTIC_STORAGE_KEY] as DiagnosticIncident[] };
}

for (const partial of [false, true]) {
  test(`DIAG-004 production voter wiring explains twenty new records (partial=${partial})`, async () => {
    const storage = storageHarness();
    const diagnostics = createVoterDiagnostics({
      pageId: "synthetic-page",
      now: () => 1_000,
      nextId: () => "batch-1",
      schedule: () => () => {},
      request: (request) => storage.store.handle(request),
    });
    let gets = 0;
    const controller = createZhihuVoterBatch(
      {
        async block(request) {
          const index = Number(request.userId.slice("synthetic-".length));
          return index < 20
            ? { status: "success", persistedUpvoter: true }
            : { status: "skipped", reason: "existing" };
        },
      },
      async (input, init) => {
        strictEqual(init?.method ?? "GET", "GET");
        gets++;
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/api/v4/me") return Response.json({ url_token: "self" });
        const offset = Number(url.searchParams.get("offset"));
        if (partial && offset > 0) return new Response(null, { status: 500 });
        const size = partial ? 20 : Math.min(50, 120 - offset);
        const next = new URL(url);
        next.searchParams.set("offset", String(offset + size));
        return Response.json({
          data: Array.from({ length: size }, (_, i) => ({
            url_token: `synthetic-${offset + i}`,
            name: "Synthetic",
          })),
          paging: { is_end: !partial && offset + size === 120, next: next.href },
        });
      },
      diagnostics.start(1),
    );
    const result = await controller.run({
      source: { kind: "article", contentId: "1" },
      tagId: "default",
      directAuthorUserId: "direct",
      sourcePostId: null,
      isStopped: () => false,
    });
    await setImmediate();
    strictEqual(result.success, 20);
    strictEqual(result.dataComplete, !partial);
    strictEqual(gets, partial ? 5 : 7);
    const incidents = storage.read();
    strictEqual(incidents.length, 1);
    const summary = parseVoterSummary(incidents[0]!.events.at(-1)?.voter);
    ok(summary);
    strictEqual(summary.success, 20);
    strictEqual(summary.unique, partial ? 20 : 120);
    strictEqual(summary.existing, partial ? 0 : 100);
    strictEqual(summary.duplicates, partial ? 20 : 120);
    strictEqual(summary.outcome, partial ? "partial" : "complete");
    strictEqual(summary.requestFailures, partial ? 2 : 0);
    strictEqual(JSON.stringify(incidents).includes("synthetic-0"), false);
    diagnostics.clear();
  });
}
