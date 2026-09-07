import { doesNotMatch, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  createBlacklistQueryResponse,
  type BlacklistAuthorListItemDto,
  type BlacklistQueryRequest,
  type BlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import {
  createBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import type { BlacklistChangeEventSource } from "../core/blacklist-revision-contract.ts";
import { createBlacklistRpcClient, type StrictBlacklistRpcClient } from "../ui/background-rpc.ts";
import { bootstrapPopup } from "./app.ts";

const POPUP_HTML = readFileSync(new URL("../../popup/popup.html", import.meta.url), "utf8");
const POPUP_CSS = readFileSync(new URL("./popup.css", import.meta.url), "utf8");
const DEFAULT_TAG = { tagId: "default", name: "default", isDefault: true } as const;
const AUTHOR: BlacklistAuthorDto = {
  platformId: "zhihu",
  userId: "author-one",
  memberHashId: null,
  authorName: "Author One",
  tagId: "default",
  blacklistedAt: "2026-08-21T10:00:00.000Z",
  source: "direct",
};
const AUTHOR_ITEM: BlacklistAuthorListItemDto = { author: AUTHOR, tag: DEFAULT_TAG };

type QueryOperation = BlacklistQueryRequest["operation"];
type StorageChangeListener = Parameters<BlacklistChangeEventSource["addListener"]>[0];

function fixture(): JSDOM {
  return new JSDOM(
    `<!doctype html><body><main>
    <p id="page-status" class="status" data-state="checking" aria-label="页面状态：正在检查…" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span><span id="page-status-text">正在检查…</span>
    </p><strong id="count"></strong><span id="count-inline"></span>
    <p id="connection-error" hidden>Cocoon 无法连接当前页面。</p>
    <strong id="author-total"></strong><strong id="tag-total"></strong>
    <h2 id="records-title"></h2><input id="search"><p id="data-message"></p><ul id="records"></ul>
    <div id="undo-strip" hidden><button id="undo">撤销</button></div>
    <p id="save-error" hidden></p><button id="manage">管理全部</button>
  </main></body>`,
    { url: "chrome-extension://runtime/popup/popup.html" },
  );
}

function sourceFixture(): JSDOM {
  return new JSDOM(POPUP_HTML.replace("</head>", `<style>${POPUP_CSS}</style></head>`), {
    pretendToBeVisual: true,
    url: "chrome-extension://runtime/popup/popup.html",
  });
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
  strictEqual(status.dataset.state, state);
  strictEqual(status.getAttribute("aria-live"), "polite");
  strictEqual(status.getAttribute("aria-label"), `页面状态：${label}`);
  strictEqual(text.textContent, label);
  strictEqual(dot.getAttribute("aria-hidden"), "true");
  strictEqual(dom.window.getComputedStyle(dot).backgroundColor, color);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: Value) => resolve?.(value) };
}

class RpcQueue implements StrictBlacklistRpcClient {
  readonly rpcResponses = new Map<BlacklistRpcOperation, Array<Promise<BlacklistRpcResponse>>>();
  readonly queryResponses = new Map<QueryOperation, Array<Promise<BlacklistQueryResponse>>>();
  readonly queryRequests: BlacklistQueryRequest[] = [];
  readonly managementRequests: BlacklistRpcOperation[] = [];

  pushRpc(
    operation: BlacklistRpcOperation,
    response: BlacklistRpcResponse | Promise<BlacklistRpcResponse>,
  ): void {
    const queue = this.rpcResponses.get(operation) ?? [];
    queue.push(Promise.resolve(response));
    this.rpcResponses.set(operation, queue);
  }

  pushQuery(
    operation: QueryOperation,
    response: BlacklistQueryResponse | Promise<BlacklistQueryResponse>,
  ): void {
    const queue = this.queryResponses.get(operation) ?? [];
    queue.push(Promise.resolve(response));
    this.queryResponses.set(operation, queue);
  }

  async request(
    operation: BlacklistRpcOperation,
    input: Record<string, unknown> = {},
  ): Promise<BlacklistRpcResponse> {
    void input;
    this.managementRequests.push(operation);
    const response = this.rpcResponses.get(operation)?.shift();
    if (!response) throw new Error(`missing ${operation} response`);
    return await response;
  }

  async query(request: BlacklistQueryRequest): Promise<BlacklistQueryResponse> {
    this.queryRequests.push(request);
    const response = this.queryResponses.get(request.operation)?.shift();
    if (!response) throw new Error(`missing ${request.operation} response`);
    return await response;
  }

  removeOne(identity: Parameters<StrictBlacklistRpcClient["removeOne"]>[0]) {
    return this.request("remove-one", { identity });
  }

  restoreOne(author: Parameters<StrictBlacklistRpcClient["restoreOne"]>[0]) {
    return this.request("restore-one", { author });
  }
}

function queueStatus(
  rpc: RpcQueue,
  status: "running" | "unsupported" | "connection-error" = "running",
  count = 0,
): void {
  rpc.pushRpc("status", createBlacklistRpcResponse("status", true, { status, count }));
}

function queueData(
  rpc: RpcQueue,
  revision: number,
  items: readonly BlacklistAuthorListItemDto[],
  counts: { readonly authorCount?: number; readonly tagCount?: number } = {},
): void {
  const authorCount = counts.authorCount ?? items.length;
  const tagCount = counts.tagCount ?? 1;
  rpc.pushQuery(
    "summary",
    createBlacklistQueryResponse("summary", true, { revision, authorCount, tagCount }),
  );
  rpc.pushQuery(
    "authors-page",
    createBlacklistQueryResponse("authors-page", true, {
      revision,
      authorCount,
      tagCount,
      items,
      nextCursor: items.length ? "bounded-next-page" : null,
      totalCount: authorCount,
    }),
  );
}

function bootstrap(
  dom: JSDOM,
  rpc: StrictBlacklistRpcClient,
  listeners: StorageChangeListener[] = [],
) {
  return bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    async openOptionsPage() {},
  });
}

class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { due: number; callback: () => void }>();

  schedule(callback: () => void, delay: number): number {
    const id = this.nextId++;
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

test("POPUP-010/AC-088 keeps checking visible while status RPC is pending", async () => {
  const dom = sourceFixture();
  const rpc = new RpcQueue();
  const pendingStatus = deferred<BlacklistRpcResponse>();
  rpc.pushRpc("status", pendingStatus.promise);
  queueData(rpc, 1, []);
  bootstrap(dom, rpc);
  await settle();
  assertStatusView(dom, "checking", "正在检查…", "rgb(118, 126, 120)");
  pendingStatus.resolve(
    createBlacklistRpcResponse("status", true, { status: "running", count: 12 }),
  );
  await settle();
  assertStatusView(dom, "running", "运行中", "rgb(63, 112, 79)");
});

for (const statusCase of [
  ["running", "运行中", 1_234, "rgb(63, 112, 79)", false],
  ["unsupported", "此页面不受支持", 0, "rgb(118, 126, 120)", false],
  ["connection-error", "页面连接异常", 7, "rgb(162, 77, 56)", true],
] as const) {
  test(`POPUP-010/AC-088 renders explicit ${statusCase[0]} status`, async () => {
    const dom = sourceFixture();
    const rpc = new RpcQueue();
    queueStatus(rpc, statusCase[0], statusCase[2]);
    queueData(rpc, 1, []);
    bootstrap(dom, rpc);
    await settle();
    assertStatusView(dom, statusCase[0], statusCase[1], statusCase[3]);
    strictEqual(dom.window.document.querySelector("#count")?.textContent, String(statusCase[2]));
    strictEqual(
      dom.window.document.querySelector<HTMLElement>("#connection-error")?.hidden,
      !statusCase[4],
    );
  });
}

test("POPUP-010/AC-088 status transport failure remains explicit", async () => {
  const dom = sourceFixture();
  const rpc = new RpcQueue();
  rpc.pushRpc("status", Promise.reject(new Error("disconnected")));
  queueData(rpc, 1, []);
  bootstrap(dom, rpc);
  await settle();
  assertStatusView(dom, "connection-error", "页面连接异常", "rgb(162, 77, 56)");
});

test("BUG-016 bootstrap requests only bounded summary and recent author data", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc, "running", 9);
  queueData(rpc, 7, [AUTHOR_ITEM], { authorCount: 33_524, tagCount: 3 });
  bootstrap(dom, rpc);
  await settle();

  strictEqual(rpc.managementRequests.join(","), "status");
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "33524");
  strictEqual(dom.window.document.querySelector("#tag-total")?.textContent, "3");
  strictEqual(dom.window.document.querySelectorAll("#records li.record").length, 1);
  const page = rpc.queryRequests.find((request) => request.operation === "authors-page");
  strictEqual(page?.input.limit, 5);
  strictEqual(page?.input.searchScope, "author-or-tag");
  strictEqual("authors" in (rpc.queryRequests[0]?.input ?? {}), false);
});

test("BUG-016 recent/search preserves null aliases, platform links, and initial focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const zhihu = {
    author: { ...AUTHOR, userId: "author/with ?query#fragment%", authorName: "Zhihu Author" },
    tag: DEFAULT_TAG,
  };
  const youtube = {
    author: { ...AUTHOR, platformId: "youtube", userId: "same", authorName: "YouTube Author" },
    tag: { tagId: "watch", name: "Watching", isDefault: false },
  };
  queueStatus(rpc);
  queueData(rpc, 4, [zhihu, youtube]);
  bootstrap(dom, rpc);
  await settle();

  strictEqual(dom.window.document.activeElement?.id, "search");
  const link = dom.window.document.querySelector<HTMLAnchorElement>("#records a.author-name");
  strictEqual(link?.href, "https://www.zhihu.com/people/author%2Fwith%20%3Fquery%23fragment%25");
  strictEqual(
    dom.window.document.querySelector("#records span.author-name")?.textContent,
    "YouTube Author",
  );

  queueData(rpc, 4, [youtube], { authorCount: 2, tagCount: 2 });
  const search = dom.window.document.querySelector<HTMLInputElement>("#search")!;
  search.value = "watch";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();
  const page = rpc.queryRequests.at(-1);
  strictEqual(page?.operation, "authors-page");
  strictEqual(page?.input.limit, 50);
  strictEqual(page?.input.search, "watch");
  strictEqual(dom.window.document.querySelectorAll("#records a.author-name").length, 0);
  strictEqual(
    dom.window.document.querySelector("#records span.author-name")?.textContent,
    "YouTube Author",
  );
});

test("BUG-016 rapid search input never lets an older query overwrite the latest search", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  bootstrap(dom, rpc);
  await settle();

  const oldSummary = deferred<BlacklistQueryResponse>();
  rpc.pushQuery("summary", oldSummary.promise);
  rpc.pushQuery(
    "authors-page",
    createBlacklistQueryResponse("authors-page", true, {
      revision: 1,
      authorCount: 2,
      tagCount: 1,
      items: [{ ...AUTHOR_ITEM, author: { ...AUTHOR, authorName: "Old result" } }],
      nextCursor: null,
      totalCount: 1,
    }),
  );
  queueData(
    rpc,
    1,
    [{ ...AUTHOR_ITEM, author: { ...AUTHOR, userId: "new", authorName: "New result" } }],
    { authorCount: 2 },
  );
  const search = dom.window.document.querySelector<HTMLInputElement>("#search")!;
  search.value = "old";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  search.value = "new";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  oldSummary.resolve(
    createBlacklistQueryResponse("summary", true, { revision: 1, authorCount: 2, tagCount: 1 }),
  );
  await settle();

  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("Old result"),
    false,
  );
  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("New result"),
    true,
  );
});

test("BUG-016 newer revision wins while older pending queries and signals stay inert", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const listeners: StorageChangeListener[] = [];
  queueStatus(rpc);
  queueData(rpc, 5, [AUTHOR_ITEM]);
  bootstrap(dom, rpc, listeners);
  await settle();

  const oldSummary = deferred<BlacklistQueryResponse>();
  rpc.pushQuery("summary", oldSummary.promise);
  rpc.pushQuery(
    "authors-page",
    createBlacklistQueryResponse("authors-page", true, {
      revision: 7,
      authorCount: 1,
      tagCount: 1,
      items: [{ ...AUTHOR_ITEM, author: { ...AUTHOR, authorName: "Revision seven" } }],
      nextCursor: null,
      totalCount: 1,
    }),
  );
  queueData(rpc, 8, [{ ...AUTHOR_ITEM, author: { ...AUTHOR, authorName: "Revision eight" } }]);
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 7 } } }, "local");
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 8 } } }, "local");
  oldSummary.resolve(
    createBlacklistQueryResponse("summary", true, { revision: 7, authorCount: 1, tagCount: 1 }),
  );
  await settle();
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 6 } } }, "local");
  await settle();

  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("Revision eight"),
    true,
  );
  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("Revision seven"),
    false,
  );
});

test("BUG-016 stale cursor retries from summary and first page exactly once", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc);
  rpc.pushQuery(
    "summary",
    createBlacklistQueryResponse("summary", true, { revision: 2, authorCount: 1, tagCount: 1 }),
  );
  rpc.pushQuery(
    "authors-page",
    createBlacklistQueryResponse("authors-page", false, null, "stale-cursor"),
  );
  queueData(rpc, 3, [AUTHOR_ITEM]);
  bootstrap(dom, rpc);
  await settle();
  strictEqual(rpc.queryRequests.filter(({ operation }) => operation === "summary").length, 2);
  strictEqual(rpc.queryRequests.filter(({ operation }) => operation === "authors-page").length, 2);
  strictEqual(dom.window.document.querySelectorAll("#records li.record").length, 1);
});

test("BUG-016 repeated stale cursor fails stably without blind retries", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    rpc.pushQuery(
      "summary",
      createBlacklistQueryResponse("summary", true, {
        revision: attempt,
        authorCount: 1,
        tagCount: 1,
      }),
    );
    rpc.pushQuery(
      "authors-page",
      createBlacklistQueryResponse("authors-page", false, null, "stale-cursor"),
    );
  }
  bootstrap(dom, rpc);
  await settle();
  strictEqual(rpc.queryRequests.length, 4);
  strictEqual(
    dom.window.document.querySelector("#data-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。",
  );
});

test("BUG-016 remove delta starts a complete eight-second undo and focuses it", async () => {
  const dom = fixture();
  const clock = installFakeClock(dom);
  const rpc = new RpcQueue();
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  rpc.pushRpc(
    "remove-one",
    createBlacklistRpcResponse("remove-one", true, {
      revision: 2,
      authorCount: 0,
      tagCount: 1,
      removed: AUTHOR,
    }),
  );
  queueData(rpc, 2, [], { authorCount: 0 });
  bootstrap(dom, rpc);
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();

  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "0");
  strictEqual(dom.window.document.querySelectorAll("#records li.record").length, 0);
  assertUndoState(dom, true);
  strictEqual(dom.window.document.activeElement?.id, "undo");
  clock.advance(7_999);
  assertUndoState(dom, true);
  clock.advance(1);
  assertUndoState(dom, false);
});

test("BUG-016 delayed removal starts undo only after its delta commits", async () => {
  const dom = fixture();
  const clock = installFakeClock(dom);
  const rpc = new RpcQueue();
  const removal = deferred<BlacklistRpcResponse>();
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  rpc.pushRpc("remove-one", removal.promise);
  queueData(rpc, 2, [], { authorCount: 0 });
  bootstrap(dom, rpc);
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  clock.advance(8_000);
  assertUndoState(dom, false);
  removal.resolve(
    createBlacklistRpcResponse("remove-one", true, {
      revision: 2,
      authorCount: 0,
      tagCount: 1,
      removed: AUTHOR,
    }),
  );
  await settle();
  assertUndoState(dom, true);
  clock.advance(8_000);
  assertUndoState(dom, false);
});

test("BUG-016 restore delta coordinates locally, clears undo, and restores search focus", async () => {
  const dom = fixture();
  installFakeClock(dom);
  const rpc = new RpcQueue();
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  rpc.pushRpc(
    "remove-one",
    createBlacklistRpcResponse("remove-one", true, {
      revision: 2,
      authorCount: 0,
      tagCount: 1,
      removed: AUTHOR,
    }),
  );
  rpc.pushRpc(
    "restore-one",
    createBlacklistRpcResponse("restore-one", true, {
      revision: 3,
      authorCount: 1,
      tagCount: 1,
    }),
  );
  queueData(rpc, 2, [], { authorCount: 0 });
  queueData(rpc, 3, [AUTHOR_ITEM]);
  bootstrap(dom, rpc);
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#undo")?.click();
  await settle();

  assertUndoState(dom, false);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("Author One"),
    true,
  );
  strictEqual(dom.window.document.activeElement?.id, "search");
});

test("BUG-016 an older pending removal delta cannot overwrite a newer revision refresh", async () => {
  const dom = fixture();
  installFakeClock(dom);
  const rpc = new RpcQueue();
  const removal = deferred<BlacklistRpcResponse>();
  const listeners: StorageChangeListener[] = [];
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  rpc.pushRpc("remove-one", removal.promise);
  bootstrap(dom, rpc, listeners);
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();

  const laterItems = [{ ...AUTHOR_ITEM, author: { ...AUTHOR, authorName: "Later authority" } }];
  queueData(rpc, 3, laterItems);
  queueData(rpc, 3, laterItems);
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 3 } } }, "local");
  await settle();
  removal.resolve(
    createBlacklistRpcResponse("remove-one", true, {
      revision: 2,
      authorCount: 0,
      tagCount: 1,
      removed: AUTHOR,
    }),
  );
  await settle();

  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(
    dom.window.document.querySelector("#records")?.textContent?.includes("Later authority"),
    true,
  );
  assertUndoState(dom, false);
});

test("BUG-016 storage-unreadable mutation clears records, writes, and undo", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc);
  queueData(rpc, 1, [AUTHOR_ITEM]);
  rpc.pushRpc(
    "remove-one",
    createBlacklistRpcResponse("remove-one", false, {}, "storage-unreadable"),
  );
  bootstrap(dom, rpc);
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#records button")?.click();
  await settle();
  strictEqual(
    dom.window.document.querySelector("#data-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。",
  );
  strictEqual(dom.window.document.querySelectorAll("#records button").length, 0);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  assertUndoState(dom, false);
});

test("BUG-016 unreadable query can recover through one later bounded refresh", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc);
  rpc.pushQuery(
    "summary",
    createBlacklistQueryResponse("summary", false, null, "storage-unreadable"),
  );
  const app = bootstrap(dom, rpc);
  await settle();
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  queueData(rpc, 2, [AUTHOR_ITEM]);
  await app.refresh();
  await settle();
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(dom.window.document.querySelectorAll("#records button").length, 1);
});

test("BUG-014/016 strict production client accepts a bounded null-alias page", async () => {
  const dom = fixture();
  const strictRpc = createBlacklistRpcClient(async (message) => {
    const request = message as { type?: unknown; operation?: unknown };
    if (request.type === "cocoon.blacklist.request") {
      return createBlacklistRpcResponse("status", true, { status: "running", count: 1 });
    }
    if (request.operation === "summary") {
      return createBlacklistQueryResponse("summary", true, {
        revision: 1,
        authorCount: 1,
        tagCount: 1,
      });
    }
    return createBlacklistQueryResponse("authors-page", true, {
      revision: 1,
      authorCount: 1,
      tagCount: 1,
      items: [AUTHOR_ITEM],
      nextCursor: null,
      totalCount: 1,
    });
  });
  bootstrap(dom, strictRpc);
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#records li.record").length, 1);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
});

test("POPUP contains openOptionsPage rejection in its local alert", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  queueStatus(rpc, "unsupported");
  queueData(rpc, 1, []);
  bootstrapPopup({
    document: dom.window.document,
    window: dom.window as unknown as Window,
    rpc,
    storageChanges: { addListener() {} },
    async openOptionsPage() {
      throw new Error("open failed");
    },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#manage")?.click();
  await settle();
  strictEqual(dom.window.document.querySelector<HTMLElement>("#save-error")?.hidden, false);
  strictEqual(
    dom.window.document.querySelector("#save-error")?.textContent,
    "无法打开管理页，请重试。",
  );
});
