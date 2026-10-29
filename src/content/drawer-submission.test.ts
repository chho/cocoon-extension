import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createDrawerController, type DrawerTarget } from "./drawer-controller.ts";

const selection = { tag: { tagId: "default", name: "default" }, isNewTag: false };
const target = (id: string): DrawerTarget<string, string> => ({
  targetId: id,
  card: id,
  button: id,
  authorNameAtClick: "Synthetic",
  profileUserIdAtClick: id,
  memberHashIdAtClick: null,
  anchorBounds: null,
  voterSource: null,
});
function harness() {
  const pending: Array<{
    finish: (result: "completed" | "failed" | "incomplete") => void;
    signal: AbortSignal;
  }> = [];
  const deadlines: Array<() => void> = [];
  const focus: string[] = [];
  let busy = false,
    hides = 0,
    warnings = 0,
    timers = 0;
  const controller = createDrawerController<string, string>({
    show() {},
    hide() {
      hides++;
    },
    clearDraft() {},
    focusInput() {},
    restoreFocus(button) {
      focus.push(button);
    },
    setSubmitting(value) {
      busy = value;
    },
    getRemoteAuthorization: () => ({ blockAuthorOnZhihu: false, blockContentVoters: false }),
    commit(_task, signal) {
      return new Promise((resolve) => pending.push({ finish: resolve, signal }));
    },
    scheduleDeadline(callback) {
      deadlines.push(callback);
      timers++;
      return () => {
        timers--;
      };
    },
    reportIncomplete() {
      warnings++;
    },
  });
  return {
    controller,
    pending,
    deadlines,
    focus,
    state: () => ({ busy, hides, warnings, timers }),
  };
}
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("BUG-021 retains pending drawer until actual completion; duplicate submit and cancel cannot revoke it", async () => {
  const h = harness();
  h.controller.open(target("a"));
  h.controller.submit(selection);
  strictEqual(h.controller.getState().status, "submitting");
  deepStrictEqual(h.state(), { busy: true, hides: 0, warnings: 0, timers: 1 });
  h.controller.submit(selection);
  h.controller.cancel();
  strictEqual(h.pending.length, 1);
  strictEqual(h.state().busy, true);
  h.pending[0]!.finish("completed");
  await settle();
  deepStrictEqual(h.state(), { busy: false, hides: 1, warnings: 0, timers: 0 });
  deepStrictEqual(h.focus, []);
});

test("BUG-021 old completion cannot hide or focus a reopened target, even when its object is reused", async () => {
  const h = harness(),
    same = target("a");
  h.controller.open(same);
  h.controller.submit(selection);
  h.controller.open(same);
  h.controller.submit(selection);
  strictEqual(h.pending[0]!.signal.aborted, true);
  h.pending[0]!.finish("failed");
  await settle();
  strictEqual(h.state().busy, true);
  strictEqual(h.state().hides, 0);
  deepStrictEqual(h.focus, []);
  h.pending[1]!.finish("failed");
  await settle();
  deepStrictEqual(h.focus, ["a"]);
  strictEqual(h.state().hides, 1);
});

test("BUG-021 timeout releases UI without retry, rollback, or late focus; page dismissal cancels waiting", async () => {
  const h = harness();
  h.controller.open(target("a"));
  h.controller.submit(selection);
  h.deadlines[0]!();
  await settle();
  deepStrictEqual(h.state(), { busy: false, hides: 1, warnings: 1, timers: 0 });
  strictEqual(h.pending[0]!.signal.aborted, true);
  h.controller.open(target("b"));
  h.pending[0]!.finish("failed");
  await settle();
  strictEqual(h.controller.getState().status, "open");
  deepStrictEqual(h.focus, []);
  h.controller.submit(selection);
  h.controller.dismiss();
  await settle();
  strictEqual(h.pending[1]!.signal.aborted, true);
  strictEqual(h.state().timers, 0);
});
