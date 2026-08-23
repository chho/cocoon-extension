import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  createBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistSnapshotDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import {
  createBlacklistRpcClient,
  type BlacklistRpcClient,
} from "../ui/background-rpc.ts";
import { bootstrapPopup } from "./app.ts";

const AUTHOR: BlacklistAuthorDto = {
  userId: "author-one",
  memberHashId: null,
  authorName: "Author One",
  tagId: "default",
  blacklistedAt: "2026-08-21T10:00:00.000Z",
  source: "direct",
};
const EMPTY: BlacklistSnapshotDto = {
  authors: [],
  tags: [{ tagId: "default", name: "default", isDefault: true }],
};
const INITIAL: BlacklistSnapshotDto = { ...EMPTY, authors: [AUTHOR] };

function fixture(): JSDOM {
  return new JSDOM(`<!doctype html><body><main>
    <p id="page-status"></p><strong id="count"></strong><span id="count-inline"></span>
    <p id="connection-error"></p><strong id="author-total"></strong><strong id="tag-total"></strong>
    <h2 id="records-title"></h2><input id="search"><p id="data-message"></p><ul id="records"></ul>
    <div id="undo-strip" hidden><button id="undo">撤销</button></div>
    <p id="save-error" hidden></p><button id="manage">管理全部</button>
  </main></body>`, { url: "chrome-extension://runtime/popup/popup.html" });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

class RpcQueue implements BlacklistRpcClient {
  readonly responses = new Map<BlacklistRpcOperation, Array<Promise<BlacklistRpcResponse>>>();

  push(operation: BlacklistRpcOperation, response: BlacklistRpcResponse | Promise<BlacklistRpcResponse>): void {
    const queue = this.responses.get(operation) ?? [];
    queue.push(Promise.resolve(response));
    this.responses.set(operation, queue);
  }

  async request(operation: BlacklistRpcOperation): Promise<BlacklistRpcResponse> {
    const response = this.responses.get(operation)?.shift();
    if (!response) throw new Error(`missing ${operation} response`);
    return response;
  }

  removeOne(): Promise<BlacklistRpcResponse> { return this.request("remove-one"); }
  restoreOne(): Promise<BlacklistRpcResponse> { return this.request("restore-one"); }
}

function deferredResponse() {
  let resolve: ((value: BlacklistRpcResponse) => void) | undefined;
  const promise = new Promise<BlacklistRpcResponse>((done) => { resolve = done; });
  return { promise, resolve: (value: BlacklistRpcResponse) => resolve?.(value) };
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();

  schedule(callback: () => void, delay: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { due: this.now + delay, callback });
    return id;
  }

  cancel(id: number): void {
    this.tasks.delete(id);
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.due;
      task.callback();
    }
    this.now = target;
  }
}

function installFakeClock(dom: JSDOM): FakeClock {
  const clock = new FakeClock();
  Object.defineProperty(dom.window, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay = 0) => clock.schedule(callback, delay),
  });
  Object.defineProperty(dom.window, "clearTimeout", {
    configurable: true,
    value: (id: number) => clock.cancel(id),
  });
  return clock;
}

function assertUndoState(dom: JSDOM, visible: boolean): void {
  const strip = dom.window.document.querySelector<HTMLElement>("#undo-strip");
  const button = dom.window.document.querySelector<HTMLButtonElement>("#undo");
  strictEqual(strip?.hidden, !visible);
  strictEqual(button?.disabled, !visible);
}

test("BUG-014/AC-085 Popup accepts nullable member aliases through the strict RPC client", async () => {
  const dom = fixture();
  const strictRpc = createBlacklistRpcClient(async (message) => {
    const operation = (message as { operation?: unknown }).operation;
    if (operation === "status") {
      return createBlacklistRpcResponse("status", true, {
        status: "running",
        count: 1,
      });
    }
    return createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL });
  });
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc: strictRpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();

  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(dom.window.document.querySelector("#tag-total")?.textContent, "1");
  strictEqual(dom.window.document.querySelectorAll("#records li").length, 1);
});

test("POPUP production bootstrap coalesces storage and mutation refreshes to the newest snapshot", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 3 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    async openOptionsPage() {},
  });
  await settle();

  const stale = deferredResponse();
  rpc.push("snapshot", stale.promise);
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", true, {
    snapshot: EMPTY,
    removed: AUTHOR,
  }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  listeners[0]?.({ cocoonBlacklistState: {} }, "local");
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  stale.resolve(createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  await settle();

  strictEqual(dom.window.document.querySelector("#records")?.textContent?.includes("Author One"), false);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "0");
  strictEqual((dom.window.document.querySelector("#undo-strip") as HTMLElement).hidden, false);
});

test("POPUP removal refresh completed before eight seconds starts a full live undo window on display", async () => {
  const dom = fixture();
  const clock = installFakeClock(dom);
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();

  const refreshed = deferredResponse();
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", true, {
    snapshot: EMPTY,
    removed: AUTHOR,
  }));
  rpc.push("snapshot", refreshed.promise);
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  clock.advance(4_000);
  assertUndoState(dom, false);

  refreshed.resolve(createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  await settle();
  assertUndoState(dom, true);
  clock.advance(7_999);
  assertUndoState(dom, true);
  clock.advance(1);
  assertUndoState(dom, false);
});

test("POPUP removal refresh completed after eight seconds never shows a dead undo and still gets eight seconds", async () => {
  const dom = fixture();
  const clock = installFakeClock(dom);
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();

  const refreshed = deferredResponse();
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", true, {
    snapshot: EMPTY,
    removed: AUTHOR,
  }));
  rpc.push("snapshot", refreshed.promise);
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  clock.advance(8_000);
  assertUndoState(dom, false);

  refreshed.resolve(createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  await settle();
  assertUndoState(dom, true);
  clock.advance(7_999);
  assertUndoState(dom, true);
  clock.advance(1);
  assertUndoState(dom, false);
});

test("POPUP does not expose undo when the post-removal refresh is unreadable", async () => {
  const dom = fixture();
  installFakeClock(dom);
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", true, {
    snapshot: EMPTY,
    removed: AUTHOR,
  }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", false, {}, "storage-unreadable"));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  assertUndoState(dom, false);
  strictEqual(dom.window.document.querySelector("#data-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。");
});

test("POPUP does not expose undo when the refreshed snapshot has an intervening identity conflict", async () => {
  const dom = fixture();
  installFakeClock(dom);
  const rpc = new RpcQueue();
  const conflict = {
    ...AUTHOR,
    authorName: "Replacement",
    tagId: "default",
  };
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", true, {
    snapshot: EMPTY,
    removed: AUTHOR,
  }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, {
    snapshot: { ...EMPTY, authors: [conflict] },
  }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  assertUndoState(dom, false);
});

test("POPUP contains openOptionsPage rejection in its local alert", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "unsupported", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() { throw new Error("open failed"); },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#manage")?.click();
  await settle();
  const error = dom.window.document.querySelector<HTMLElement>("#save-error");
  strictEqual(error?.hidden, false);
  strictEqual(error?.textContent, "无法打开管理页，请重试。");
});

test("POPUP storage-unreadable mutation immediately clears undo and all write actions", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.push("status", createBlacklistRpcResponse("status", true, { status: "running", count: 0 }));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: INITIAL }));
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", false, {}, "storage-unreadable"));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();

  strictEqual(dom.window.document.querySelector("#data-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。");
  strictEqual(dom.window.document.querySelectorAll("#records button").length, 0);
  strictEqual((dom.window.document.querySelector("#undo-strip") as HTMLElement).hidden, true);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
});
