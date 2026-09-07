import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import {
  createBlacklistContentRequest,
  createBlacklistContentResponse,
} from "../core/blacklist-content-rpc-contract.ts";
import {
  createBlacklistQueryRequest,
  createBlacklistQueryResponse,
  parseBlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import {
  BLACKLIST_RPC_VERSION,
  createBlacklistRpcRequest,
  createBlacklistRpcResponse,
  parseBlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import { BLACKLIST_TRANSFER_RPC_BYTES } from "../core/blacklist-transfer-values.ts";
import {
  BLACKLIST_TRANSFER_REQUEST_TYPE,
  createBlacklistTransferRequest,
  createBlacklistTransferResponse,
  parseBlacklistTransferResponse,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type { BadgeController, BadgeMessageSender } from "./badge-controller.ts";
import {
  createBadgeRuntimeMessageListener,
  createBlacklistContentRuntimeMessageListener,
  createBlacklistRuntimeMessageListener,
  createBlacklistTransferRuntimeMessageListener,
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
  handler: (message: unknown, sender: BadgeMessageSender) => Promise<BadgeMessageResponse>,
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

  for (const message of [{ type: "future.listener.message" }, { ...VALID_MESSAGE, extra: true }]) {
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
    strictEqual(
      isAuthorizedUiSender(
        {
          id: runtimeId,
          url: `chrome-extension://${runtimeId}/${path}`,
          ...(tab ? { tab } : {}),
        },
        runtimeId,
      ),
      true,
    );
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

test("POPUP-009 malformed, unknown, and removed legacy RPC messages remain unclaimed", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  let calls = 0;
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        calls += 1;
        return createBlacklistRpcResponse("status", true, {
          status: "unsupported",
          count: 0,
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
    { ...createBlacklistRpcRequest("status", {}), extra: true },
    {
      version: BLACKLIST_RPC_VERSION,
      type: "cocoon.blacklist.request",
      operation: "restore-one",
      input: { author: { userId: "id" } },
    },
    ...["snapshot", "export-json", "import-merge", "import-replace"].map((operation) => ({
      version: BLACKLIST_RPC_VERSION,
      type: "cocoon.blacklist.request",
      operation,
      input: {},
    })),
  ]) {
    strictEqual(
      listener(message, sender, () => {}),
      false,
    );
  }
  await settle();
  strictEqual(calls, 0);
});

test("BUG-013/AC-084 tabbed options status RPC keeps the channel open and returns an exact response", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const response = createBlacklistRpcResponse("status", true, {
    status: "unsupported",
    count: 0,
  });
  const responses: unknown[] = [];
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        return response;
      },
    },
    runtimeId,
    () => {
      throw new Error("unexpected failure");
    },
  );
  strictEqual(
    listener(
      createBlacklistRpcRequest("status", {}),
      {
        id: runtimeId,
        url: `chrome-extension://${runtimeId}/options/options.html`,
        tab: { id: 2 },
      },
      (value) => responses.push(value),
    ),
    true,
  );
  await settle();
  strictEqual(parseBlacklistRpcResponse(responses[0], "status"), response);
});

test("BUG-016 UI query RPC is claimed only for exact Popup/options senders", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const response = createBlacklistQueryResponse("summary", true, {
    revision: 4,
    authorCount: 33_524,
    tagCount: 3,
  });
  const responses: unknown[] = [];
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        throw new Error("legacy handler must not receive query RPC");
      },
      async handleQuery() {
        return response;
      },
    },
    runtimeId,
    () => {},
  );
  const request = createBlacklistQueryRequest("summary", {});
  for (const path of ["popup/popup.html", "options/options.html"]) {
    strictEqual(
      listener(
        request,
        { id: runtimeId, url: `chrome-extension://${runtimeId}/${path}` },
        (value) => responses.push(value),
      ),
      true,
    );
  }
  strictEqual(
    listener(
      { ...request, extra: true },
      { id: runtimeId, url: `chrome-extension://${runtimeId}/options/options.html` },
      () => {},
    ),
    false,
  );
  strictEqual(
    listener(request, { id: runtimeId, url: "https://www.zhihu.com/", tab: { id: 2 } }, () => {}),
    false,
  );
  await settle();
  strictEqual(parseBlacklistQueryResponse(responses[0], "summary"), response);
  strictEqual(parseBlacklistQueryResponse(responses[1], "summary"), response);
});

test("BUG-016 UI query RPC handler failures return a strict storage error", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const request = createBlacklistQueryRequest("summary", {});
  const responses: unknown[] = [];
  let failures = 0;
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        throw new Error("legacy handler must not receive query RPC");
      },
      async handleQuery() {
        throw new Error("query failed");
      },
    },
    runtimeId,
    () => {
      failures += 1;
    },
  );
  strictEqual(
    listener(
      request,
      { id: runtimeId, url: `chrome-extension://${runtimeId}/popup/popup.html` },
      (value) => responses.push(value),
    ),
    true,
  );
  await settle();
  strictEqual(failures, 1);
  strictEqual(parseBlacklistQueryResponse(responses[0], "summary")?.error, "storage-unreadable");
});

test("BUG-016 removed snapshot/export/import messages are not claimed for any UI sender", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  let calls = 0;
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        calls += 1;
        return createBlacklistRpcResponse("status", true, {
          status: "unsupported",
          count: 0,
        });
      },
    },
    runtimeId,
    () => {},
  );
  for (const operation of ["snapshot", "export-json", "import-merge", "import-replace"]) {
    const message = {
      version: BLACKLIST_RPC_VERSION,
      type: "cocoon.blacklist.request",
      operation,
      input: {},
    };
    for (const path of ["popup/popup.html", "options/options.html"]) {
      strictEqual(
        listener(
          message,
          { id: runtimeId, url: `chrome-extension://${runtimeId}/${path}` },
          () => {},
        ),
        false,
      );
    }
  }
  await settle();
  strictEqual(calls, 0);
});

test("BUG-016 strict transfer listener claims only exact options senders", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const request = createBlacklistTransferRequest("export-begin", {});
  const response = createBlacklistTransferResponse("export-begin", true, {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: "2026-08-25T12:34:56.789Z",
    schemaVersion: 5,
    revision: 3,
    authorCount: 33_524,
    tagCount: 3,
  });
  const responses: unknown[] = [];
  let calls = 0;
  const listener = createBlacklistTransferRuntimeMessageListener(
    {
      async handleTransfer() {
        calls += 1;
        return response;
      },
    },
    runtimeId,
    () => {},
  );

  for (const tab of [undefined, { id: 2 }]) {
    strictEqual(
      listener(
        request,
        {
          id: runtimeId,
          url: `chrome-extension://${runtimeId}/options/options.html`,
          ...(tab ? { tab } : {}),
        },
        (value) => responses.push(value),
      ),
      true,
    );
  }
  for (const sender of [
    { id: runtimeId, url: `chrome-extension://${runtimeId}/popup/popup.html` },
    { id: runtimeId, url: "https://www.zhihu.com/", tab: { id: 2 }, frameId: 0 },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/other.html` },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/options/options.html?query=1` },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/options/options.html#hash` },
    { id: "other", url: `chrome-extension://${runtimeId}/options/options.html` },
  ]) {
    strictEqual(
      listener(request, sender, () => {}),
      false,
    );
  }
  await settle();
  strictEqual(calls, 2);
  strictEqual(responses.length, 2);
  strictEqual(parseBlacklistTransferResponse(responses[0], "export-begin"), response);
});

test("BUG-016 strict transfer listener rejects extra and oversized messages without mixing legacy RPC", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const sender = {
    id: runtimeId,
    url: `chrome-extension://${runtimeId}/options/options.html`,
  };
  let calls = 0;
  const transferListener = createBlacklistTransferRuntimeMessageListener(
    {
      async handleTransfer() {
        calls += 1;
        return createBlacklistTransferResponse("export-begin", false, null, "storage-unreadable");
      },
    },
    runtimeId,
    () => {},
  );
  const legacyListener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        throw new Error("strict transfer must not reach legacy controller");
      },
    },
    runtimeId,
    () => {},
  );
  const request = createBlacklistTransferRequest("export-begin", {});
  const oversized = {
    version: 1,
    type: BLACKLIST_TRANSFER_REQUEST_TYPE,
    operation: "export-begin",
    input: {},
    padding: "x".repeat(BLACKLIST_TRANSFER_RPC_BYTES),
  };
  strictEqual(
    transferListener({ ...request, extra: true }, sender, () => {}),
    false,
  );
  strictEqual(
    transferListener(oversized, sender, () => {}),
    false,
  );
  strictEqual(
    transferListener(
      {
        version: BLACKLIST_RPC_VERSION,
        type: "cocoon.blacklist.request",
        operation: "export-json",
        input: {},
      },
      sender,
      () => {},
    ),
    false,
  );
  strictEqual(
    legacyListener(request, sender, () => {}),
    false,
  );
  await settle();
  strictEqual(calls, 0);
});

test("BUG-016 strict transfer listener owns one async response and contains closed channels", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const request = createBlacklistTransferRequest("import-abort", {
    sessionId: "1".repeat(32),
  });
  let calls = 0;
  let failures = 0;
  const listener = createBlacklistTransferRuntimeMessageListener(
    {
      async handleTransfer() {
        calls += 1;
        return createBlacklistTransferResponse("import-abort", true, {
          sessionId: "1".repeat(32),
        });
      },
    },
    runtimeId,
    () => {
      failures += 1;
    },
  );
  strictEqual(
    listener(
      request,
      { id: runtimeId, url: `chrome-extension://${runtimeId}/options/options.html` },
      () => {
        throw new Error("channel closed");
      },
    ),
    true,
  );
  await settle();
  strictEqual(calls, 1);
  strictEqual(failures, 1);
});

test("BUG-016 strict transfer listener maps escaped handler failures without a false success", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const responses: unknown[] = [];
  let failures = 0;
  const listener = createBlacklistTransferRuntimeMessageListener(
    {
      async handleTransfer() {
        throw new Error("unreadable");
      },
    },
    runtimeId,
    () => {
      failures += 1;
    },
  );
  strictEqual(
    listener(
      createBlacklistTransferRequest("export-begin", {}),
      { id: runtimeId, url: `chrome-extension://${runtimeId}/options/options.html` },
      (value) => responses.push(value),
    ),
    true,
  );
  await settle();
  strictEqual(failures, 1);
  strictEqual(responses.length, 1);
  strictEqual(
    parseBlacklistTransferResponse(responses[0], "export-begin")?.error,
    "storage-unreadable",
  );
});

test("POPUP-009 status handler failures return a valid connection-error response", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  let failures = 0;
  const responses: unknown[] = [];
  const listener = createBlacklistRuntimeMessageListener(
    {
      async handle() {
        throw new Error("unexpected");
      },
    },
    runtimeId,
    () => {
      failures += 1;
    },
  );
  strictEqual(
    listener(
      createBlacklistRpcRequest("status", {}),
      {
        id: runtimeId,
        url: `chrome-extension://${runtimeId}/popup/popup.html`,
      },
      (value) => responses.push(value),
    ),
    true,
  );
  await settle();
  strictEqual(failures, 1);
  const parsed = parseBlacklistRpcResponse(responses[0], "status");
  strictEqual(parsed?.ok, true);
  strictEqual(parsed?.data.status, "connection-error");
  strictEqual(parsed?.data.count, 0);
});

test("AC-094 targeted content RPC accepts the same-extension main frame", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const request = createBlacklistContentRequest("initialize", {});
  const expected = createBlacklistContentResponse("initialize", true, {
    revision: 0,
    authorCount: 0,
    tagCount: 1,
  });
  const responses: unknown[] = [];
  let calls = 0;
  const listener = createBlacklistContentRuntimeMessageListener(
    {
      async handle() {
        calls += 1;
        return expected.result;
      },
    },
    runtimeId,
    () => {},
  );
  strictEqual(
    listener(
      request,
      { id: runtimeId, url: "https://www.zhihu.com/", tab: { id: 7 }, frameId: 0 },
      (response) => responses.push(response),
    ),
    true,
  );
  await settle();
  strictEqual(calls, 1);
  deepStrictEqual(responses, [expected]);
});

test("AC-094 targeted content RPC rejects other senders and removed operations", async () => {
  const runtimeId = "abcdefghijklmnopabcdefghijklmnop";
  const request = createBlacklistContentRequest("initialize", {});
  let calls = 0;
  const listener = createBlacklistContentRuntimeMessageListener(
    {
      async handle() {
        calls += 1;
        return { revision: 0, authorCount: 0, tagCount: 1 };
      },
    },
    runtimeId,
    () => {},
  );
  for (const sender of [
    { id: runtimeId, url: "https://www.zhihu.com/", tab: { id: 7 }, frameId: 1 },
    { id: runtimeId, url: "https://www.zhihu.com/", frameId: 0 },
    {
      id: runtimeId,
      url: `chrome-extension://${runtimeId}/options/options.html`,
      tab: { id: 7 },
      frameId: 0,
    },
    {
      id: runtimeId,
      url: "https://www.zhihu.com/?unexpected=1",
      tab: { id: 7 },
      frameId: 0,
    },
    { id: runtimeId, url: "https://example.com/", tab: { id: 7 }, frameId: 0 },
    { id: "other-extension", url: "https://www.zhihu.com/", tab: { id: 7 }, frameId: 0 },
  ]) {
    strictEqual(
      listener(request, sender, () => {}),
      false,
    );
  }
  const sender = {
    id: runtimeId,
    url: "https://www.zhihu.com/",
    tab: { id: 7 },
    frameId: 0,
  };
  strictEqual(
    listener({ ...request, extra: true }, sender, () => {}),
    false,
  );
  strictEqual(
    listener(
      { version: 2, type: "cocoon.blacklist.content.request", operation: "hydrate", input: {} },
      sender,
      () => {},
    ),
    false,
  );
  await settle();
  strictEqual(calls, 0);
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
      deepStrictEqual(responses, [scenario === "stale" ? { ok: false } : { ok: false }]);
    }
  }
});
