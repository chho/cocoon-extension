import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTIC_CHANNEL } from "./contract.ts";
import { createDiagnosticMessageListener } from "./background.ts";
import type { DiagnosticStore } from "./storage.ts";

const sender = { id: "extension-id", url: "https://www.zhihu.com/", frameId: 0, tab: { id: 1 } };
const request = { channel: DIAGNOSTIC_CHANNEL, operation: "prune" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(store: DiagnosticStore) {
  let expire = () => {};
  let active = false;
  const listener = createDiagnosticMessageListener({
    store,
    runtimeId: sender.id,
    scheduleTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 1_500);
      expire = callback;
      active = true;
      return () => {
        active = false;
      };
    },
  });
  return { listener, expire: () => expire(), active: () => active };
}

test("strict sender and envelope rejection never invoke storage or reply", () => {
  let calls = 0;
  const h = harness({
    async handle() {
      calls++;
      return true;
    },
  });
  const reply = () => assert.fail("unexpected response");
  for (const invalid of [
    { ...sender, id: "other" },
    { ...sender, frameId: 1 },
    { ...sender, tab: { id: -1 } },
    { ...sender, tab: { id: 1.5 } },
    { ...sender, tab: undefined },
    { ...sender, url: "https://www.zhihu.com/?query=1" },
    { ...sender, url: "https://www.zhihu.com/question/1" },
    { ...sender, url: "chrome-extension://extension-id/options/options.html" },
  ])
    assert.equal(h.listener(request, invalid, reply), false);
  for (const invalid of [
    null,
    { ...request, extra: "no" },
    { ...request, operation: "read" },
    { ...request, operation: "save", incident: {} },
  ])
    assert.equal(h.listener(invalid, sender, reply), false);
  assert.equal(calls, 0);
  assert.equal(h.active(), false);
});

test("success and failure reply once and release response timeout", async () => {
  for (const outcome of ["success", "false", "throw"]) {
    const h = harness({
      async handle() {
        if (outcome === "throw") throw new Error("private");
        return outcome === "success";
      },
    });
    const response = deferred<unknown>();
    let replies = 0;
    assert.equal(
      h.listener(request, sender, (value) => {
        replies++;
        response.resolve(value);
      }),
      true,
    );
    assert.deepEqual(await response.promise, { ok: outcome === "success" });
    assert.equal(replies, 1);
    assert.equal(h.active(), false);
    h.expire();
    assert.equal(replies, 1);
  }
});

test("timeout aborts pending work and late completion cannot reply twice", async () => {
  const pending = deferred<boolean>();
  let signal: AbortSignal | undefined;
  const h = harness({
    async handle(_request, abortSignal) {
      signal = abortSignal;
      return pending.promise;
    },
  });
  const replies: unknown[] = [];
  assert.equal(
    h.listener(request, sender, (value) => replies.push(value)),
    true,
  );
  h.expire();
  assert.deepEqual(replies, [{ ok: false }]);
  assert.ok(signal?.aborted);
  pending.resolve(true);
  await pending.promise;
  await Promise.resolve();
  assert.deepEqual(replies, [{ ok: false }]);
  assert.equal(h.active(), false);
});

test("disconnected send callback is caught without retry or payload logging", async () => {
  const done = deferred<void>();
  let sends = 0;
  const h = harness({
    async handle() {
      return true;
    },
  });
  h.listener(request, sender, () => {
    sends++;
    done.resolve();
    throw new Error("port closed");
  });
  await done.promise;
  await Promise.resolve();
  h.expire();
  assert.equal(sends, 1);
  assert.equal(h.active(), false);
});
