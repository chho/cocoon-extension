import { strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { parseVoterSummary } from "./voter-summary.ts";
import type { DiagnosticRequest } from "./contract.ts";
import { createVoterDiagnostics } from "./voter-session.ts";

function fixture() {
  let time = 1_000,
    nextId = 0;
  const timers = new Set<() => void>();
  const saved: DiagnosticRequest[] = [];
  const session = createVoterDiagnostics({
    pageId: "synthetic-page",
    now: () => time,
    nextId: () => `batch-${++nextId}`,
    schedule(callback) {
      timers.add(callback);
      return () => timers.delete(callback);
    },
    async request(request) {
      saved.push(request);
      return true;
    },
  });
  return {
    session,
    saved,
    timers,
    async tick() {
      time += 5_000;
      for (const callback of [...timers]) {
        timers.delete(callback);
        callback();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("DIAG-004 late worker receipts after an exception stay coalesced and flush best-effort on departure", async () => {
  const f = fixture();
  const observe = f.session.start(1);
  observe({ kind: "exception", stage: "persisting" });
  await setImmediate();
  const saves = f.saved.length;
  for (let i = 0; i < 20; i++) {
    observe({ kind: "dispatch" });
    observe({ kind: "result", status: "success" });
    await setImmediate();
  }
  strictEqual(f.saved.length, saves);
  strictEqual(f.timers.size, 1);
  f.session.pause();
  await setImmediate();
  strictEqual(f.saved.length, saves + 1);
  strictEqual(f.timers.size, 0);
  const last = f.saved.at(-1)!;
  ok(last.operation === "save");
  const summary = parseVoterSummary(last.incident.events.at(-1)?.voter);
  ok(summary);
  strictEqual(summary.success, 20);
  strictEqual(summary.outcome, "exception");
});

test("DIAG-004 automatically saves one bounded batch with coalesced checkpoints and a final summary", async () => {
  const f = fixture();
  const observe = f.session.start(7);
  await Promise.resolve();
  for (let index = 0; index < 100; index++) observe({ kind: "dispatch" });
  strictEqual(f.saved.length, 1, "per-user progress must not write storage");
  strictEqual(f.timers.size, 1);
  await f.tick();
  observe({ kind: "finish", phase: "complete", dataComplete: false });
  await Promise.resolve();
  await Promise.resolve();
  const snapshot = f.session.snapshot();
  strictEqual(snapshot.batches.length, 1);
  const incident = snapshot.batches[0]!.incident;
  strictEqual(incident.reason, "voter-batch");
  strictEqual(incident.events.at(-1)?.kind, "voter-summary");
  const ids = f.saved.flatMap((r) => (r.operation === "save" ? [r.incident.id] : []));
  strictEqual(new Set(ids).size, 1);
  ok(snapshot.batches[0]!.analysis.length > 0);
  strictEqual(f.timers.size, 0);
});

test("DIAG-004 pagehide records uncertainty, cancels timers and ignores old callbacks after restore", async () => {
  const f = fixture();
  const observe = f.session.start(null);
  observe({ kind: "dispatch" });
  f.session.pause();
  strictEqual(f.timers.size, 0);
  const before = JSON.stringify(f.session.snapshot());
  observe({ kind: "result", status: "success" });
  f.session.resume();
  observe({ kind: "finish", phase: "complete", dataComplete: true });
  // A page resuming is not proof its old task resumed.
  strictEqual(JSON.stringify(f.session.snapshot()), before);
  await f.tick();
});

test("DIAG-004 retains only three batches and preserves totals after page trace truncation", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.session.start(i);
  const observe = f.session.start(9);
  observe({ kind: "result", status: "success" });
  for (let i = 0; i < 1_100; i++)
    observe({ kind: "page", order: "default", page: 1, stage: "attempt", attempt: 1 });
  const snapshot = f.session.snapshot();
  strictEqual(snapshot.batches.length, 3);
  strictEqual(snapshot.dropped, 2);
  const incident = snapshot.batches.at(-1)!.incident;
  ok(incident.truncated > 0);
  ok(incident.events.length <= 1_000);
  strictEqual(incident.events.at(-1)?.kind, "voter-summary");
  f.session.clear();
  strictEqual(f.session.snapshot().batches.length, 0);
  strictEqual(f.timers.size, 0);
});

test("DIAG-004 request rejection is contained without rejecting an observer", async () => {
  const session = createVoterDiagnostics({
    pageId: "synthetic",
    now: () => 1_000,
    nextId: () => "batch",
    schedule: () => () => {},
    async request() {
      throw new Error("private error excluded");
    },
  });
  const observe = session.start(null);
  observe({ kind: "finish", phase: "complete", dataComplete: true });
  await Promise.resolve();
  await Promise.resolve();
  strictEqual(JSON.stringify(session.snapshot()).includes("private error"), false);
  session.clear();
});
