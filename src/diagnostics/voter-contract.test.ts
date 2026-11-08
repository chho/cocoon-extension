import { strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import {
  parseDiagnosticIncident,
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_STORAGE_KEY,
  type DiagnosticIncident,
} from "./contract.ts";
import { createVoterSummary } from "./voter-summary.ts";
import { createDiagnosticStore } from "./storage.ts";

function incident(sequence = 1): DiagnosticIncident {
  return {
    schemaVersion: 1,
    pageId: "synthetic-page",
    id: "batch-1",
    savedAt: 1_000,
    reason: "voter-batch",
    sequence,
    truncated: 0,
    events: [{ at: 1_000, kind: "voter-summary", voter: createVoterSummary(1_000, 1) }],
  };
}

test("DIAG-004 batch incidents require a final strict summary and reject personal fields", () => {
  ok(parseDiagnosticIncident(incident()));
  for (const value of [
    { ...incident(), sequence: -1 },
    { ...incident(), events: [] },
    { ...incident(), events: [{ ...incident().events[0], userId: "synthetic-private" }] },
    { ...incident(), events: [{ at: 1_000, kind: "submit", userId: "synthetic-private" }] },
    {
      ...incident(),
      events: [
        {
          ...incident().events[0],
          voter: { ...createVoterSummary(1_000, 1), url: "https://example.test/private" },
        },
      ],
    },
  ])
    strictEqual(parseDiagnosticIncident(value), null);
});

test("DIAG-004 delayed older saves cannot replace newer checkpoints with equal timestamps", async () => {
  let values: Record<string, unknown> = {};
  const store = createDiagnosticStore({
    now: () => 1_000,
    storage: {
      async get() {
        return values;
      },
      async set(next) {
        values = next;
      },
      async remove(key) {
        delete values[key];
      },
    },
    locks: {
      async request(_name, _options, callback) {
        return callback();
      },
    },
  });
  const save = (sequence: number) =>
    store.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "save", incident: incident(sequence) });
  strictEqual(await save(1), true);
  strictEqual(await save(3), true);
  strictEqual(await save(2), true);
  const result = values[DIAGNOSTIC_STORAGE_KEY] as Array<{ sequence: number }>;
  strictEqual(result.length, 1);
  strictEqual(result[0]?.sequence, 3);
});
