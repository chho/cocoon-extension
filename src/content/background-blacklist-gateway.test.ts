import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState } from "./blacklist-state.ts";
import { createBackgroundBlacklistGateway } from "./background-blacklist-gateway.ts";
import { createBlacklistContentResponse } from "../core/blacklist-content-rpc-contract.ts";

test("AC-094 gateway strictly accepts an authoritative hydration", async () => {
  const messages: unknown[] = [];
  const state = createInitialState();
  const gateway = createBackgroundBlacklistGateway({
    async sendMessage(message) {
      messages.push(message);
      return createBlacklistContentResponse("hydrate", true, { state, revision: 3 });
    },
  });

  deepStrictEqual(await gateway.hydrate(), { state, revision: 3 });
  strictEqual(messages.length, 1);
});

test("AC-094 gateway rejects malformed, failed, and operation-mismatched responses", async () => {
  for (const response of [
    null,
    createBlacklistContentResponse("hydrate", false),
    createBlacklistContentResponse("delete-tag", true, {}),
    createBlacklistContentResponse("hydrate", true, {
      state: { schemaVersion: 5, tags: [], authors: [] },
      revision: 0,
    }),
  ]) {
    const gateway = createBackgroundBlacklistGateway({
      async sendMessage() {
        return response;
      },
    });
    await rejects(gateway.hydrate());
  }
});
