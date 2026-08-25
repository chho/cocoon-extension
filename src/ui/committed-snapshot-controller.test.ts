import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createCommittedSnapshotController } from "./committed-snapshot-controller.ts";

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("AC-095 reconciles after a revision observed during a pending mutation", async () => {
  const applied: string[] = [];
  let resolveReconciliation: (snapshot: string | null) => void = () => {};
  const reconciliation = new Promise<string | null>((resolve) => {
    resolveReconciliation = resolve;
  });
  let invalidations = 0;
  const controller = createCommittedSnapshotController<string>(
    (snapshot) => applied.push(snapshot),
    async () => reconciliation,
  );
  const commit = controller.beginMutation();

  controller.noteRevision();
  controller.applyRefresh("possibly-stale-refresh");
  commit("committed-response", () => {
    invalidations += 1;
  });
  resolveReconciliation("newer-authority");
  await settle();

  deepStrictEqual(applied, ["possibly-stale-refresh", "committed-response", "newer-authority"]);
  strictEqual(invalidations, 1);
});

test("AC-095 keeps a committed snapshot when reconciliation fails", async () => {
  const applied: string[] = [];
  let reconciliationCalls = 0;
  const controller = createCommittedSnapshotController<string>(
    (snapshot) => applied.push(snapshot),
    async () => {
      reconciliationCalls += 1;
      throw new Error("unreadable");
    },
  );

  const withRevision = controller.beginMutation();
  controller.noteRevision();
  withRevision("committed", () => {});
  await settle();

  const withoutRevision = controller.beginMutation();
  withoutRevision("next-commit", () => {});
  await settle();
  deepStrictEqual(applied, ["committed", "next-commit"]);
  strictEqual(reconciliationCalls, 1);
});
