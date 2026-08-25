import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState, type BlacklistState } from "./blacklist-state.ts";
import { createBackgroundBlacklistClient } from "./background-blacklist-client.ts";

test("AC-095 client initialization preserves the sync controller receiver", async () => {
  const state = createInitialState();
  let hydrations = 0;
  let appliedState: BlacklistState | null = null;
  const client = createBackgroundBlacklistClient({
    gateway: {
      async hydrate() {
        hydrations += 1;
        return { state, revision: 3 };
      },
      async commitAuthor() {
        throw new Error("Unexpected commitAuthor call.");
      },
      async backfillMemberHash() {
        throw new Error("Unexpected backfillMemberHash call.");
      },
      async commitUpvoter() {
        throw new Error("Unexpected commitUpvoter call.");
      },
      async preflightDirect() {
        throw new Error("Unexpected preflightDirect call.");
      },
      async deleteTag() {
        throw new Error("Unexpected deleteTag call.");
      },
    },
    applyState(nextState) {
      appliedState = nextState;
    },
    reportSyncFailure() {
      throw new Error("Unexpected sync failure.");
    },
  });

  await client.initialize();

  strictEqual(hydrations, 1);
  deepStrictEqual(appliedState, state);
});
