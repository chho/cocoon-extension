import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import type {
  BadgeController,
  BadgeMessageSender,
} from "./badge-controller.ts";
import { createBadgeRuntimeMessageListener } from "./listeners.ts";

const VALID_MESSAGE = {
  version: 1,
  type: "cocoon.badge.increment",
  generation: "listener_generation_123",
  delta: 1,
} as const;
const MAIN_FRAME_SENDER = { tab: { id: 9 }, frameId: 0 } as const;

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function controllerWithHandler(
  handler: (
    message: unknown,
    sender: BadgeMessageSender,
  ) => Promise<BadgeMessageResponse>,
): Pick<BadgeController, "handleMessage"> {
  return { handleMessage: handler };
}

test("BADGE-006 unknown and invalid messages remain unclaimed for future listeners", async () => {
  let calls = 0;
  let responses = 0;
  let failures = 0;
  const listener = createBadgeRuntimeMessageListener(
    controllerWithHandler(async () => {
      calls += 1;
      return { ok: true };
    }),
    () => {
      failures += 1;
    },
  );

  for (const message of [
    { type: "future.listener.message" },
    { ...VALID_MESSAGE, extra: true },
  ]) {
    strictEqual(
      listener(message, MAIN_FRAME_SENDER, () => {
        responses += 1;
      }),
      false,
    );
  }
  strictEqual(
    listener(VALID_MESSAGE, { tab: { id: 9 }, frameId: 1 }, () => {
      responses += 1;
    }),
    false,
  );
  await settle();
  strictEqual(calls, 0);
  strictEqual(responses, 0);
  strictEqual(failures, 0);
});

test("BADGE-006 valid messages synchronously keep the async response channel open", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responses: unknown[] = [];
  const listener = createBadgeRuntimeMessageListener(
    controllerWithHandler(async () => {
      await gate;
      return { ok: true };
    }),
    () => {
      throw new Error("successful messages must not report failure");
    },
  );

  strictEqual(
    listener(VALID_MESSAGE, MAIN_FRAME_SENDER, (response) => {
      responses.push(response);
    }),
    true,
  );
  strictEqual(responses.length, 0);
  release?.();
  await settle();
  deepStrictEqual(responses, [{ ok: true }]);
});

test("BADGE-006 stale results, controller errors, and closed channels fail safely once", async () => {
  for (const scenario of ["stale", "throw", "closed-channel"] as const) {
    let failures = 0;
    const responses: unknown[] = [];
    const listener = createBadgeRuntimeMessageListener(
      controllerWithHandler(async () => {
        if (scenario === "throw") {
          throw new Error("controller failed");
        }
        return scenario === "stale" ? { ok: false } : { ok: true };
      }),
      () => {
        failures += 1;
      },
    );

    strictEqual(
      listener(VALID_MESSAGE, MAIN_FRAME_SENDER, (response) => {
        if (scenario === "closed-channel") {
          throw new Error("response channel closed");
        }
        responses.push(response);
      }),
      true,
      scenario,
    );
    await settle();

    strictEqual(failures, 1, scenario);
    if (scenario !== "closed-channel") {
      deepStrictEqual(responses, [
        scenario === "stale" ? { ok: false } : { ok: false },
      ]);
    }
  }
});
