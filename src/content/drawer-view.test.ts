import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createDrawerView } from "./drawer-view.ts";

test("BUG-021 pending locks controls without inert or movement, and restores prior option availability", () => {
  const dom = new JSDOM("<body></body>");
  try {
    const document = dom.window.document;
    const options = document.createElement("div");
    const unavailable = document.createElement("input");
    unavailable.disabled = true;
    options.append(unavailable);
    const view = createDrawerView(document, options);
    view.drawer.inert = false;
    view.drawer.hidden = false;
    view.drawer.dataset.phase = "open";
    view.drawer.style.left = "30px";
    view.drawer.style.top = "40px";
    view.drawer.getBoundingClientRect = () => new dom.window.DOMRect(34, 40, 188, 160);
    view.setSubmitting(true);
    strictEqual(view.drawer.inert, false);
    strictEqual(view.drawer.style.left, "34px");
    strictEqual(view.drawer.style.width, "188px");
    strictEqual(view.drawer.style.height, "160px");
    strictEqual(view.drawer.style.transform, "none");
    strictEqual(view.drawer.style.transition, "none");
    strictEqual(view.newTagInput.matches(":disabled"), true);
    strictEqual(view.drawerCloseButton.matches(":disabled"), true);
    strictEqual(view.drawer.getAttribute("aria-busy"), "true");
    view.setSubmitting(false);
    strictEqual(view.drawer.style.left, "30px");
    strictEqual(view.newTagInput.matches(":disabled"), false);
    strictEqual(unavailable.disabled, true);
    strictEqual(view.drawer.getAttribute("aria-busy"), "false");
  } finally {
    dom.window.close();
  }
});
