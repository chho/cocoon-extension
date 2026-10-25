import { strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { JSDOM } from "jsdom";

test("BUG-019 tag maintenance fills its parent width including borders", async () => {
  const html = await readFile(new URL("../../options/options.html", import.meta.url), "utf8");
  const css = await readFile(new URL("./options.css", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);
    const workbench = dom.window.document.querySelector(".tag-workbench");
    if (!workbench) throw new Error("Tag workbench missing from production HTML");
    const computed = dom.window.getComputedStyle(workbench);
    strictEqual(computed.width, "100%");
    strictEqual(computed.boxSizing, "border-box");
  } finally {
    dom.window.close();
  }
});
