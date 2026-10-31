import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { observeDiagnosticDom } from "./dom-observer.ts";
import type { DiagnosticInput } from "./recorder.ts";

test("Dev DOM observation preserves native nodes and identity, catches hidden-anchor candidates, and disconnects", async () => {
  const dom = new JSDOM(
    '<body><div class="cocoon-comment-blacklisted"><a href="/people/synthetic-author">Synthetic</a></div></body>',
    { url: "https://www.zhihu.com/" },
  );
  try {
    const document = dom.window.document;
    const events: DiagnosticInput[] = [];
    const scheduled: Array<() => void> = [];
    let candidates = 0;
    const ids = new WeakMap<Element, number>();
    let nextId = 0;
    const observer = observeDiagnosticDom(document, {
      record: (event) => {
        events.push(event);
      },
      candidate: () => {
        candidates++;
      },
      nodeId: (node) => {
        if (!ids.has(node)) ids.set(node, ++nextId);
        return ids.get(node)!;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return () => {
          const i = scheduled.indexOf(callback);
          if (i >= 0) scheduled.splice(i, 1);
        };
      },
    });
    const root = document.createElement("div");
    root.className = "HoverCard-item";
    root.innerHTML =
      '<a class="UserLink-link" href="/people/synthetic-author">Synthetic Author</a>';
    root.getClientRects = () => [{ width: 100 }] as unknown as DOMRectList;
    root.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 100, 50);
    document.body.append(root);
    await Promise.resolve();
    scheduled.splice(0).forEach((callback) => callback());
    strictEqual(candidates, 1);
    strictEqual(
      events.some((e) => e.kind === "hover-added" && e.userId === "synthetic-author"),
      true,
    );
    strictEqual(root.isConnected, true);
    root.style.left = "1px";
    await Promise.resolve();
    scheduled.splice(0).forEach((callback) => callback());
    strictEqual(candidates, 1);
    root.remove();
    await Promise.resolve();
    scheduled.splice(0).forEach((callback) => callback());
    strictEqual(
      events.some((e) => e.kind === "hover-removed"),
      true,
    );
    document.body.insertAdjacentHTML("beforeend", '<div class="HoverCard-item"></div>'.repeat(9));
    await Promise.resolve();
    scheduled.splice(0).forEach((callback) => callback());
    strictEqual(
      events.some((e) => e.kind === "hover-state" && e.total === 9 && e.dropped === 1),
      true,
    );
    observer.stop();
    const count = events.length;
    document.body.append(root);
    document
      .querySelector("a")!
      .dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    await Promise.resolve();
    strictEqual(events.length, count);
    strictEqual(scheduled.length, 0);
  } finally {
    dom.window.close();
  }
});
