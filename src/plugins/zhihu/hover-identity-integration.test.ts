import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { createBlacklistContentController } from "../../background/blacklist-content-controller.ts";
import { createBlacklistRepository } from "../../background/blacklist-repository.ts";
import {
  readLogicalState,
  storeLogicalState,
} from "../../background/blacklist-repository.test-support.ts";
import { createInitialState, type BlacklistedAuthor } from "../../content/blacklist-state.ts";
import { COMMENT_HIDDEN_CLASS } from "../../content/comment-filter-controller.ts";
import { HOVER_MEMBER_HASH, memberHoverMarkup } from "../../content/hover-card.test-support.ts";
import { REMOTE_PREFERENCES_STORAGE_KEY } from "../../content/remote-preferences.ts";
import {
  createBlacklistContentResponse,
  parseBlacklistContentRequest,
} from "../../core/blacklist-content-rpc-contract.ts";
import { mountZhihuPlugin } from "./runtime.ts";

const NOW = "2026-10-25T12:00:00.000Z";
const DATABASE = "hover-identity-test";
type Scenario = "new" | "existing" | "conflict";

function originalAuthor(scenario: Scenario): BlacklistedAuthor | null {
  return scenario === "new"
    ? null
    : {
        platformId: "zhihu",
        userId: "synthetic-author",
        memberHashId: scenario === "conflict" ? "b".repeat(32) : null,
        authorNameAtCapture: "First captured name",
        tagId: "original-tag",
        blacklistedAt: "2026-01-01T00:00:00.000Z",
        blockSource: "upvoter",
      };
}

async function createBackend(t: TestContext, scenario: Scenario) {
  const factory = new IDBFactory();
  const connections: IDBDatabase[] = [];
  const open = factory.open.bind(factory);
  t.mock.method(factory, "open", (...args: Parameters<IDBFactory["open"]>) => {
    const request = open(...args);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  t.after(() => connections.forEach((connection) => connection.close()));
  const original = originalAuthor(scenario);
  const state = createInitialState();
  await storeLogicalState(factory, DATABASE, {
    ...state,
    tags: [...state.tags, { tagId: "original-tag", name: "Original" }],
    authors: original ? [original] : [],
  });
  const values: Record<string, unknown> = {
    [REMOTE_PREFERENCES_STORAGE_KEY]: {
      schemaVersion: 1,
      blockAuthorOnZhihu: true,
      blockContentVoters: true,
    },
  };
  const storage = {
    async get(key: string) {
      return { [key]: values[key] };
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, items);
    },
    async remove(key: string) {
      delete values[key];
    },
  };
  const repository = createBlacklistRepository({
    indexedDB: factory,
    databaseName: DATABASE,
    storage,
  });
  const controller = createBlacklistContentController(repository, {
    async runExclusive(operation) {
      return operation();
    },
  });
  return { storage, controller, original, read: async () => readLogicalState(factory, DATABASE) };
}

function installGlobals(t: TestContext, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

function createDom(t: TestContext) {
  const dom = new JSDOM(
    `<!doctype html><body>${memberHoverMarkup()}
    <div class="Comments-container">
      <div data-id="hash-comment" id="hash-comment"><a href="/people/${HOVER_MEMBER_HASH}">Hash author</a></div>
      <div data-id="token-comment" id="token-comment"><a href="/people/synthetic-author">Token author</a></div>
      <div data-id="other-comment" id="other-comment"><a href="/people/other-author">Unblocked</a></div>
    </div></body>`,
    { url: "https://www.zhihu.com/" },
  );
  const observers: MutationObserver[] = [];
  class Observer extends dom.window.MutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.push(this);
    }
  }
  t.after(() => {
    observers.forEach((observer) => observer.disconnect());
    dom.window.close();
  });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true }) });
  dom.window.document.cookie = "_xsrf=synthetic-csrf";
  installGlobals(t, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: Observer,
    navigator: {
      locks: {
        async request(
          name: string,
          _options: unknown,
          callback: (lock: object) => Promise<unknown>,
        ) {
          return callback({ name });
        },
      },
    },
  });
  return dom;
}

function runtimeTransport(backend: Awaited<ReturnType<typeof createBackend>>) {
  let active = 0;
  const commits: unknown[] = [];
  return {
    get active() {
      return active;
    },
    commits,
    chrome: {
      storage: { local: backend.storage, onChanged: { addListener() {} } },
      runtime: {
        async sendMessage(message: unknown) {
          const request = parseBlacklistContentRequest(message);
          ok(request, "runtime must send valid production RPC");
          if (request.operation === "commit-author") commits.push(request.input.input);
          active += 1;
          try {
            return createBlacklistContentResponse(
              request.operation,
              true,
              await backend.controller.handle(request),
            );
          } finally {
            active -= 1;
          }
        },
      },
    },
  };
}

async function mountHarness(t: TestContext, scenario: Scenario) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(NOW) });
  t.mock.method(console, "info", () => {});
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const backend = await createBackend(t, scenario);
  const dom = createDom(t);
  const transport = runtimeTransport(backend);
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const requests: Array<{ url: string; method: string }> = [];
  installGlobals(t, {
    chrome: transport.chrome,
    requestAnimationFrame(callback: () => void) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    async fetch(url: string, init?: RequestInit) {
      requests.push({ url, method: init?.method ?? "GET" });
      return new Response("{}", { status: init?.method === "POST" ? 200 : 403 });
    },
  });
  async function flush() {
    for (let turn = 0; turn < 200; turn += 1) {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
      await setImmediate();
      if (frames.size === 0 && transport.active === 0) return;
    }
    throw new Error("Runtime work did not settle within the deterministic task budget");
  }
  const element = <T extends HTMLElement>(selector: string): T => {
    const node = dom.window.document.querySelector<T>(selector);
    ok(node, `Missing ${selector}`);
    return node;
  };
  mountZhihuPlugin({
    url: new URL(dom.window.location.href),
    badgeReporter: { recordFirstHidden() {} },
  });
  await flush();
  return { ...backend, ...transport, dom, flush, element, requests, errors };
}

async function submitFromHover(h: Awaited<ReturnType<typeof mountHarness>>) {
  const before = await h.read();
  h.element<HTMLButtonElement>(".cocoon-hover-block-button").click();
  await h.flush();
  deepStrictEqual(await h.read(), before, "opening the drawer must not write an alias");
  strictEqual(h.element<HTMLInputElement>("#cocoon-block-author-on-zhihu").checked, true);
  strictEqual(h.element<HTMLInputElement>("#cocoon-block-content-voters").disabled, true);
  // A real hover can disappear while its already-open drawer remains actionable.
  h.element(".hover-root").remove();
  h.element<HTMLButtonElement>(
    '.cocoon-tag-choice[aria-label="使用标签 default 并屏蔽作者"]',
  ).click();
  await h.flush();
}

for (const scenario of ["new", "existing", "conflict"] as const) {
  test(`BUG-020 production hover→RPC→IDB→comment filtering: ${scenario}`, async (t) => {
    const h = await mountHarness(t, scenario);
    const before = await h.read();
    strictEqual(h.element("#hash-comment").classList.contains(COMMENT_HIDDEN_CLASS), false);
    strictEqual(h.commits.length, 0);
    await submitFromHover(h);
    const after = await h.read();
    const succeeds = scenario !== "conflict";
    strictEqual(h.element("#hash-comment").classList.contains(COMMENT_HIDDEN_CLASS), succeeds);
    strictEqual(h.element("#other-comment").classList.contains(COMMENT_HIDDEN_CLASS), false);
    strictEqual(h.errors.length, succeeds ? 0 : 1);
    if (!succeeds) {
      deepStrictEqual(after, before);
      return;
    }
    const expected = h.original
      ? { ...h.original, memberHashId: HOVER_MEMBER_HASH }
      : {
          platformId: "zhihu",
          userId: "synthetic-author",
          memberHashId: HOVER_MEMBER_HASH,
          authorNameAtCapture: "Synthetic Author",
          tagId: "default",
          blacklistedAt: NOW,
          blockSource: "direct",
        };
    deepStrictEqual(after.state.authors, [expected]);
    strictEqual(h.element("#token-comment").classList.contains(COMMENT_HIDDEN_CLASS), true);
    strictEqual(after.revision, before.revision + 1);
    h.dom.window.document.body.insertAdjacentHTML("beforeend", memberHoverMarkup());
    await h.flush();
    await submitFromHover(h);
    deepStrictEqual(await h.read(), after);
    deepStrictEqual(
      h.requests.filter((r) => r.method === "POST"),
      scenario === "new"
        ? [
            {
              url: "https://www.zhihu.com/api/v4/members/synthetic-author/actions/block",
              method: "POST",
            },
          ]
        : [],
    );
    ok(
      h.requests
        .filter((r) => r.method === "GET")
        .every((r) => r.url === `/api/v4/members/${HOVER_MEMBER_HASH}`),
    );
  });
}
