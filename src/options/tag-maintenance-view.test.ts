import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import type { BlacklistTagUsageDto } from "../core/blacklist-query-rpc-contract.ts";
import {
  renderTagMaintenanceView,
  type TagMaintenanceViewOptions,
} from "./tag-maintenance-view.ts";

const TAGS: readonly BlacklistTagUsageDto[] = [
  { tagId: "default", name: "default", isDefault: true, authorCount: 0 },
  { tagId: "reading", name: "Reading", isDefault: false, authorCount: 2 },
  { tagId: "muted", name: "Muted", isDefault: false, authorCount: 0 },
];

interface TagTestView {
  readonly dom: JSDOM;
  readonly summary: HTMLElement;
  readonly container: HTMLElement;
}

function fixture(): TagTestView {
  const dom = new JSDOM("<p id='summary'></p><div id='tags' role='list'></div>");
  const summary = dom.window.document.querySelector<HTMLElement>("#summary");
  const container = dom.window.document.querySelector<HTMLElement>("#tags");
  if (!summary || !container) throw new Error("tag fixture is incomplete");
  return { dom, summary, container };
}

function render(
  view: TagTestView,
  callbacks: Pick<TagMaintenanceViewOptions, "onRename" | "onDelete">,
  pendingTagIds?: ReadonlySet<string>,
): void {
  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: TAGS,
    writesEnabled: true,
    pendingTagIds,
    ...callbacks,
  });
}

function required<ElementType extends Element>(
  container: ParentNode,
  selector: string,
): ElementType {
  const element = container.querySelector<ElementType>(selector);
  if (!element) throw new Error(`missing tag test element: ${selector}`);
  return element;
}

class TagEditorDriver {
  readonly row: HTMLElement;
  readonly rename: HTMLButtonElement;
  readonly editor: HTMLElement;
  readonly input: HTMLInputElement;
  readonly save: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;

  constructor(privateView: TagTestView) {
    this.row = required(privateView.container, ".tag-row");
    this.rename = required(this.row, "button[aria-label^='重命名标签']");
    this.editor = required(this.row, ".tag-editor");
    this.input = required(this.row, "input");
    this.save = required(this.row, ".tag-save");
    this.cancel = required(this.row, ".tag-editor .tag-action");
  }

  open(): void {
    this.rename.click();
  }

  setName(name: string): void {
    this.input.value = name;
    this.input.dispatchEvent(
      new this.input.ownerDocument.defaultView!.Event("input", { bubbles: true }),
    );
  }

  escapeFrom(control: HTMLElement): void {
    control.dispatchEvent(
      new control.ownerDocument.defaultView!.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  submit(): void {
    this.editor.dispatchEvent(
      new this.editor.ownerDocument.defaultView!.Event("submit", {
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

function assertClosed(view: TagTestView, driver: TagEditorDriver): void {
  strictEqual(driver.editor.hidden, true);
  strictEqual(view.dom.window.document.activeElement, driver.rename);
}

test("MANAGE-003/AC-087 hides default and presents custom tags with usage", () => {
  const view = fixture();
  render(view, { onRename() {}, onDelete() {} });

  strictEqual(view.summary.textContent, "2 个自定义标签");
  strictEqual(view.container.getAttribute("role"), "list");
  strictEqual(view.container.querySelectorAll(".tag-row").length, 2);
  strictEqual(view.container.textContent?.includes("default"), false);
  const usage = Array.from(view.container.querySelectorAll(".tag-usage")).map(
    (element) => element.textContent,
  );
  strictEqual(usage.join("|"), "2 位作者|未关联作者");
  strictEqual(view.container.querySelectorAll(".tag-editor:not([hidden]) input").length, 0);
  const editors = Array.from(view.container.querySelectorAll<HTMLElement>(".tag-editor"));
  strictEqual(
    editors.every((editor) => editor.hidden),
    true,
  );
});

test("MANAGE-003/AC-087 inline rename opens and Escape restores focus from every control", () => {
  const view = fixture();
  let renamedName: string | null = null;
  render(view, {
    onRename(_tag, name) {
      renamedName = name;
    },
    onDelete() {},
  });
  const driver = new TagEditorDriver(view);

  driver.open();
  strictEqual(driver.editor.hidden, false);
  strictEqual(view.dom.window.document.activeElement, driver.input);
  strictEqual(driver.input.selectionStart, 0);
  strictEqual(driver.input.selectionEnd, driver.input.value.length);
  strictEqual(driver.save.disabled, true);
  driver.setName("Changed");
  strictEqual(driver.save.disabled, false);
  driver.escapeFrom(driver.input);
  assertClosed(view, driver);

  for (const control of [driver.save, driver.cancel]) {
    driver.open();
    control.focus();
    driver.escapeFrom(control);
    assertClosed(view, driver);
  }
  strictEqual(renamedName, null);
});

test("MANAGE-003/AC-087 inline rename cancel, validation, and save retain exact values", () => {
  const view = fixture();
  let renamedName: string | null = null;
  render(view, {
    onRename(_tag, name) {
      renamedName = name;
    },
    onDelete() {},
  });
  const driver = new TagEditorDriver(view);

  driver.open();
  driver.setName("Cancelled");
  driver.cancel.click();
  assertClosed(view, driver);
  strictEqual(renamedName, null);

  driver.open();
  driver.setName("Muted");
  driver.submit();
  strictEqual(renamedName, null);
  strictEqual(driver.input.validationMessage, "标签名称已存在。");

  driver.setName("  Updated  ");
  driver.submit();
  strictEqual(renamedName, "  Updated  ");
});

test("MANAGE-003/AC-087 pending tags stay focusable while duplicate actions are guarded", () => {
  const view = fixture();
  let mutations = 0;
  render(
    view,
    {
      onRename() {
        mutations += 1;
      },
      onDelete() {
        mutations += 1;
      },
    },
    new Set(["reading"]),
  );
  const row = required<HTMLElement>(view.container, "[data-tag-id='reading']");
  const rename = required<HTMLButtonElement>(row, "button[aria-label^='重命名标签']");
  const remove = required<HTMLButtonElement>(row, "button[aria-label^='删除标签']");
  strictEqual(row.getAttribute("aria-busy"), "true");
  strictEqual(rename.disabled, false);
  strictEqual(rename.getAttribute("aria-disabled"), "true");
  strictEqual(remove.disabled, false);
  strictEqual(remove.getAttribute("aria-disabled"), "true");
  strictEqual(required<HTMLInputElement>(row, "input").readOnly, true);
  rename.focus();
  rename.click();
  remove.click();
  strictEqual(view.dom.window.document.activeElement, rename);
  strictEqual(mutations, 0);
});

test("MANAGE-003/AC-087 delete dispatches once and default-only state is instructive", () => {
  const view = fixture();
  let deleted = 0;
  render(view, {
    onRename() {},
    onDelete() {
      deleted += 1;
    },
  });
  required<HTMLButtonElement>(view.container, "button[aria-label='删除标签 Reading']").click();
  strictEqual(deleted, 1);

  renderTagMaintenanceView({
    container: view.container,
    summary: view.summary,
    tags: [TAGS[0]!] as readonly BlacklistTagUsageDto[],
    writesEnabled: true,
    onRename() {},
    onDelete() {},
  });
  strictEqual(view.summary.textContent, "0 个自定义标签");
  strictEqual(view.container.hasAttribute("role"), false);
  strictEqual(view.container.querySelectorAll(".tag-row").length, 0);
  strictEqual(required(view.container, ".tag-empty").getAttribute("role"), "status");
  strictEqual(
    required(view.container, ".tag-empty").textContent,
    "暂无自定义标签在知乎屏蔽作者时创建的标签会显示在这里。",
  );
});
