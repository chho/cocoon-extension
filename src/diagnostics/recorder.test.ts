import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createDiagnosticRecorder } from "./recorder.ts";

test("Dev recorder retains real identity but bounds history by count and age", () => {
  let now = 1_000;
  const recorder = createDiagnosticRecorder({
    now: () => now,
    pageId: "page-test",
    nextId: () => "incident-test",
  });
  recorder.record({ kind: "submit", userId: "synthetic-author", authorName: "Synthetic Author" });
  strictEqual(recorder.snapshot().events[0]?.userId, "synthetic-author");
  for (let i = 0; i < 1_005; i++) recorder.record({ kind: "pointer", node: i });
  strictEqual(recorder.snapshot().events.length, 1_000);
  strictEqual(recorder.snapshot().truncated, 6);
  now += 300_001;
  strictEqual(recorder.snapshot().events.length, 0);
});

test("Dev recorder copies snapshots and bounds persisted fragments without losing latest events", () => {
  const recorder = createDiagnosticRecorder({
    now: () => 1_000,
    pageId: "page-test",
    nextId: () => "incident-test",
  });
  for (let i = 0; i < 1_000; i++)
    recorder.record({
      kind: "receipt",
      node: i,
      authorName: "x".repeat(200),
      userId: "x".repeat(200),
    });
  const incident = recorder.incident("manual");
  strictEqual(new TextEncoder().encode(JSON.stringify(incident)).length <= 131_072, true);
  strictEqual(incident.events.at(-1)?.node, 999);
  strictEqual(incident.truncated > 0, true);
  incident.events.length = 0;
  strictEqual(recorder.snapshot().events.length, 1_000);
});

test("Dev recorder rejects unrelated fields and invalid values instead of persisting them", () => {
  const recorder = createDiagnosticRecorder({
    now: () => 1_000,
    pageId: "page-test",
    nextId: () => "incident-test",
  });
  recorder.record({ kind: "pointer", x: Number.NaN });
  recorder.record({ kind: "submit", cookie: "synthetic-secret" } as never);
  deepStrictEqual(recorder.snapshot().events, []);
  strictEqual(recorder.snapshot().truncated, 2);
});
