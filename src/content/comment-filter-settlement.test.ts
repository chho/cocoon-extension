import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  COMMENT_HIDDEN_CLASS,
  createCommentFilterController,
  resolveCommentAuthorUserId,
  type CommentFilterContext,
  type CommentFilterControllerDependencies,
  type CommentSettlement,
} from "./comment-filter-controller.ts";
import type { IdentityMatchStatus } from "./identity-batch-matcher.ts";
import type { AuthorAliasPersistenceResult } from "./author-alias-persistence-controller.ts";

const HASH = "a".repeat(32);
const OTHER_HASH = "b".repeat(32);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fixture(dependencies: Omit<CommentFilterControllerDependencies, "schedule">) {
  const dom = new JSDOM(`<body><section class="Comments-container">
    <div data-id="source"><a href="/people/${HASH}">Source</a>
      <div data-id="reply"><a href="/people/reply-token">Reply</a></div>
    </div>
    <div data-id="other"><a href="/people/${OTHER_HASH}">Other</a></div>
  </section></body>`);
  const observers = { created: 0, disconnected: 0 };
  dom.window.MutationObserver = class extends dom.window.MutationObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.created += 1;
    }
    override disconnect(): void {
      super.disconnect();
      observers.disconnected += 1;
    }
  };
  const frames: Array<() => void> = [];
  const controller = createCommentFilterController({
    ...dependencies,
    schedule(callback) {
      frames.push(callback);
    },
  });
  function context(dataId: string): CommentFilterContext {
    const root = dom.window.document.querySelector<HTMLElement>(`[data-id="${dataId}"]`);
    if (!root) throw new Error("Missing synthetic comment");
    const identifier = resolveCommentAuthorUserId(root);
    if (!identifier) throw new Error("Missing synthetic author");
    return { root, identifier, dataId };
  }
  function wait(source = context("source")) {
    const abort = new AbortController();
    const state: { result: CommentSettlement | null } = { result: null };
    const completion = (async () => {
      state.result = await controller.waitForSettled(source, abort.signal);
      return state.result;
    })();
    return { state, completion, abort };
  }
  return {
    dom,
    controller,
    context,
    wait,
    observers,
    frames,
    flush() {
      frames.shift()?.();
    },
    close() {
      controller.destroy();
      dom.window.close();
    },
  };
}

test("BUG-022 acknowledgement waits for queued RAF and current async query without extra work", async (t) => {
  const query = deferred<IdentityMatchStatus>();
  let queries = 0;
  const f = fixture({
    matchStableIdentifiers() {
      queries += 1;
      return query.promise;
    },
  });
  t.after(f.close);
  const source = f.context("source");
  f.controller.scan(source.root);
  const frameCount = f.frames.length;
  const wait = f.wait(source);
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  strictEqual(queries, 0);
  strictEqual(f.frames.length, frameCount);
  f.flush();
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  query.resolve("matched");
  strictEqual(await wait.completion, "hidden");
  strictEqual(source.root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(queries, 2); // Source and its reply; acknowledgement adds neither.
  strictEqual(getEventListeners(wait.abort.signal, "abort").length, 0);
  strictEqual(f.observers.created, f.observers.disconnected);
});

test("BUG-022 hash alias completion still waits for requeued filtering to apply the class", async (t) => {
  const alias = deferred<AuthorAliasPersistenceResult>();
  let matched = false;
  let queries = 0;
  let requests = 0;
  const f = fixture({
    matchStableIdentifiers() {
      queries += 1;
      return matched ? "matched" : "unmatched";
    },
    resolveHistoricalAlias() {
      requests += 1;
      return alias.promise;
    },
  });
  t.after(f.close);
  const source = f.context("source");
  f.controller.scan(source.root);
  f.flush();
  deepStrictEqual(f.controller.getMatchingRoots(new Set(["canonical-token"])), []);
  const wait = f.wait(source);
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  matched = true;
  alias.resolve({ status: "persisted" });
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  strictEqual(source.root.classList.contains(COMMENT_HIDDEN_CLASS), false);
  f.flush();
  strictEqual(await wait.completion, "hidden");
  strictEqual(source.root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(requests, 1);
  strictEqual(queries, 3);
});

test("BUG-022 ancestor hiding settles a reply even with its own query held", async (t) => {
  for (const hiddenClass of [COMMENT_HIDDEN_CLASS, "cocoon-blacklisted"]) {
    const query = deferred<IdentityMatchStatus>();
    const f = fixture({ matchStableIdentifiers: () => query.promise });
    t.after(f.close);
    const source = f.context("source");
    const reply = f.context("reply");
    f.controller.scan(reply.root);
    f.flush();
    const wait = f.wait(reply);
    const ancestor =
      hiddenClass === COMMENT_HIDDEN_CLASS ? source.root : source.root.parentElement!;
    ancestor.classList.add(hiddenClass);
    await drainMicrotasks();
    strictEqual(wait.state.result, "hidden", hiddenClass);
    strictEqual(await f.wait(reply).completion, "hidden");
    strictEqual(f.observers.created, f.observers.disconnected);
    query.resolve("unmatched");
  }
});

test("BUG-022 an unrelated root alias cannot block a successful unmatched decision", async (t) => {
  const alias = deferred<AuthorAliasPersistenceResult>();
  const f = fixture({
    matchStableIdentifiers: () => "unmatched",
    resolveHistoricalAlias: () => alias.promise,
  });
  t.after(f.close);
  f.controller.scan(f.context("other").root);
  f.controller.scan(f.context("reply").root);
  const wait = f.wait(f.context("reply"));
  f.flush();
  strictEqual(await wait.completion, "visible");
  alias.resolve({ status: "failed" });
});

test("BUG-022 unavailable and rejected lookups never acknowledge visible", async (t) => {
  for (const reject of [false, true]) {
    const query = deferred<IdentityMatchStatus>();
    const f = fixture({ matchStableIdentifiers: () => query.promise });
    t.after(f.close);
    const reply = f.context("reply");
    f.controller.scan(reply.root);
    f.flush();
    const wait = f.wait(reply);
    if (reject) query.reject(new Error("Lookup failed"));
    else query.resolve("unavailable");
    strictEqual(await wait.completion, "unavailable");
    strictEqual(reply.root.classList.contains(COMMENT_HIDDEN_CLASS), false);
  }
});

test("BUG-022 failed alias remains unavailable after skipAliasOnce is consumed", async (t) => {
  const alias = deferred<AuthorAliasPersistenceResult>();
  let requests = 0;
  const f = fixture({
    matchStableIdentifiers: () => "unmatched",
    resolveHistoricalAlias() {
      requests += 1;
      return alias.promise;
    },
  });
  t.after(f.close);
  const source = f.context("source");
  f.controller.scan(source.root);
  f.flush();
  const wait = f.wait(source);
  alias.resolve({ status: "failed" });
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  f.flush();
  strictEqual(await wait.completion, "unavailable");
  strictEqual(await f.wait(source).completion, "unavailable");
  strictEqual(requests, 1);
});

test("BUG-022 a superseded query cannot publish a successful current decision", async (t) => {
  const oldQuery = deferred<IdentityMatchStatus>();
  const currentQuery = deferred<IdentityMatchStatus>();
  let queries = 0;
  const f = fixture({
    matchStableIdentifiers() {
      queries += 1;
      return queries === 1 ? oldQuery.promise : currentQuery.promise;
    },
  });
  t.after(f.close);
  const reply = f.context("reply");
  f.controller.scan(reply.root);
  f.flush();
  f.controller.reevaluateAll();
  const wait = f.wait(reply);
  oldQuery.resolve("unmatched");
  await drainMicrotasks();
  strictEqual(wait.state.result, null);
  f.flush();
  strictEqual(wait.state.result, null);
  currentQuery.resolve("unavailable");
  strictEqual(await wait.completion, "unavailable");
  strictEqual(queries, 2);
});

test("BUG-022 detach, reuse, abort and destroy settle and release temporary observers/listeners", async (t) => {
  for (const action of ["detach", "data-id", "identifier", "abort", "destroy"] as const) {
    const f = fixture({ matchStableIdentifiers: () => "unmatched" });
    t.after(f.close);
    const source = f.context("source");
    f.controller.scan(source.root);
    const wait = f.wait(source);
    strictEqual(f.observers.created, 1);
    if (action === "detach") source.root.remove();
    if (action === "data-id") source.root.dataset.id = "reused";
    if (action === "identifier") source.root.querySelector("a")!.href = "/people/reused";
    if (action === "abort") wait.abort.abort();
    if (action === "destroy") f.controller.destroy();
    const expected =
      action === "detach"
        ? "detached"
        : action === "abort" || action === "destroy"
          ? "aborted"
          : "changed";
    strictEqual(await wait.completion, expected, action);
    strictEqual(f.observers.created, f.observers.disconnected, action);
    strictEqual(getEventListeners(wait.abort.signal, "abort").length, 0, action);
  }
});

test("BUG-022 no observed decision is unavailable, and pre-abort/destroy never starts work", async (t) => {
  let queries = 0;
  const f = fixture({
    matchStableIdentifiers: () => {
      queries += 1;
      return "unmatched";
    },
  });
  t.after(f.close);
  const source = f.context("source");
  strictEqual(await f.wait(source).completion, "unavailable");
  const abort = new AbortController();
  abort.abort();
  strictEqual(await f.controller.waitForSettled(source, abort.signal), "aborted");
  f.controller.destroy();
  strictEqual(await f.wait(source).completion, "aborted");
  strictEqual(queries, 0);
  strictEqual(f.frames.length, 0);
  strictEqual(f.observers.created, 0);
});
