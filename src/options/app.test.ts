import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  MAX_BLACKLIST_TRANSFER_BYTES,
  createBlacklistRpcResponse,
  type BlacklistSnapshotDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
  type BlacklistTransferEnvelope,
} from "../core/blacklist-rpc-contract.ts";
import { createBlacklistRpcClient, type BlacklistRpcClient } from "../ui/background-rpc.ts";
import {
  bootstrapOptions as bootstrapProductionOptions,
  type OptionsAppDependencies,
} from "./app.ts";

type OptionsTestDependencies = Omit<OptionsAppDependencies, "readFileText" | "downloadJson"> &
  Partial<Pick<OptionsAppDependencies, "readFileText" | "downloadJson">>;

function bootstrapOptions(
  dependencies: OptionsTestDependencies,
): ReturnType<typeof bootstrapProductionOptions> {
  return bootstrapProductionOptions({
    async readFileText() {
      return "";
    },
    downloadJson() {},
    ...dependencies,
  });
}

const SNAPSHOT: BlacklistSnapshotDto = {
  authors: [
    {
      platformId: "zhihu",
      userId: "author-one",
      memberHashId: null,
      authorName: "Author One",
      tagId: "tag-one",
      blacklistedAt: "2026-08-21T10:00:00.000Z",
      source: "direct",
    },
  ],
  tags: [
    { tagId: "default", name: "default", isDefault: true },
    { tagId: "tag-one", name: "Persisted", isDefault: false },
  ],
};

const TRANSFER: BlacklistTransferEnvelope = {
  product: "cocoon-blacklist",
  formatVersion: 1,
  exportedAt: "2026-08-22T10:00:00.000Z",
  schemaVersion: 5,
  authors: [
    {
      platformId: "zhihu",
      userId: "transfer/zhihu user",
      memberHashId: null,
      authorNameAtCapture: "Transfer Zhihu",
      tagId: "default",
      blacklistedAt: "2026-08-21T10:00:00.000Z",
      blockSource: "direct",
    },
    {
      platformId: "youtube",
      userId: "transfer-youtube",
      memberHashId: null,
      authorNameAtCapture: "Transfer YouTube",
      tagId: "reading",
      blacklistedAt: "2026-08-20T10:00:00.000Z",
      blockSource: "upvoter",
    },
  ],
  tags: [
    { tagId: "default", name: "default" },
    { tagId: "reading", name: "Reading" },
  ],
};

function fixture(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body>
    <span id="author-total"></span><span id="tag-total"></span>
    <p id="page-message"></p><p id="write-error" tabindex="-1" hidden></p>
    <section id="transfer-panel">
      <button id="export-data"></button><input id="import-file" type="file">
      <fieldset id="import-mode">
        <input type="radio" name="import-mode" value="merge" checked>
        <input type="radio" name="import-mode" value="replace">
      </fieldset>
      <button id="import-data"></button><p id="transfer-status" tabindex="-1"></p>
      <p id="transfer-error" tabindex="-1" hidden></p>
    </section>
    <input id="author-search"><select id="tag-filter"></select><select id="platform-filter"></select>
    <select id="time-sort"><option value="desc">desc</option><option value="asc">asc</option></select>
    <button id="remove-selected"></button>
    <div id="author-viewport" tabindex="0"><div id="author-list"></div></div>
    <p id="list-summary"></p><h2 id="tags-heading" tabindex="-1"></h2><p id="tag-summary"></p><div id="tag-list"></div>
    <dialog id="batch-dialog"><p id="batch-dialog-description"></p>
      <button id="batch-cancel"></button><button id="batch-confirm"></button>
    </dialog>
    <dialog id="replace-dialog"><p id="replace-dialog-description"></p>
      <button id="replace-cancel"></button><button id="replace-confirm"></button>
    </dialog>
  </body>`,
    {
      pretendToBeVisual: true,
      url: "chrome-extension://runtime/options/options.html",
    },
  );
  for (const dialog of dom.window.document.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
  }
  return dom;
}

test("MANAGE-005/AC-092 keeps transfer tools as the final main section", async () => {
  const source = await readFile(new URL("../../options/options.html", import.meta.url), "utf8");
  const document = new JSDOM(source).window.document;
  const main = document.querySelector("main");
  const tags = document.querySelector(".tags-panel");
  const transfer = document.querySelector("#transfer-panel");
  if (!main || !tags || !transfer) throw new Error("production sections missing");

  const sections = [...main.querySelectorAll(":scope > section")];
  strictEqual(sections.at(-1), transfer);
  strictEqual(sections.indexOf(tags) < sections.indexOf(transfer), true);
});

function selectImportFile(dom: JSDOM, file: File | null): void {
  const input = dom.window.document.querySelector<HTMLInputElement>("#import-file");
  if (!input) throw new Error("import input missing");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: file ? [file] : [],
  });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function deferredResponse() {
  let resolve: ((value: BlacklistRpcResponse) => void) | undefined;
  const promise = new Promise<BlacklistRpcResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: BlacklistRpcResponse) => resolve?.(value) };
}

class RpcQueue implements BlacklistRpcClient {
  readonly responses = new Map<BlacklistRpcOperation, Array<Promise<BlacklistRpcResponse>>>();
  readonly requestCounts = new Map<BlacklistRpcOperation, number>();
  readonly requests: Array<{
    readonly operation: BlacklistRpcOperation;
    readonly input: Record<string, unknown>;
  }> = [];
  push(
    operation: BlacklistRpcOperation,
    response: BlacklistRpcResponse | Promise<BlacklistRpcResponse>,
  ): void {
    const queue = this.responses.get(operation) ?? [];
    queue.push(Promise.resolve(response));
    this.responses.set(operation, queue);
  }
  async request(
    operation: BlacklistRpcOperation,
    input: Record<string, unknown> = {},
  ): Promise<BlacklistRpcResponse> {
    this.requestCounts.set(operation, (this.requestCounts.get(operation) ?? 0) + 1);
    this.requests.push({ operation, input });
    const response = this.responses.get(operation)?.shift();
    if (!response) throw new Error(`missing ${operation} response`);
    return await response;
  }
  removeOne(
    identity: Parameters<BlacklistRpcClient["removeOne"]>[0],
  ): Promise<BlacklistRpcResponse> {
    return this.request("remove-one", { identity });
  }
  restoreOne(
    author: Parameters<BlacklistRpcClient["restoreOne"]>[0],
  ): Promise<BlacklistRpcResponse> {
    return this.request("restore-one", { author });
  }
}

test("BUG-014/AC-085 options accepts nullable member aliases through the strict RPC client", async () => {
  const dom = fixture();
  let rpcCalls = 0;
  const rpc = createBlacklistRpcClient(async () => {
    rpcCalls += 1;
    return createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT });
  });
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  strictEqual(rpcCalls, 1);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(dom.window.document.querySelector("#tag-total")?.textContent, "2");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual((dom.window.document.querySelector("#page-message") as HTMLElement).hidden, true);
});

test("MANAGE production bootstrap rolls failed rename back and enters read-only on storage-unreadable", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push(
    "rename-tag",
    createBlacklistRpcResponse("rename-tag", false, { snapshot: SNAPSHOT }, "invalid-tag"),
  );
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const rename = dom.window.document.querySelector<HTMLButtonElement>(
    "#tag-list button[aria-label='重命名标签 Persisted']",
  );
  rename?.click();
  const editable = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!editable) throw new Error("editable tag missing");
  editable.value = "Rejected";
  editable.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  editable.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();

  const rerenderedName = dom.window.document.querySelector("#tag-list .tag-display-name");
  strictEqual(rerenderedName?.textContent, "Persisted");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 1);
  strictEqual(
    dom.window.document.querySelector("#tag-list")?.textContent?.includes("default"),
    false,
  );
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );
  strictEqual(
    dom.window.document.querySelector("#write-error")?.textContent,
    "标签名称无效或已存在。",
  );
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, false);

  dom.window.document.querySelector<HTMLButtonElement>("#author-list button")?.click();
  await settle();
  strictEqual(
    dom.window.document.querySelector("#page-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。",
  );
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 0);
  strictEqual(dom.window.document.querySelectorAll("#tag-list button").length, 0);
  strictEqual(
    (dom.window.document.querySelector("#remove-selected") as HTMLButtonElement).disabled,
    true,
  );
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);
  strictEqual(rpc.requestCounts.get("remove-one"), 1);
});

test("MANAGE-003/AC-087 failed delete rolls back and restores the equivalent action", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push(
    "delete-tag",
    createBlacklistRpcResponse("delete-tag", false, { snapshot: SNAPSHOT }, "save-failed"),
  );
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const failedDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  failedDelete?.focus();
  failedDelete?.click();
  await settle();
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Persisted");
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, false);
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "删除标签 Persisted",
  );
});

test("MANAGE-003/AC-087 unreadable tag mutation focuses the visible error fallback", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const unreadableDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  unreadableDelete?.focus();
  unreadableDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.activeElement?.id, "write-error");
});

test("AC-095 committed rename snapshot remains visible without a post-read", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Updated" }],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("rename-tag", createBlacklistRpcResponse("rename-tag", true, { snapshot: renamed }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 1);
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Updated");
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, true);
});

test("AC-095 newer revision refresh wins over an older pending rename response", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingRename = deferredResponse();
  const updated: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Updated" }],
  };
  const later: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Later" }],
  };
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("rename-tag", pendingRename.promise);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input
    .closest("form")
    ?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: later }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: later }));
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 2 } } }, "local");
  await settle();
  pendingRename.resolve(createBlacklistRpcResponse("rename-tag", true, { snapshot: updated }));
  await settle();

  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Later");
});

test("AC-095 committed delete snapshot remains visible without a post-read", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const defaultOnly: BlacklistSnapshotDto = {
    authors: [{ ...SNAPSHOT.authors[0]!, tagId: "default" }],
    tags: [SNAPSHOT.tags[0]!],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", true, { snapshot: defaultOnly }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const successfulUnreadableDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  successfulUnreadableDelete?.focus();
  successfulUnreadableDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.querySelector(".tag-empty")?.textContent?.includes("暂无"), true);
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, true);
});

test("MANAGE-003/AC-087 successful rename and delete restore useful focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Updated" }],
  };
  const defaultOnly: BlacklistSnapshotDto = {
    authors: [{ ...SNAPSHOT.authors[0]!, tagId: "default" }],
    tags: [SNAPSHOT.tags[0]!],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("rename-tag", createBlacklistRpcResponse("rename-tag", true, { snapshot: renamed }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: renamed }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: renamed }));
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", true, { snapshot: defaultOnly }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: defaultOnly }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: defaultOnly }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Updated");
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Updated",
  );
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Updated",
  );

  const successfulDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Updated']",
  );
  successfulDelete?.focus();
  successfulDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(
    dom.window.document.querySelector(".tag-empty")?.textContent?.includes("暂无自定义标签"),
    true,
  );
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
});

test("MANAGE-003/AC-087 every storage rerender preserves tag focus or uses the heading", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const defaultOnly: BlacklistSnapshotDto = {
    authors: [{ ...SNAPSHOT.authors[0]!, tagId: "default" }],
    tags: [SNAPSHOT.tags[0]!],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: defaultOnly }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='删除标签 Persisted']")
    ?.focus();
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "删除标签 Persisted",
  );

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  strictEqual(dom.window.document.activeElement?.tagName, "INPUT");
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='删除标签 Persisted']")
    ?.focus();
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
});

test("MANAGE-003/AC-087 pending rename survives storage refresh without duplicate RPC or focus loss", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Updated" }],
  };
  const pendingRename = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: renamed }));
  rpc.push("rename-tag", pendingRename.promise);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  strictEqual(dom.window.document.activeElement, save);
  strictEqual(save.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);

  pendingRename.resolve(
    createBlacklistRpcResponse("rename-tag", true, {
      snapshot: renamed,
    }),
  );
  await settle();
  const completedAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Updated']",
  );
  strictEqual(dom.window.document.activeElement, completedAction);
  strictEqual(completedAction?.hasAttribute("aria-disabled"), false);
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);
});

test("MANAGE-003/AC-087 pending delete survives storage refresh without duplicate RPC or focus loss", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingDelete = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("delete-tag", pendingDelete.promise);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const remove = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  remove?.focus();
  remove?.click();
  strictEqual(dom.window.document.activeElement, remove);
  strictEqual(remove?.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);

  pendingDelete.resolve(
    createBlacklistRpcResponse(
      "delete-tag",
      false,
      {
        snapshot: SNAPSHOT,
      },
      "save-failed",
    ),
  );
  await settle();
  const completedAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, completedAction);
  strictEqual(completedAction?.hasAttribute("aria-disabled"), false);
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);
});

test("MANAGE-003/AC-087 stale rename completion never steals newer tag focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const initial: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [...SNAPSHOT.tags, { tagId: "tag-two", name: "Second", isDefault: false }],
  };
  const renamed: BlacklistSnapshotDto = {
    ...initial,
    tags: [initial.tags[0]!, { ...initial.tags[1]!, name: "Updated" }, initial.tags[2]!],
  };
  const pendingRename = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  rpc.push("rename-tag", pendingRename.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: renamed }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  const newerFocus = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Second']",
  );
  newerFocus?.focus();
  pendingRename.resolve(
    createBlacklistRpcResponse("rename-tag", true, {
      snapshot: renamed,
    }),
  );
  await settle();
  strictEqual(dom.window.document.activeElement?.getAttribute("aria-label"), "删除标签 Second");
});

test("MANAGE-003/AC-087 stale delete failure never steals newer tag focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const initial: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [...SNAPSHOT.tags, { tagId: "tag-two", name: "Second", isDefault: false }],
  };
  const pendingDelete = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  rpc.push("delete-tag", pendingDelete.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const deleting = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  deleting?.focus();
  deleting?.click();
  const newerFocus = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Second']",
  );
  newerFocus?.focus();
  pendingDelete.resolve(
    createBlacklistRpcResponse(
      "delete-tag",
      false,
      {
        snapshot: initial,
      },
      "save-failed",
    ),
  );
  await settle();
  strictEqual(dom.window.document.activeElement?.getAttribute("aria-label"), "重命名标签 Second");
});

function profileFilterSnapshots() {
  const internalUserId = "private-user-token-91";
  const internalTagId = "private-tag-token-73";
  const otherTagId = "private-tag-token-84";
  const initial: BlacklistSnapshotDto = {
    authors: [
      {
        platformId: "zhihu",
        userId: internalUserId,
        memberHashId: "abcdef0123456789abcdef0123456789",
        authorName: "Filtered Author",
        tagId: internalTagId,
        blacklistedAt: "2026-08-21T10:00:00.000Z",
        source: "direct",
      },
      {
        platformId: "zhihu",
        userId: "private-user-token-92",
        memberHashId: null,
        authorName: "Other Author",
        tagId: otherTagId,
        blacklistedAt: "2026-08-20T10:00:00.000Z",
        source: "upvoter",
      },
    ],
    tags: [
      { tagId: "default", name: "default", isDefault: true },
      { tagId: internalTagId, name: "Reading", isDefault: false },
      { tagId: otherTagId, name: "Muted", isDefault: false },
    ],
  };
  return {
    internalUserId,
    initial,
    refreshed: { ...initial, tags: [initial.tags[2]!, initial.tags[0]!, initial.tags[1]!] },
    removedTag: {
      authors: [{ ...initial.authors[0]!, tagId: "default" }, initial.authors[1]!],
      tags: [initial.tags[0]!, initial.tags[2]!],
    } satisfies BlacklistSnapshotDto,
  };
}

function assertManagementProfileLinks(
  document: Document,
  expectedUserIds: readonly string[],
): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.author-name"));
  strictEqual(links.length, expectedUserIds.length);
  strictEqual(
    links
      .map((link) => link.href)
      .sort()
      .join("|"),
    expectedUserIds
      .map((userId) => `https://www.zhihu.com/people/${userId}`)
      .sort()
      .join("|"),
  );
  for (const link of links) {
    strictEqual(link.target, "_blank");
    strictEqual(link.rel, "noopener");
  }
}

test("PROFILE-001/AC-086 management links profiles and preserves tag filtering across refreshes", async () => {
  const {
    internalUserId,
    initial: privateSnapshot,
    refreshed: refreshedSnapshot,
    removedTag: removedTagSnapshot,
  } = profileFilterSnapshots();
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: privateSnapshot }));
  rpc.push(
    "snapshot",
    createBlacklistRpcResponse("snapshot", true, { snapshot: refreshedSnapshot }),
  );
  rpc.push(
    "snapshot",
    createBlacklistRpcResponse("snapshot", true, { snapshot: removedTagSnapshot }),
  );
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  assertManagementProfileLinks(dom.window.document, [internalUserId, "private-user-token-92"]);
  strictEqual(dom.window.document.querySelector("#tag-summary")?.textContent, "2 个自定义标签");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 2);
  strictEqual(
    dom.window.document.querySelector("#tag-list")?.textContent?.includes("default"),
    false,
  );

  const filter = dom.window.document.querySelector<HTMLSelectElement>("#tag-filter");
  const readingOption = [...(filter?.options ?? [])].find(
    (option) => option.textContent === "Reading",
  );
  if (!filter || !readingOption) throw new Error("tag filter option missing");
  strictEqual(
    [...filter.options].some((option) => option.textContent === "default"),
    true,
  );
  filter.value = readingOption.value;
  filter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(
    dom.window.document.querySelector("#author-list")?.textContent?.includes("Filtered Author"),
    true,
  );
  strictEqual(
    dom.window.document.querySelector("#author-list")?.textContent?.includes("Other Author"),
    false,
  );

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(
    dom.window.document.querySelector("#author-list")?.textContent?.includes("Filtered Author"),
    true,
  );
  strictEqual(filter.selectedOptions[0]?.textContent, "Reading");
  assertManagementProfileLinks(dom.window.document, [internalUserId]);

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(filter.value, "");
  strictEqual(filter.selectedOptions[0]?.textContent, "全部标签");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 2);
  assertManagementProfileLinks(dom.window.document, [internalUserId, "private-user-token-92"]);
});

function platformFilterSnapshots() {
  const initial: BlacklistSnapshotDto = {
    tags: SNAPSHOT.tags,
    authors: [
      {
        ...SNAPSHOT.authors[0]!,
        userId: "zhihu/encoded user",
        authorName: "Video Zhihu",
        blacklistedAt: "2026-08-21T09:00:00.000Z",
      },
      {
        ...SNAPSHOT.authors[0]!,
        platformId: "youtube",
        userId: "shared-user",
        memberHashId: null,
        authorName: "Video Older",
        blacklistedAt: "2026-08-20T09:00:00.000Z",
        source: "upvoter",
      },
      {
        ...SNAPSHOT.authors[0]!,
        platformId: "youtube",
        userId: "newer-user",
        memberHashId: null,
        authorName: "Video Newer",
        blacklistedAt: "2026-08-22T09:00:00.000Z",
        source: "direct",
      },
      {
        ...SNAPSHOT.authors[0]!,
        platformId: "future-site",
        userId: "shared-user",
        memberHashId: null,
        authorName: "Future Author",
        tagId: "default",
        source: "direct",
      },
    ],
  };
  return {
    initial,
    refreshed: {
      tags: initial.tags.map((tag) => ({ ...tag })),
      authors: [
        ...initial.authors.map((author) => ({ ...author })),
        {
          ...initial.authors[1]!,
          userId: "third-user",
          authorName: "Video Middle",
          blacklistedAt: "2026-08-21T09:00:00.000Z",
        },
      ],
    } satisfies BlacklistSnapshotDto,
  };
}

function requiredPlatformControls(document: Document) {
  const platformFilter = document.querySelector<HTMLSelectElement>("#platform-filter");
  const tagFilter = document.querySelector<HTMLSelectElement>("#tag-filter");
  const search = document.querySelector<HTMLInputElement>("#author-search");
  const sort = document.querySelector<HTMLSelectElement>("#time-sort");
  if (!platformFilter || !tagFilter || !search || !sort) {
    throw new Error("filter controls missing");
  }
  return { platformFilter, tagFilter, search, sort };
}

function assertPlatformRows(document: Document): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("#author-list .author-row"));
  const futureRow = rows.find((row) => row.textContent?.includes("Future Author"));
  if (!futureRow) throw new Error("future platform row missing");
  strictEqual(futureRow.querySelector(".platform-name")?.textContent, "future-site");
  strictEqual(futureRow.querySelector(".source-name")?.textContent, "手动屏蔽");
  strictEqual(futureRow.querySelector("a.author-name"), null);
  const plainFuture = futureRow.querySelector<HTMLElement>("span.author-name");
  if (!plainFuture) throw new Error("plain future author missing");
  strictEqual(plainFuture.tabIndex, -1);
  strictEqual(plainFuture.hasAttribute("href"), false);
  const zhihuRow = rows.find((row) => row.textContent?.includes("Video Zhihu"));
  const zhihu = zhihuRow?.querySelector<HTMLAnchorElement>("a.author-name");
  if (!zhihu) throw new Error("Zhihu author link missing");
  strictEqual(zhihu.href, "https://www.zhihu.com/people/zhihu%2Fencoded%20user");
  strictEqual(zhihu.target, "_blank");
  strictEqual(zhihu.rel, "noopener");
}

test("PLATFORM-001/AC-090 management renders an independent platform column/filter through composed storage refreshes", async () => {
  const { initial: multiPlatform, refreshed } = platformFilterSnapshots();
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push(
    "snapshot",
    createBlacklistRpcResponse("snapshot", true, {
      snapshot: multiPlatform,
    }),
  );
  rpc.push(
    "snapshot",
    createBlacklistRpcResponse("snapshot", true, {
      snapshot: refreshed,
    }),
  );
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const { platformFilter, tagFilter, search, sort } = requiredPlatformControls(dom.window.document);
  const labels = ["future-site", "YouTube", "知乎"].sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );
  deepStrictEqual(
    [...platformFilter.options].map((option) => option.textContent),
    ["全部站点", ...labels],
  );
  assertPlatformRows(dom.window.document);

  const youtubeOption = [...platformFilter.options].find(
    (option) => option.textContent === "YouTube",
  );
  const readingOption = [...tagFilter.options].find((option) => option.textContent === "Persisted");
  if (!youtubeOption || !readingOption) throw new Error("filter option missing");
  platformFilter.value = youtubeOption.value;
  platformFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  tagFilter.value = readingOption.value;
  tagFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  search.value = "video";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  sort.value = "asc";
  sort.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name")).map(
      (name) => name.textContent,
    ),
    ["Video Older", "Video Newer"],
  );
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .source-name")).map(
      (source) => source.textContent,
    ),
    ["来自点赞者", "手动屏蔽"],
  );
  strictEqual(dom.window.document.querySelectorAll("#author-list a.author-name").length, 0);

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(platformFilter.selectedOptions[0]?.textContent, "YouTube");
  strictEqual(tagFilter.selectedOptions[0]?.textContent, "Persisted");
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name")).map(
      (name) => name.textContent,
    ),
    ["Video Older", "Video Middle", "Video Newer"],
  );
  for (const name of dom.window.document.querySelectorAll<HTMLElement>(
    "#author-list span.author-name",
  )) {
    strictEqual(name.tabIndex, -1);
    strictEqual(name.closest("a"), null);
  }
});

test("PLATFORM-001/PROFILE-002/AC-090/AC-091 composed filters keep incremental loading and link focus", async () => {
  const tags = SNAPSHOT.tags;
  const large: BlacklistSnapshotDto = {
    tags,
    authors: [
      ...Array.from({ length: 130 }, (_, index) => ({
        ...SNAPSHOT.authors[0]!,
        userId: `bulk/zhihu ${index}`,
        authorName: `Bulk ${String(index).padStart(3, "0")}`,
        blacklistedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        ...SNAPSHOT.authors[0]!,
        platformId: "youtube",
        userId: `bulk-youtube-${index}`,
        memberHashId: null,
        authorName: `Bulk Video ${index}`,
      })),
    ],
  };
  const dom = fixture();
  const viewport = dom.window.document.querySelector<HTMLElement>("#author-viewport");
  const list = dom.window.document.querySelector<HTMLElement>("#author-list");
  if (!viewport || !list) throw new Error("author list missing");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 640 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get() {
      return list.querySelectorAll(".author-row").length * 64;
    },
  });
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: large }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  strictEqual(list.classList.contains("virtual-list"), false);
  strictEqual(list.querySelectorAll(".author-row").length, 50);
  const originalFocus = list.querySelector<HTMLAnchorElement>("a.author-name");
  originalFocus?.focus();
  viewport.scrollTop = 2_600;
  viewport.dispatchEvent(new dom.window.Event("scroll"));
  strictEqual(list.querySelectorAll(".author-row").length, 100);
  strictEqual(dom.window.document.activeElement?.tagName, "A");
  strictEqual(dom.window.document.activeElement === originalFocus, false);
  strictEqual((dom.window.document.activeElement as HTMLAnchorElement).href, originalFocus?.href);

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const youtube = [...(platform?.options ?? [])].find((option) => option.textContent === "YouTube");
  if (!platform || !youtube) throw new Error("YouTube filter missing");
  platform.value = youtube.value;
  platform.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  strictEqual(list.querySelectorAll(".author-row").length, 10);
  strictEqual(list.querySelectorAll("a.author-name").length, 0);
  strictEqual(list.querySelectorAll("span.author-name").length, 10);
});

test("PLATFORM-001/PROFILE-002/AC-090/AC-091 platform filtering and storage refresh preserve >200 virtualization focus", async () => {
  const large: BlacklistSnapshotDto = {
    tags: SNAPSHOT.tags,
    authors: [
      ...Array.from({ length: 230 }, (_, index) => ({
        ...SNAPSHOT.authors[0]!,
        userId: `virtual/zhihu ${index}`,
        authorName: `Virtual ${String(index).padStart(3, "0")}`,
        blacklistedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
      {
        ...SNAPSHOT.authors[0]!,
        platformId: "youtube",
        userId: "virtual-youtube",
        memberHashId: null,
        authorName: "Virtual YouTube",
      },
    ],
  };
  const refreshed: BlacklistSnapshotDto = {
    tags: large.tags.map((tag) => ({ ...tag })),
    authors: large.authors.map((author) => ({ ...author })),
  };
  const dom = fixture();
  const viewport = dom.window.document.querySelector<HTMLElement>("#author-viewport");
  if (!viewport) throw new Error("viewport missing");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 640 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get() {
      const list = dom.window.document.querySelector<HTMLElement>("#author-list");
      return Number.parseFloat(list?.style.height || "0");
    },
  });
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: large }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: refreshed }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const zhihuOption = [...(platform?.options ?? [])].find(
    (option) => option.textContent === "知乎",
  );
  if (!platform || !zhihuOption) throw new Error("Zhihu filter missing");
  platform.value = zhihuOption.value;
  platform.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const list = dom.window.document.querySelector<HTMLElement>("#author-list");
  if (!list) throw new Error("list missing");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(list.querySelectorAll(".author-row").length < 50, true);
  const focused = list.querySelectorAll<HTMLAnchorElement>("a.author-name").item(3);
  focused.focus();

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(platform.selectedOptions[0]?.textContent, "知乎");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(dom.window.document.activeElement?.tagName, "A");
  strictEqual(dom.window.document.activeElement === focused, false);
  strictEqual((dom.window.document.activeElement as HTMLAnchorElement).href, focused.href);
  strictEqual(list.querySelectorAll("span.author-name").length, 0);
});

test("MANAGE-004/AC-089 reads a local valid file, defaults to merge, reports exact counts, and rejects duplicate pending import", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingImport = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("import-merge", pendingImport.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", false, {}, "storage-unreadable"));
  let readFile: File | null = null;
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText(file) {
      readFile = file;
      return JSON.stringify(TRANSFER);
    },
    downloadJson() {},
  });
  await settle();

  const file = new dom.window.File([JSON.stringify(TRANSFER)], "backup.json", {
    type: "application/json",
  }) as unknown as File;
  selectImportFile(dom, file);
  await settle();
  strictEqual(readFile, file);
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已校验 2 位作者和 2 个标签。",
  );
  strictEqual(
    dom.window.document.querySelector<HTMLInputElement>("input[name='import-mode'][value='merge']")
      ?.checked,
    true,
  );
  const importButton = dom.window.document.querySelector<HTMLButtonElement>("#import-data");
  if (!importButton) throw new Error("import button missing");
  strictEqual(importButton.disabled, false);
  importButton.click();
  importButton.click();
  strictEqual(rpc.requestCounts.get("import-merge"), 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-panel")?.getAttribute("aria-busy"),
    "true",
  );
  strictEqual(dom.window.document.querySelector<HTMLInputElement>("#import-file")?.disabled, true);
  strictEqual(
    dom.window.document.querySelector<HTMLFieldSetElement>("#import-mode")?.disabled,
    true,
  );
  deepStrictEqual(rpc.requests.find(({ operation }) => operation === "import-merge")?.input, {
    transfer: TRANSFER,
  });

  pendingImport.resolve(
    createBlacklistRpcResponse("import-merge", true, {
      snapshot: SNAPSHOT,
    }),
  );
  await settle();
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "合并完成；文件包含 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");
  strictEqual(importButton.disabled, true);
  strictEqual(rpc.requestCounts.get("import-merge"), 1);
});

test("MANAGE-004/AC-089 replace inspects exact counts, cancels safely, confirms once, and restores focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push(
    "import-replace",
    createBlacklistRpcResponse("import-replace", true, {
      snapshot: SNAPSHOT,
    }),
  );
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText() {
      return JSON.stringify(TRANSFER);
    },
    downloadJson() {},
  });
  await settle();
  selectImportFile(
    dom,
    new dom.window.File([JSON.stringify(TRANSFER)], "replace.json") as unknown as File,
  );
  await settle();

  const merge = dom.window.document.querySelector<HTMLInputElement>(
    "input[name='import-mode'][value='merge']",
  );
  const replace = dom.window.document.querySelector<HTMLInputElement>(
    "input[name='import-mode'][value='replace']",
  );
  const importButton = dom.window.document.querySelector<HTMLButtonElement>("#import-data");
  const dialog = dom.window.document.querySelector<HTMLDialogElement>("#replace-dialog");
  const cancel = dom.window.document.querySelector<HTMLButtonElement>("#replace-cancel");
  const confirm = dom.window.document.querySelector<HTMLButtonElement>("#replace-confirm");
  if (!merge || !replace || !importButton || !dialog || !cancel || !confirm) {
    throw new Error("replace controls missing");
  }
  merge.checked = false;
  replace.checked = true;
  importButton.focus();
  importButton.click();
  strictEqual(dialog.open, true);
  strictEqual(
    dom.window.document.querySelector("#replace-dialog-description")?.textContent,
    "将用文件中的 2 位作者和 2 个标签替换当前列表。现有设置会保留。",
  );
  strictEqual(dom.window.document.activeElement, cancel);
  strictEqual(rpc.requestCounts.get("import-replace") ?? 0, 0);

  cancel.click();
  strictEqual(dialog.open, false);
  strictEqual(dom.window.document.activeElement, importButton);
  strictEqual(rpc.requestCounts.get("import-replace") ?? 0, 0);

  importButton.click();
  confirm.click();
  confirm.click();
  await settle();
  strictEqual(rpc.requestCounts.get("import-replace"), 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已替换为 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");
});

test("MANAGE-004/AC-089 accepts the 8 MiB boundary and rejects oversized/read failures before import RPC", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push(
    "import-merge",
    createBlacklistRpcResponse("import-merge", true, {
      snapshot: SNAPSHOT,
    }),
  );
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  let reads = 0;
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText(file) {
      reads += 1;
      if (file.name === "unreadable.json") throw new Error("read failed");
      return file.name === "boundary.json" ? JSON.stringify(TRANSFER) : '{"product":"unknown"}';
    },
    downloadJson() {},
  });
  await settle();

  const boundary = new dom.window.File(["{}"], "boundary.json") as unknown as File;
  Object.defineProperty(boundary, "size", {
    configurable: true,
    value: MAX_BLACKLIST_TRANSFER_BYTES,
  });
  selectImportFile(dom, boundary);
  await settle();
  strictEqual(reads, 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已校验 2 位作者和 2 个标签。",
  );
  dom.window.document.querySelector<HTMLButtonElement>("#import-data")?.click();
  await settle();
  strictEqual(rpc.requestCounts.get("import-merge"), 1);

  const oversized = new dom.window.File(["{}"], "oversized.json") as unknown as File;
  Object.defineProperty(oversized, "size", {
    configurable: true,
    value: MAX_BLACKLIST_TRANSFER_BYTES + 1,
  });
  selectImportFile(dom, oversized);
  await settle();
  strictEqual(reads, 1);
  strictEqual(rpc.requestCounts.get("import-merge"), 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "导入文件超过 8 MiB 限制。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-error");

  selectImportFile(dom, new dom.window.File(["{}"], "invalid.json") as unknown as File);
  await settle();
  strictEqual(reads, 2);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "导入文件无效或格式不受支持。",
  );
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "未选择可导入的数据。",
  );

  selectImportFile(dom, new dom.window.File(["{}"], "unreadable.json") as unknown as File);
  await settle();
  strictEqual(reads, 3);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "无法读取导入文件，请重新选择。",
  );
  strictEqual(dom.window.document.querySelector<HTMLButtonElement>("#import-data")?.disabled, true);
  strictEqual(rpc.requestCounts.get("import-merge"), 1);
  strictEqual(rpc.requestCounts.get("import-replace") ?? 0, 0);
});

for (const failureCase of [
  {
    error: "invalid-transfer" as const,
    message: "导入文件无效或格式不受支持，未进行更改。",
  },
  {
    error: "transfer-conflict" as const,
    message: "导入内容与本地标签或稳定标识冲突，未进行更改。",
  },
  {
    error: "transfer-too-large" as const,
    message: "导入数据超过 8 MiB 限制，未进行更改。",
  },
  {
    error: "save-failed" as const,
    message: "导入未保存，请重试。",
  },
  {
    error: "storage-unreadable" as const,
    message: "本地数据无法读取，Cocoon 未进行修改。",
  },
]) {
  test(`MANAGE-004/AC-089 import ${failureCase.error} has no stale success or partial UI state`, async () => {
    const dom = fixture();
    const rpc = new RpcQueue();
    rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
    rpc.push(
      "import-merge",
      createBlacklistRpcResponse("import-merge", false, {}, failureCase.error),
    );
    if (failureCase.error !== "storage-unreadable") {
      rpc.push(
        "snapshot",
        createBlacklistRpcResponse("snapshot", true, {
          snapshot: SNAPSHOT,
        }),
      );
    }
    bootstrapOptions({
      document: dom.window.document,
      rpc,
      storageChanges: { addListener() {} },
      requestFrame(callback) {
        callback();
        return 1;
      },
      async readFileText() {
        return JSON.stringify(TRANSFER);
      },
      downloadJson() {},
    });
    await settle();
    selectImportFile(
      dom,
      new dom.window.File([JSON.stringify(TRANSFER)], "failure.json") as unknown as File,
    );
    await settle();
    dom.window.document.querySelector<HTMLButtonElement>("#import-data")?.click();
    await settle();

    strictEqual(rpc.requestCounts.get("import-merge"), 1);
    strictEqual(
      dom.window.document.querySelector("#transfer-error")?.textContent,
      failureCase.message,
    );
    strictEqual(
      (dom.window.document.querySelector("#transfer-error") as HTMLElement).hidden,
      false,
    );
    strictEqual(dom.window.document.activeElement?.id, "transfer-error");
    strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "未导入数据。");
    strictEqual(
      dom.window.document.querySelector("#transfer-status")?.textContent?.startsWith("已"),
      false,
    );
    strictEqual(
      dom.window.document.querySelector("#author-total")?.textContent,
      failureCase.error === "storage-unreadable" ? "—" : "1",
    );
  });
}

test("MANAGE-004/AC-089 export uses exact JSON/filename, guards pending actions, and clears stale success on failure", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingExport = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("export-json", pendingExport.promise);
  rpc.push("export-json", createBlacklistRpcResponse("export-json", false, {}, "save-failed"));
  const downloads: Array<{ json: string; filename: string }> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    downloadJson(json, filename) {
      downloads.push({ json, filename });
    },
  });
  await settle();

  const exportButton = dom.window.document.querySelector<HTMLButtonElement>("#export-data");
  if (!exportButton) throw new Error("export button missing");
  exportButton.click();
  exportButton.click();
  strictEqual(rpc.requestCounts.get("export-json"), 1);
  strictEqual(exportButton.disabled, true);
  strictEqual(dom.window.document.querySelector<HTMLInputElement>("#import-file")?.disabled, true);
  strictEqual(
    dom.window.document.querySelector("#transfer-panel")?.getAttribute("aria-busy"),
    "true",
  );
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "正在准备导出…");

  pendingExport.resolve(
    createBlacklistRpcResponse("export-json", true, {
      transfer: TRANSFER,
    }),
  );
  await settle();
  strictEqual(downloads.length, 1);
  deepStrictEqual(JSON.parse(downloads[0]!.json), TRANSFER);
  strictEqual(downloads[0]!.filename, "cocoon-blacklist-2026-08-22.json");
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已导出 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");

  exportButton.click();
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "正在准备导出…");
  await settle();
  strictEqual(downloads.length, 1);
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "未导出数据。");
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "无法导出本地数据，请重试。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-error");
});

test("MANAGE-004/AC-089 export storage failure enters read-only with an explicit storage error", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push(
    "export-json",
    createBlacklistRpcResponse("export-json", false, {}, "storage-unreadable"),
  );
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#export-data")?.click();
  await settle();

  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "未导出数据。");
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。",
  );
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  strictEqual(dom.window.document.querySelector<HTMLButtonElement>("#export-data")?.disabled, true);
});

test("MANAGE production storage listener performs a later validated refresh before re-enabling writes", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", false, {}, "storage-unreadable"));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 0);
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 1);
  strictEqual(
    (dom.window.document.querySelector("#author-list button") as HTMLButtonElement).disabled,
    false,
  );
});
