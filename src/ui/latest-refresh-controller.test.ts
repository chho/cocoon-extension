import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createLatestRefreshController } from "./latest-refresh-controller.ts";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolveValue: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: (value) => resolveValue?.(value) };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("POPUP-009 storage change during refresh guarantees a later newest apply", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const loads = [first, second];
  const applied: number[] = [];
  const controller = createLatestRefreshController({
    load: () => loads.shift()!.promise,
    apply: (value) => applied.push(value),
    fail: () => { throw new Error("unexpected failure"); },
  });
  void controller.request();
  void controller.request();
  first.resolve(1);
  await settle();
  deepStrictEqual(applied, []);
  second.resolve(2);
  await settle();
  deepStrictEqual(applied, [2]);
});

test("POPUP-009 a request in the terminal settled-before-cleanup window starts a new drain", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const loads = [first, second];
  const applied: number[] = [];
  let loadCount = 0;
  let controller: ReturnType<typeof createLatestRefreshController<number>>;
  controller = createLatestRefreshController({
    load() {
      loadCount += 1;
      return loads.shift()!.promise;
    },
    apply(value) {
      applied.push(value);
      if (value === 1) {
        // This runs after the terminal loop has chosen to exit. In the old
        // implementation its request attached to the settled drain before
        // the separate Promise.finally cleanup cleared `running`.
        queueMicrotask(() => { void controller.request(); });
      }
    },
    fail() { throw new Error("unexpected failure"); },
  });

  void controller.request();
  first.resolve(1);
  await settle();
  strictEqual(loadCount, 2);
  deepStrictEqual(applied, [1]);

  second.resolve(2);
  await settle();
  deepStrictEqual(applied, [1, 2]);
});

test("POPUP-009 multiple storage events coalesce to one later refresh", async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const loads = [first, second];
  let loadCount = 0;
  let applied = 0;
  const controller = createLatestRefreshController({
    load() { loadCount += 1; return loads.shift()!.promise; },
    apply(value) { applied = value; },
    fail() { throw new Error("unexpected failure"); },
  });
  void controller.request();
  void controller.request();
  void controller.request();
  void controller.request();
  first.resolve(1);
  await settle();
  strictEqual(loadCount, 2);
  second.resolve(4);
  await settle();
  strictEqual(applied, 4);
  strictEqual(loadCount, 2);
});

test("POPUP-009 invalidation prevents an older response from restoring writable state", async () => {
  const load = deferred<number>();
  const applied: number[] = [];
  const controller = createLatestRefreshController({
    load: () => load.promise,
    apply: (value) => applied.push(value),
    fail: () => {},
  });
  void controller.request();
  controller.invalidate();
  load.resolve(1);
  await settle();
  deepStrictEqual(applied, []);
});
