import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import {
  createBlacklistRpcResponse,
  parseBlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import type {
  BadgeController,
  BadgeMessageSender,
} from "./badge-controller.ts";
import {
  createBadgeRuntimeMessageListener,
  createBlacklistRuntimeMessageListener,
  isAuthorizedUiSender,
} from "./listeners.ts";

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

test("POPUP-009 authorizes only exact built-in UI page senders", () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  for (const [path, tab] of [
    ["popup/popup.html", undefined],
    ["popup/popup.html", { id: 1 }],
    ["options/options.html", undefined],
    ["options/options.html", { id: 2 }],
  ] as const) {
    strictEqual(isAuthorizedUiSender({
      id: runtimeId,
      url: `chrome-extension://${runtimeId}/${path}`,
      ...(tab ? { tab } : {}),
    }, runtimeId), true);
  }
  for (const sender of [
    {},
    { id: "other", url: `chrome-extension://${runtimeId}/popup/popup.html` },
    { id: runtimeId, url: `https://${runtimeId}/popup/popup.html` },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/popup/popup.html?x=1` },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/popup/popup.html#x` },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/other.html` },
    {
      id: runtimeId,
      url: "https://www.zhihu.com/",
      tab: { id: 1 },
    },
  ]) {
    strictEqual(isAuthorizedUiSender(sender, runtimeId), false);
  }
});

test("POPUP-009 malformed and unknown RPC messages remain unclaimed", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  let calls = 0;
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        calls += 1;
        return createBlacklistRpcResponse("snapshot", true, {
          snapshot: {
            authors: [],
            tags: [{ tagId: "default", name: "default", isDefault: true }],
          },
        });
      },
    },
    runtimeId,
    () => {},
  );
  const sender = {
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/popup/popup.html`,
  };
  for (const message of [
    { type: "future" },
    { version: 1, type: "cocoon.blacklist.request", operation: "snapshot", input: {}, extra: true },
    { version: 1, type: "cocoon.blacklist.request", operation: "restore-one", input: { author: { userId: "id" } } },
  ]) {
    strictEqual(listener(message, sender, () => {}), false);
  }
  await settle();
  strictEqual(calls, 0);
});

test("BUG-013/AC-084 tabbed options RPC keeps the channel open and returns an exact response", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const response = createBlacklistRpcResponse("snapshot", true, {
    snapshot: {
      authors: [],
      tags: [{ tagId: "default", name: "default", isDefault: true }],
    },
  });
  const responses: unknown[] = [];
  const listener = createBlacklistRuntimeMessageListener(
    { async handle() { return response; } },
    runtimeId,
    () => { throw new Error("unexpected failure"); },
  );
  strictEqual(listener({
    version: 1,
    type: "cocoon.blacklist.request",
    operation: "snapshot",
    input: {},
  }, {
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/options/options.html`,
    tab: { id: 2 },
  }, (value) => responses.push(value)), true);
  await settle();
  strictEqual(parseBlacklistRpcResponse(responses[0], "snapshot"), response);
});

test("POPUP-009 handler failures return a valid fail-closed RPC response", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  let failures = 0;
  const responses: unknown[] = [];
  const listener = createBlacklistRuntimeMessageListener(
    { async handle() { throw new Error("unexpected"); } },
    runtimeId,
    () => { failures += 1; },
  );
  strictEqual(listener({
    version: 1,
    type: "cocoon.blacklist.request",
    operation: "snapshot",
    input: {},
  }, {
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/popup/popup.html`,
  }, (value) => responses.push(value)), true);
  await settle();
  strictEqual(failures, 1);
  const parsed = parseBlacklistRpcResponse(responses[0], "snapshot");
  strictEqual(parsed?.ok, false);
  strictEqual(parsed?.error, "storage-unreadable");
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
