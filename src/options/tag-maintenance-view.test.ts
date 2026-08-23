import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import type {
  BlacklistAuthorDto,
  BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";
import { renderTagMaintenanceView } from "./tag-maintenance-view.ts";

const TAGS: readonly BlacklistTagDto[] = [
  { tagId: "default", name: "default", isDefault: true },
  { tagId: "reading", name: "Reading", isDefault: false },
  { tagId: "muted", name: "Muted", isDefault: false },
];

const AUTHORS: readonly BlacklistAuthorDto[] = [
  {
    userId: "author-one",
    memberHashId: null,
    authorName: "Author One",
    tagId: "reading",
    blacklistedAt: "2026-08-21T10:00:00.000Z",
    source: "direct",
  },
  {
    userId: "author-two",
    memberHashId: null,
    authorName: "Author Two",
    tagId: "reading",
    blacklistedAt: "2026-08-21T11:00:00.000Z",
    source: "direct",
  },
];

function fixture() {
  const dom = new JSDOM("<p id='summary'></p><div id='tags' role='list'></div>");
  const summary = dom.window.document.querySelector<HTMLElement>("#summary");
  const container = dom.window.document.querySelector<HTMLElement>("#tags");
  if (!summary || !container) throw new Error("tag fixture is incomplete");
  return { dom, summary, container };
}

test("MANAGE-003/AC-087 hides default and presents custom tags with usage", () => {
  const view = fixture();
  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: TAGS,
    authors: AUTHORS,
    writesEnabled: true,
    onRename() {},
    onDelete() {},
  });

  strictEqual(view.summary.textContent, "2 个自定义标签");
  strictEqual(view.container.getAttribute("role"), "list");
  strictEqual(view.container.querySelectorAll(".tag-row").length, 2);
  strictEqual(view.container.textContent?.includes("default"), false);
  const usage = Array.from(view.container.querySelectorAll(".tag-usage"))
    .map((element) => element.textContent);
  strictEqual(usage.join("|"), "2 位作者|未关联作者");
  strictEqual(view.container.querySelectorAll(".tag-editor:not([hidden]) input").length, 0);
  strictEqual(
    Array.from(view.container.querySelectorAll(".tag-editor"))
      .every((editor) => (editor as HTMLElement).hidden),
    true,
  );
});

test("MANAGE-003/AC-087 inline rename supports focus, unchanged state, Escape, validation, and save", () => {
  const view = fixture();
  let renamedName: string | null = null;
  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: TAGS,
    authors: AUTHORS,
    writesEnabled: true,
    onRename(_tag, name) { renamedName = name; },
    onDelete() {},
  });

  const row = view.container.querySelector<HTMLElement>(".tag-row");
  const rename = row?.querySelector<HTMLButtonElement>("button[aria-label^='重命名标签']");
  const editor = row?.querySelector<HTMLElement>(".tag-editor");
  const input = row?.querySelector<HTMLInputElement>("input");
  const save = row?.querySelector<HTMLButtonElement>(".tag-save");
  const cancel = row?.querySelector<HTMLButtonElement>(".tag-editor .tag-action");
  if (!row || !rename || !editor || !input || !save || !cancel) {
    throw new Error("rename controls are incomplete");
  }
  rename.click();
  strictEqual(editor.hidden, false);
  strictEqual(view.dom.window.document.activeElement, input);
  strictEqual(input.selectionStart, 0);
  strictEqual(input.selectionEnd, input.value.length);
  strictEqual(save.disabled, true);

  input.value = "Changed";
  input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  strictEqual(save.disabled, false);
  input.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(editor.hidden, true);
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(renamedName, null);

  rename.click();
  input.value = "Changed from save";
  input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  save.focus();
  save.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(editor.hidden, true);
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(renamedName, null);

  rename.click();
  cancel.focus();
  cancel.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(editor.hidden, true);
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(renamedName, null);

  rename.click();
  input.value = "Cancelled";
  input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  cancel.click();
  strictEqual(editor.hidden, true);
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(renamedName, null);

  rename.click();
  input.value = "Muted";
  input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  editor.dispatchEvent(new view.dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(renamedName, null);
  strictEqual(input.validationMessage, "标签名称已存在。");

  input.value = "  Updated  ";
  input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  editor.dispatchEvent(new view.dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  }));
  strictEqual(renamedName, "  Updated  ");
});

test("MANAGE-003/AC-087 pending tags stay focusable while duplicate actions are guarded", () => {
  const view = fixture();
  let mutations = 0;
  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: TAGS,
    authors: AUTHORS,
    writesEnabled: true,
    pendingTagIds: new Set(["reading"]),
    onRename() { mutations += 1; },
    onDelete() { mutations += 1; },
  });
  const row = view.container.querySelector<HTMLElement>("[data-tag-id='reading']");
  const rename = row?.querySelector<HTMLButtonElement>("button[aria-label^='重命名标签']");
  const remove = row?.querySelector<HTMLButtonElement>("button[aria-label^='删除标签']");
  strictEqual(row?.getAttribute("aria-busy"), "true");
  strictEqual(rename?.disabled, false);
  strictEqual(rename?.getAttribute("aria-disabled"), "true");
  strictEqual(remove?.disabled, false);
  strictEqual(remove?.getAttribute("aria-disabled"), "true");
  strictEqual(row?.querySelector<HTMLInputElement>("input")?.readOnly, true);
  rename?.focus();
  rename?.click();
  remove?.click();
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(mutations, 0);
});

test("MANAGE-003/AC-087 delete dispatches once and default-only state is instructive", () => {
  const view = fixture();
  let deleted = 0;
  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: TAGS,
    authors: AUTHORS,
    writesEnabled: true,
    onRename() {},
    onDelete() { deleted += 1; },
  });
  view.container.querySelector<HTMLButtonElement>("button[aria-label='删除标签 Reading']")?.click();
  strictEqual(deleted, 1);

  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: [TAGS[0]!],
    authors: AUTHORS,
    writesEnabled: true,
    onRename() {},
    onDelete() {},
  });
  strictEqual(view.summary.textContent, "0 个自定义标签");
  strictEqual(view.container.hasAttribute("role"), false);
  strictEqual(view.container.querySelectorAll(".tag-row").length, 0);
  strictEqual(view.container.querySelector(".tag-empty")?.getAttribute("role"), "status");
  strictEqual(view.container.querySelector(".tag-empty")?.textContent,
    "暂无自定义标签在知乎屏蔽作者时创建的标签会显示在这里。");
});
