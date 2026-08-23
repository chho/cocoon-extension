import { doesNotMatch, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const POPUP_HTML = readFileSync(
  new URL("../../popup/popup.html", import.meta.url),
  "utf8",
);
const POPUP_CSS = readFileSync(new URL("./popup.css", import.meta.url), "utf8");

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
    <p id="page-status" data-state="checking" aria-label="页面状态：正在检查…">
      <span class="status-dot" aria-hidden="true"></span><span id="page-status-text">正在检查…</span>
    </p><strong id="count"></strong><span id="count-inline"></span>
    <p id="connection-error"></p><strong id="author-total"></strong><strong id="tag-total"></strong>
    <h2 id="records-title"></h2><input id="search"><p id="data-message"></p><ul id="records"></ul>
    <div id="undo-strip" hidden><button id="undo">撤销</button></div>
    <p id="save-error" hidden></p><button id="manage">管理全部</button>
  </main></body>`, { url: "chrome-extension://runtime/popup/popup.html" });
}

function sourceFixture(): JSDOM {
  return new JSDOM(
    POPUP_HTML.replace("</head>", `<style>${POPUP_CSS}</style></head>`),
    {
      pretendToBeVisual: true,
      url: "chrome-extension://runtime/popup/popup.html",
    },
  );
}

function assertStatusView(
  dom: JSDOM,
  state: "checking" | "running" | "unsupported" | "connection-error",
  label: string,
  color: string,
): void {
  const status = dom.window.document.querySelector<HTMLElement>("#page-status");
  const text = dom.window.document.querySelector<HTMLElement>("#page-status-text");
  const dot = dom.window.document.querySelector<HTMLElement>("#page-status .status-dot");
  if (!status || !text || !dot) throw new Error("status fixture is incomplete");
  strictEqual(status.classList.contains("status"), true);
  strictEqual(status.dataset.state, state);
  strictEqual(status.getAttribute("aria-live"), "polite");
  strictEqual(status.getAttribute("aria-label"), `页面状态：${label}`);
  strictEqual(text.textContent, label);
  strictEqual(status.textContent?.trim(), label);
  strictEqual(dot.tagName, "SPAN");
  strictEqual(dot.getAttribute("aria-hidden"), "true");
  strictEqual(dom.window.getComputedStyle(dot).backgroundColor, color);
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

test("POPUP-010/AC-088 source uses a real hidden status dot with restrained static CSS", () => {
  const dom = sourceFixture();
  assertStatusView(dom, "checking", "正在检查…", "rgb(118, 126, 120)");

  const dotRules = [...POPUP_CSS.matchAll(/[^{}]*\.status-dot[^{}]*\{[^{}]*\}/g)]
    .map(([rule]) => rule)
    .join("\n");
  strictEqual(dotRules.length > 0, true);
  doesNotMatch(dotRules, /animation(?:-name)?\s*:|gradient\(|(?:box-|text-)?shadow\s*:/i);
});

test("POPUP-010/AC-088 keeps the neutral checking state visible while status RPC is pending", async () => {
  const dom = sourceFixture();
  const rpc = new RpcQueue();
  const pendingStatus = deferredResponse();
  rpc.push("status", pendingStatus.promise);
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();

  assertStatusView(dom, "checking", "正在检查…", "rgb(118, 126, 120)");
  pendingStatus.resolve(createBlacklistRpcResponse("status", true, {
    status: "running",
    count: 12,
  }));
  await settle();
  assertStatusView(dom, "running", "运行中", "rgb(63, 112, 79)");
});

for (const statusCase of [
  {
    state: "running" as const,
    label: "运行中",
    count: 1_234,
    color: "rgb(63, 112, 79)",
    connectionError: false,
  },
  {
    state: "unsupported" as const,
    label: "此页面不受支持",
    count: 0,
    color: "rgb(118, 126, 120)",
    connectionError: false,
  },
  {
    state: "connection-error" as const,
    label: "页面连接异常",
    count: 7,
    color: "rgb(162, 77, 56)",
    connectionError: true,
  },
]) {
  test(`POPUP-010/AC-088 renders explicit ${statusCase.state} text, state, and color`, async () => {
    const dom = sourceFixture();
    const rpc = new RpcQueue();
    rpc.push("status", createBlacklistRpcResponse("status", true, {
      status: statusCase.state,
      count: statusCase.count,
    }));
    rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
    bootstrapPopup({
      document: dom.window.document,
      window: dom.window as unknown as Window,
      rpc,
      storageChanges: { addListener() {} },
      async openOptionsPage() {},
    });
    await settle();

    assertStatusView(
      dom,
      statusCase.state,
      statusCase.label,
      statusCase.color,
    );
    strictEqual(dom.window.document.querySelector("#count")?.textContent,
      String(statusCase.count));
    strictEqual(dom.window.document.querySelector("#count-inline")?.textContent,
      String(statusCase.count));
    const error = dom.window.document.querySelector<HTMLElement>("#connection-error");
    strictEqual(error?.hidden, !statusCase.connectionError);
    if (statusCase.connectionError) {
      strictEqual(error?.textContent, "Cocoon 无法连接当前页面。");
    }
  });
}

test("POPUP-010/AC-088 transport failure exposes the connection-error state without color-only labeling", async () => {
  const dom = sourceFixture();
  const rpc = new RpcQueue();
  rpc.push("status", Promise.reject(new Error("disconnected")));
  rpc.push("snapshot", createBlacklistRpcResponse("snapshot", true, { snapshot: EMPTY }));
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {},
  });
  await settle();

  assertStatusView(
    dom,
    "connection-error",
    "页面连接异常",
    "rgb(162, 77, 56)",
  );
  strictEqual(
    dom.window.document.querySelector<HTMLElement>("#connection-error")?.hidden,
    false,
  );
});

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
