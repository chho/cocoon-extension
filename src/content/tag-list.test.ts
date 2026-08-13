import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
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

  renderTagList(
    container,
    [
      ...createInitialState().tags,
      { tagId: "reading", name: "Reading" },
    ],
    {
      selectTag(tag) {
        selected.push(tag.tagId);
      },
      deleteTag(tagId) {
        deleted.push(tagId);
      },
    },
  );

  const items = container.querySelectorAll(".cocoon-tag-item");
  strictEqual(items.length, 2);
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
