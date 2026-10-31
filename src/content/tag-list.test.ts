import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

import { createInitialState } from "./blacklist-state.ts";
import { renderTagList } from "./tag-list.ts";

test("TAG-013/014 renders compact sibling controls with isolated actions", () => {
  const dom = new JSDOM("<div id=outside><div id=tags></div></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#tags");
  if (!container) throw new Error("Missing tag list fixture.");

  const selected: string[] = [];
  const deleted: string[] = [];
  let outsideClicks = 0;
  dom.window.document.querySelector("#outside")?.addEventListener("click", () => {
    outsideClicks += 1;
  });

  renderTagList(container, [...createInitialState().tags, { tagId: "reading", name: "Reading" }], {
    selectTag(tag) {
      selected.push(tag.tagId);
    },
    deleteTag(tagId) {
      deleted.push(tagId);
    },
  });

  strictEqual(container.querySelector(".cocoon-custom-tags"), null);
  strictEqual(container.children.length, 2);
  ok([...container.children].every((item) => item.classList.contains("cocoon-tag-item")));
  const items = container.querySelectorAll(".cocoon-tag-item");
  strictEqual(items.length, 2);
  strictEqual((items[1] as HTMLElement).dataset.tagId, "reading");
  strictEqual(items[0]?.querySelectorAll("button").length, 1);
  strictEqual(items[1]?.querySelectorAll("button").length, 2);
  strictEqual(
    items[0]?.querySelector(".cocoon-tag-delete"),
    null,
    "default must not expose a delete button",
  );

  items[1]?.querySelector<HTMLButtonElement>(".cocoon-tag-choice")?.click();
  deepStrictEqual(selected, ["reading"]);
  deepStrictEqual(deleted, []);

  items[1]?.querySelector<HTMLButtonElement>(".cocoon-tag-delete")?.click();
  deepStrictEqual(selected, ["reading"]);
  deepStrictEqual(deleted, ["reading"]);
  strictEqual(outsideClicks, 0);
});

test("BUG-023 outer flex alignment keeps default at natural height beside wrapped custom tags", async () => {
  const css = await readFile(new URL("../plugins/zhihu/plugin.css", import.meta.url), "utf8");
  const dom = new JSDOM('<div class="cocoon-tag-list"></div>');
  try {
    const style = dom.window.document.createElement("style");
    style.textContent = css;
    dom.window.document.head.append(style);
    const container = dom.window.document.querySelector<HTMLElement>(".cocoon-tag-list")!;
    renderTagList(
      container,
      [...createInitialState().tags, { tagId: "reading", name: "Reading" }],
      {
        selectTag() {},
        deleteTag() {},
      },
    );
    strictEqual(dom.window.getComputedStyle(container).alignItems, "flex-start");
    const buttons = container.querySelectorAll(".cocoon-tag-choice");
    strictEqual(
      dom.window.getComputedStyle(buttons[0]!).padding,
      dom.window.getComputedStyle(buttons[1]!).padding,
    );
  } finally {
    dom.window.close();
  }
});

test("TAG-015 default remains protected even when its name appears in the list", () => {
  const dom = new JSDOM("<div id=tags></div>");
  const container = dom.window.document.querySelector<HTMLElement>("#tags");
  if (!container) throw new Error("Missing tag list fixture.");

  renderTagList(container, createInitialState().tags, {
    selectTag() {},
    deleteTag() {
      throw new Error("The default delete action must not be reachable.");
    },
  });

  strictEqual(container.textContent, "default");
  strictEqual(container.querySelector(".cocoon-tag-delete"), null);
});
