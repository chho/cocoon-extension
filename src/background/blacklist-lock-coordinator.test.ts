import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  BLACKLIST_LOCK_NAME,
  createBlacklistLockCoordinator,
} from "./blacklist-lock-coordinator.ts";

test("serializes blacklist work through the named exclusive Web Lock", async () => {
  const calls: unknown[] = [];
  const coordinator = createBlacklistLockCoordinator({
    async request(name, options, operation) {
      calls.push({ name, options });
      return operation();
    },
  });

  const result = await coordinator.runExclusive(async () => "completed");

  strictEqual(result, "completed");
  deepStrictEqual(calls, [{ name: BLACKLIST_LOCK_NAME, options: { mode: "exclusive" } }]);
});

test("propagates lock and operation failures without retrying", async () => {
  let calls = 0;
  const coordinator = createBlacklistLockCoordinator({
    async request(_name, _options, operation) {
      calls += 1;
      return operation();
    },
  });

  await rejects(
    coordinator.runExclusive(async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
  strictEqual(calls, 1);
});
