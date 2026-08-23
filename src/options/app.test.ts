import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  createBlacklistRpcResponse,
  type BlacklistSnapshotDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import {
  createBlacklistRpcClient,
  type BlacklistRpcClient,
} from "../ui/background-rpc.ts";
import { bootstrapOptions } from "./app.ts";

const SNAPSHOT: BlacklistSnapshotDto = {
  authors: [{
    platformId: "zhihu",
    userId: "author-one",
    memberHashId: null,
    authorName: "Author One",
    tagId: "tag-one",
    blacklistedAt: "2026-08-21T10:00:00.000Z",
    source: "direct",
  }],
  tags: [
    { tagId: "default", name: "default", isDefault: true },
    { tagId: "tag-one", name: "Persisted", isDefault: false },
  ],
};

function fixture(): JSDOM {
  const dom = new JSDOM(`<!doctype html><body>
    <span id="author-total"></span><span id="tag-total"></span>
    <p id="page-message"></p><p id="write-error" tabindex="-1" hidden></p>
    <input id="author-search"><select id="tag-filter"></select><select id="platform-filter"></select>
    <select id="time-sort"><option value="desc">desc</option><option value="asc">asc</option></select>
    <button id="remove-selected"></button>
    <div id="author-viewport" tabindex="0"><div id="author-list"></div></div>
    <p id="list-summary"></p><h2 id="tags-heading" tabindex="-1"></h2><p id="tag-summary"></p><div id="tag-list"></div>
    <dialog id="batch-dialog"><p id="batch-dialog-description"></p>
      <button id="batch-cancel"></button><button id="batch-confirm"></button>
    </dialog>
  </body>`, {
    pretendToBeVisual: true,
    url: "chrome-extension://runtime/options/options.html",
  });
  for (const dialog of dom.window.document.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  return dom;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function deferredResponse() {
  let resolve: ((value: BlacklistRpcResponse) => void) | undefined;
  const promise = new Promise<BlacklistRpcResponse>((done) => { resolve = done; });
  return { promise, resolve: (value: BlacklistRpcResponse) => resolve?.(value) };
}

class RpcQueue implements BlacklistRpcClient {
  readonly responses = new Map<
    BlacklistRpcOperation,
    Array<Promise<BlacklistRpcResponse>>
  >();
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
    requestFrame(callback) { callback(); return 1; },
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
  rpc.push("rename-tag", createBlacklistRpcResponse("rename-tag", false, { snapshot: SNAPSHOT }, "invalid-tag"));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
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
  editable.closest("form")?.dispatchEvent(new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  await settle();

  const rerenderedName = dom.window.document.querySelector("#tag-list .tag-display-name");
  strictEqual(rerenderedName?.textContent, "Persisted");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 1);
  strictEqual(dom.window.document.querySelector("#tag-list")?.textContent?.includes("default"), false);
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );
  strictEqual(dom.window.document.querySelector("#write-error")?.textContent,
    "标签名称无效或已存在。");
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, false);

  dom.window.document.querySelector<HTMLButtonElement>("#author-list button")?.click();
  await settle();
  strictEqual(dom.window.document.querySelector("#page-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。");
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 0);
  strictEqual(dom.window.document.querySelectorAll("#tag-list button").length, 0);
  strictEqual((dom.window.document.querySelector("#remove-selected") as HTMLButtonElement).disabled, true);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);
  strictEqual(rpc.requestCounts.get("remove-one"), 1);
});

test("MANAGE-003/AC-087 failed delete rolls back and restores the equivalent action", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("delete-tag", createBlacklistRpcResponse(
    "delete-tag",
    false,
    { snapshot: SNAPSHOT },
    "save-failed",
  ));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
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
  rpc.push("delete-tag", createBlacklistRpcResponse(
    "delete-tag",
    false,
    {},
    "storage-unreadable",
  ));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
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

test("MANAGE-003/AC-087 successful rename with unreadable refresh focuses the section fallback", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [SNAPSHOT.tags[0]!, { ...SNAPSHOT.tags[1]!, name: "Updated" }],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("rename-tag", createBlacklistRpcResponse("rename-tag", true, { snapshot: renamed }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  )?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.closest("form")?.dispatchEvent(new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
});

test("MANAGE-003/AC-087 successful delete with unreadable refresh focuses the section fallback", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const defaultOnly: BlacklistSnapshotDto = {
    authors: [{ ...SNAPSHOT.authors[0]!, tagId: "default" }],
    tags: [SNAPSHOT.tags[0]!],
  };
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: SNAPSHOT }));
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", true, { snapshot: defaultOnly }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();
  const successfulUnreadableDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  successfulUnreadableDelete?.focus();
  successfulUnreadableDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
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
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  )?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.closest("form")?.dispatchEvent(new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  await settle();
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Updated");
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Updated",
  );
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
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
  strictEqual(dom.window.document.querySelector(".tag-empty")?.textContent?.includes("暂无自定义标签"), true);
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
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
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  )?.focus();
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "删除标签 Persisted",
  );

  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  )?.click();
  strictEqual(dom.window.document.activeElement?.tagName, "INPUT");
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );

  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  )?.focus();
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
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
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  )?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(dom.window.document.activeElement, save);
  strictEqual(save.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);

  pendingRename.resolve(createBlacklistRpcResponse("rename-tag", true, {
    snapshot: renamed,
  }));
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
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();
  const remove = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  remove?.focus();
  remove?.click();
  strictEqual(dom.window.document.activeElement, remove);
  strictEqual(remove?.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);

  pendingDelete.resolve(createBlacklistRpcResponse("delete-tag", false, {
    snapshot: SNAPSHOT,
  }, "save-failed"));
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
    tags: [
      ...SNAPSHOT.tags,
      { tagId: "tag-two", name: "Second", isDefault: false },
    ],
  };
  const renamed: BlacklistSnapshotDto = {
    ...initial,
    tags: [
      initial.tags[0]!,
      { ...initial.tags[1]!, name: "Updated" },
      initial.tags[2]!,
    ],
  };
  const pendingRename = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  rpc.push("rename-tag", pendingRename.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: renamed }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  )?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  const newerFocus = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Second']",
  );
  newerFocus?.focus();
  pendingRename.resolve(createBlacklistRpcResponse("rename-tag", true, {
    snapshot: renamed,
  }));
  await settle();
  strictEqual(dom.window.document.activeElement?.getAttribute("aria-label"), "删除标签 Second");
});

test("MANAGE-003/AC-087 stale delete failure never steals newer tag focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const initial: BlacklistSnapshotDto = {
    ...SNAPSHOT,
    tags: [
      ...SNAPSHOT.tags,
      { tagId: "tag-two", name: "Second", isDefault: false },
    ],
  };
  const pendingDelete = deferredResponse();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  rpc.push("delete-tag", pendingDelete.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: initial }));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) { callback(); return 1; },
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
  pendingDelete.resolve(createBlacklistRpcResponse("delete-tag", false, {
    snapshot: initial,
  }, "save-failed"));
  await settle();
  strictEqual(
    dom.window.document.activeElement?.getAttribute("aria-label"),
    "重命名标签 Second",
  );
});

test("PROFILE-001/AC-086 management links profiles and preserves tag filtering across refreshes", async () => {
  const internalUserId = "private-user-token-91";
  const internalMemberHash = "abcdef0123456789abcdef0123456789";
  const internalTagId = "private-tag-token-73";
  const otherTagId = "private-tag-token-84";
  const privateSnapshot: BlacklistSnapshotDto = {
    authors: [
      {
        platformId: "zhihu",
        userId: internalUserId,
        memberHashId: internalMemberHash,
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
  const refreshedSnapshot: BlacklistSnapshotDto = {
    ...privateSnapshot,
    tags: [privateSnapshot.tags[2]!, privateSnapshot.tags[0]!, privateSnapshot.tags[1]!],
  };
  const removedTagSnapshot: BlacklistSnapshotDto = {
    authors: [
      { ...privateSnapshot.authors[0]!, tagId: "default" },
      privateSnapshot.authors[1]!,
    ],
    tags: [privateSnapshot.tags[0]!, privateSnapshot.tags[2]!],
  };
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: privateSnapshot }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: refreshedSnapshot }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: removedTagSnapshot }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  const assertProfileLinks = (expectedUserIds: readonly string[]): void => {
    const links = Array.from(
      dom.window.document.querySelectorAll<HTMLAnchorElement>("a.author-name"),
    );
    strictEqual(links.length, expectedUserIds.length);
    strictEqual(
      links.map((link) => link.href).sort().join("|"),
      expectedUserIds.map((userId) =>
        `https://www.zhihu.com/people/${userId}`
      ).sort().join("|"),
    );
    for (const link of links) {
      strictEqual(link.target, "_blank");
      strictEqual(link.rel, "noopener");
    }
  };
  assertProfileLinks([internalUserId, "private-user-token-92"]);
  strictEqual(dom.window.document.querySelector("#tag-summary")?.textContent, "2 个自定义标签");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 2);
  strictEqual(dom.window.document.querySelector("#tag-list")?.textContent?.includes("default"), false);

  const filter = dom.window.document.querySelector<HTMLSelectElement>("#tag-filter");
  const readingOption = [...(filter?.options ?? [])].find((option) => option.textContent === "Reading");
  if (!filter || !readingOption) throw new Error("tag filter option missing");
  strictEqual(
    [...filter.options].some((option) => option.textContent === "default"),
    true,
  );
  filter.value = readingOption.value;
  filter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(dom.window.document.querySelector("#author-list")?.textContent?.includes("Filtered Author"), true);
  strictEqual(dom.window.document.querySelector("#author-list")?.textContent?.includes("Other Author"), false);

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(dom.window.document.querySelector("#author-list")?.textContent?.includes("Filtered Author"), true);
  strictEqual(filter.selectedOptions[0]?.textContent, "Reading");
  assertProfileLinks([internalUserId]);

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(filter.value, "");
  strictEqual(filter.selectedOptions[0]?.textContent, "全部标签");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 2);
  assertProfileLinks([internalUserId, "private-user-token-92"]);
});

test("PLATFORM-001/AC-090 management renders an independent platform column/filter through composed storage refreshes", async () => {
  const multiPlatform: BlacklistSnapshotDto = {
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
  const refreshed: BlacklistSnapshotDto = {
    tags: multiPlatform.tags.map((tag) => ({ ...tag })),
    authors: [
      ...multiPlatform.authors.map((author) => ({ ...author })),
      {
        ...multiPlatform.authors[1]!,
        userId: "third-user",
        authorName: "Video Middle",
        blacklistedAt: "2026-08-21T09:00:00.000Z",
      },
    ],
  };
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, {
    snapshot: multiPlatform,
  }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, {
    snapshot: refreshed,
  }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  const platformFilter = dom.window.document.querySelector<HTMLSelectElement>(
    "#platform-filter",
  );
  const tagFilter = dom.window.document.querySelector<HTMLSelectElement>("#tag-filter");
  const search = dom.window.document.querySelector<HTMLInputElement>("#author-search");
  const sort = dom.window.document.querySelector<HTMLSelectElement>("#time-sort");
  if (!platformFilter || !tagFilter || !search || !sort) {
    throw new Error("filter controls missing");
  }
  const expectedPlatformLabels = ["future-site", "YouTube", "知乎"]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  deepStrictEqual(
    [...platformFilter.options].map((option) => option.textContent),
    ["全部站点", ...expectedPlatformLabels],
  );
  const rows = Array.from(
    dom.window.document.querySelectorAll<HTMLElement>("#author-list .author-row"),
  );
  const futureRow = rows.find((row) => row.textContent?.includes("Future Author"));
  strictEqual(futureRow?.querySelector(".platform-name")?.textContent, "future-site");
  strictEqual(futureRow?.querySelector(".source-name")?.textContent, "手动屏蔽");
  strictEqual(futureRow?.querySelector("a.author-name"), null);
  const plainFuture = futureRow?.querySelector<HTMLElement>("span.author-name");
  strictEqual(plainFuture?.tabIndex, -1);
  strictEqual(plainFuture?.hasAttribute("href"), false);
  const zhihu = rows.find((row) => row.textContent?.includes("Video Zhihu"))
    ?.querySelector<HTMLAnchorElement>("a.author-name");
  strictEqual(
    zhihu?.href,
    "https://www.zhihu.com/people/zhihu%2Fencoded%20user",
  );
  strictEqual(zhihu?.target, "_blank");
  strictEqual(zhihu?.rel, "noopener");

  const youtubeOption = [...platformFilter.options]
    .find((option) => option.textContent === "YouTube");
  const readingOption = [...tagFilter.options]
    .find((option) => option.textContent === "Persisted");
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
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name"))
      .map((name) => name.textContent),
    ["Video Older", "Video Newer"],
  );
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .source-name"))
      .map((source) => source.textContent),
    ["来自点赞者", "手动屏蔽"],
  );
  strictEqual(dom.window.document.querySelectorAll("#author-list a.author-name").length, 0);

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(platformFilter.selectedOptions[0]?.textContent, "YouTube");
  strictEqual(tagFilter.selectedOptions[0]?.textContent, "Persisted");
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name"))
      .map((name) => name.textContent),
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
    requestFrame(callback) { callback(); return 1; },
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
  strictEqual(
    (dom.window.document.activeElement as HTMLAnchorElement).href,
    originalFocus?.href,
  );

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const youtube = [...(platform?.options ?? [])]
    .find((option) => option.textContent === "YouTube");
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
    requestFrame(callback) { callback(); return 1; },
  });
  await settle();

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const zhihuOption = [...(platform?.options ?? [])]
    .find((option) => option.textContent === "知乎");
  if (!platform || !zhihuOption) throw new Error("Zhihu filter missing");
  platform.value = zhihuOption.value;
  platform.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  const list = dom.window.document.querySelector<HTMLElement>("#author-list");
  if (!list) throw new Error("list missing");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(list.querySelectorAll(".author-row").length < 50, true);
  const focused = list.querySelectorAll<HTMLAnchorElement>("a.author-name").item(3);
  focused.focus();

  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  await settle();
  strictEqual(platform.selectedOptions[0]?.textContent, "知乎");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(dom.window.document.activeElement?.tagName, "A");
  strictEqual(dom.window.document.activeElement === focused, false);
  strictEqual((dom.window.document.activeElement as HTMLAnchorElement).href, focused.href);
  strictEqual(list.querySelectorAll("span.author-name").length, 0);
});
