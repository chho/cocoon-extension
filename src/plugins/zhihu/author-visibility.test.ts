import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { waitForHiddenTargets } from "./author-visibility.ts";

test("BUG-021 completion waits for every selected DOM root, not unrelated work", async () => {
  const dom = new JSDOM('<body><div id="a"></div><div id="b"></div><div id="other"></div></body>');
  try {
    const roots = ["a", "b"].map((id) => dom.window.document.getElementById(id)!);
    const abort = new AbortController();
    let completed = false;
    const pending = (async () => {
      completed = await waitForHiddenTargets(
        roots.map((root) => ({ root, isRelevant: () => true })),
        abort.signal,
      );
    })();
    await Promise.resolve();
    strictEqual(completed, false);
    roots[0]!.classList.add("cocoon-blacklisted");
    await Promise.resolve();
    strictEqual(completed, false);
    roots[1]!.classList.add("cocoon-comment-blacklisted");
    await pending;
    strictEqual(completed, true);
  } finally {
    dom.window.close();
  }
});

test("BUG-021 detached or repurposed roots finish; abort is incomplete even when RAF never runs", async () => {
  const dom = new JSDOM('<body><div id="a"></div></body>');
  try {
    const root = dom.window.document.getElementById("a")!;
    let relevant = true;
    const abort = new AbortController();
    const first = waitForHiddenTargets([{ root, isRelevant: () => relevant }], abort.signal);
    relevant = false;
    root.setAttribute("data-id", "changed");
    strictEqual(await first, true);
    const second = waitForHiddenTargets([{ root, isRelevant: () => true }], abort.signal);
    root.remove();
    strictEqual(await second, true);
    dom.window.document.body.append(root);
    const third = waitForHiddenTargets([{ root, isRelevant: () => true }], abort.signal);
    abort.abort();
    strictEqual(await third, false);
    strictEqual(await waitForHiddenTargets([], abort.signal), false);
  } finally {
    dom.window.close();
  }
});
