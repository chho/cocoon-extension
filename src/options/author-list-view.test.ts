import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import type { AuthorListItem } from "../ui/blacklist-view-model.ts";
import { createAuthorProfileUrl } from "../ui/zhihu-profile-url.ts";
import {
  renderAuthorListRows,
  resetAuthorListViewport,
} from "./author-list-view.ts";

function items(count: number, prefix = "Author"): readonly AuthorListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    author: {
      platformId: "zhihu",
      userId: `internal-${prefix}-${index}`,
      memberHashId: null,
      authorName: `${prefix} ${index}`,
      tagId: "default",
      blacklistedAt: "2026-08-21T10:00:00.000Z",
      source: "direct" as const,
    },
    tag: { tagId: "default", name: "default", isDefault: true },
  }));
}

function createFixture() {
  const dom = new JSDOM("<div id='viewport'><div id='list'></div></div>");
  const document = dom.window.document;
  const viewport = document.querySelector<HTMLElement>("#viewport");
  const list = document.querySelector<HTMLElement>("#list");
  if (!viewport || !list) {
    throw new Error("test fixture is incomplete");
  }
  const createRow = (item: AuthorListItem): HTMLElement => {
    const row = document.createElement("div");
    row.className = "author-row";
    row.textContent = item.author.authorName;
    return row;
  };
  return { viewport, list, createRow };
}

test("MANAGE-001 candidates up to 200 render the first 50 then append exactly 50", () => {
  const fixture = createFixture();
  const candidates = items(120);
  const first = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 50,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(first.loadedCount, 50);
  strictEqual(first.mountedRowCount, 50);
  strictEqual(first.virtualized, false);
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 50);
  strictEqual(fixture.list.lastElementChild?.textContent, "Author 49");

  const second = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 100,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(second.loadedCount, 100);
  strictEqual(second.mountedRowCount, 100);
  strictEqual(second.virtualized, false);
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 100);
  strictEqual(fixture.list.lastElementChild?.textContent, "Author 99");
});

test("MANAGE-001 exactly 200 candidates retain incremental non-virtual rendering", () => {
  const fixture = createFixture();
  const candidates = items(200);
  const result = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 100,
    scrollTop: 500,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(result.virtualized, false);
  strictEqual(result.mountedRowCount, 100);
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 100);
  strictEqual(fixture.list.style.height, "");
});

test("MANAGE-001 over 200 candidates use a spacer and translated fixed-row virtual range", () => {
  const fixture = createFixture();
  const candidates = items(250);
  const result = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 250,
    scrollTop: 640,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  const rows = fixture.list.querySelector<HTMLElement>(".virtual-rows");
  strictEqual(result.virtualized, true);
  strictEqual(result.loadedCount, 250);
  strictEqual(result.mountedRowCount, 18);
  strictEqual(fixture.list.style.height, "16000px");
  strictEqual(rows?.style.transform, "translateY(384px)");
  strictEqual(rows?.querySelectorAll(".author-row").length, 18);
  strictEqual(result.mountedRowCount < candidates.length, true);
});

test("MANAGE-001 virtual scrolling reaches the final row without mounting every candidate", () => {
  const fixture = createFixture();
  const candidates = items(250);
  const result = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 250,
    scrollTop: 15_360,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  const mounted = fixture.list.querySelectorAll(".author-row");
  strictEqual(result.mountedRowCount, 14);
  strictEqual(mounted.length, 14);
  strictEqual(mounted.item(mounted.length - 1).textContent, "Author 249");
  strictEqual(result.mountedRowCount < candidates.length, true);

  const overscrolled = renderAuthorListRows({
    list: fixture.list,
    items: candidates,
    loadedCount: 250,
    scrollTop: 100_000,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(overscrolled.mountedRowCount, 0);
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 0);
  strictEqual(
    fixture.list.querySelector<HTMLElement>(".virtual-rows")?.style.transform,
    "translateY(16000px)",
  );
});

test("MANAGE-001 filter reset restores the first batch and top scroll position", () => {
  const fixture = createFixture();
  fixture.viewport.scrollTop = 2_400;
  const loadedCount = resetAuthorListViewport(fixture.viewport);
  strictEqual(loadedCount, 50);
  strictEqual(fixture.viewport.scrollTop, 0);

  const filtered = items(80, "Filtered");
  const result = renderAuthorListRows({
    list: fixture.list,
    items: filtered,
    loadedCount,
    scrollTop: fixture.viewport.scrollTop,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(result.loadedCount, 50);
  strictEqual(result.mountedRowCount, 50);
  strictEqual(fixture.list.firstElementChild?.textContent, "Filtered 0");
  strictEqual(fixture.list.lastElementChild?.textContent, "Filtered 49");
});

function createFocusFixture() {
  const dom = new JSDOM("<div id='viewport' tabindex='0'><div id='list'></div></div>");
  const document = dom.window.document;
  const viewport = document.querySelector<HTMLElement>("#viewport");
  const list = document.querySelector<HTMLElement>("#list");
  if (!viewport || !list) throw new Error("focus fixture is incomplete");
  let rowsCreated = 0;
  const createRow = (item: AuthorListItem): HTMLElement => {
    rowsCreated += 1;
    const row = document.createElement("div");
    row.className = "author-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `选择 ${item.author.authorName}`);
    const profileUrl = createAuthorProfileUrl(
      item.author.platformId,
      item.author.userId,
    );
    const name = profileUrl
      ? document.createElement("a")
      : document.createElement("span");
    name.className = "author-name";
    name.textContent = item.author.authorName;
    if (name instanceof document.defaultView!.HTMLAnchorElement) {
      name.href = profileUrl!;
      name.target = "_blank";
      name.rel = "noopener";
    }
    const remove = document.createElement("button");
    remove.textContent = "解除屏蔽";
    row.append(checkbox, name, remove);
    return row;
  };
  return { document, viewport, list, createRow, rowsCreated: () => rowsCreated };
}

test("MANAGE-001 unchanged virtual and incremental ranges preserve focused control nodes", () => {
  const virtual = createFocusFixture();
  const candidates = items(250);
  const options = {
    list: virtual.list,
    items: candidates,
    loadedCount: 250,
    scrollTop: 641,
    viewportHeight: 640,
    createRow: virtual.createRow,
    focusFallback: virtual.viewport,
  };
  renderAuthorListRows(options);
  const checkbox = virtual.list.querySelector<HTMLInputElement>("input");
  checkbox?.focus();
  const created = virtual.rowsCreated();
  renderAuthorListRows({ ...options, scrollTop: 650 });
  strictEqual(virtual.document.activeElement, checkbox);
  strictEqual(virtual.rowsCreated(), created);

  const incremental = createFocusFixture();
  const small = items(120);
  renderAuthorListRows({
    list: incremental.list,
    items: small,
    loadedCount: 50,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: incremental.createRow,
    focusFallback: incremental.viewport,
  });
  const remove = incremental.list.querySelector<HTMLButtonElement>("button");
  remove?.focus();
  const incrementalCreated = incremental.rowsCreated();
  renderAuthorListRows({
    list: incremental.list,
    items: small,
    loadedCount: 50,
    scrollTop: 500,
    viewportHeight: 640,
    createRow: incremental.createRow,
    focusFallback: incremental.viewport,
  });
  strictEqual(incremental.document.activeElement, remove);
  strictEqual(incremental.rowsCreated(), incrementalCreated);
});

test("MANAGE-001 necessary virtual replacements restore equivalent controls or focus viewport", () => {
  const fixture = createFocusFixture();
  const candidates = items(250);
  const base = {
    list: fixture.list,
    items: candidates,
    loadedCount: 250,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  };
  renderAuthorListRows({ ...base, scrollTop: 640 });
  const rows = fixture.list.querySelectorAll<HTMLElement>(".author-row");
  const remove = rows.item(4).querySelector<HTMLButtonElement>("button");
  remove?.focus();
  renderAuthorListRows({ ...base, scrollTop: 704 });
  strictEqual(fixture.document.activeElement?.tagName, "BUTTON");
  strictEqual(fixture.document.activeElement === remove, false);

  renderAuthorListRows({ ...base, scrollTop: 640 });
  const profile = fixture.list.querySelectorAll<HTMLElement>(".author-row").item(4)
    .querySelector<HTMLAnchorElement>("a.author-name");
  profile?.focus();
  renderAuthorListRows({ ...base, scrollTop: 704 });
  strictEqual(fixture.document.activeElement?.tagName, "A");
  strictEqual(fixture.document.activeElement === profile, false);

  renderAuthorListRows({ ...base, scrollTop: 640 });
  fixture.list.querySelector<HTMLInputElement>("input")?.focus();
  renderAuthorListRows({ ...base, scrollTop: 10_000 });
  strictEqual(fixture.document.activeElement, fixture.viewport);
});

test("PROFILE-001/AC-086 filtering reset keeps encoded author profile links", () => {
  const fixture = createFocusFixture();
  const original = items(250, "Visible");
  renderAuthorListRows({
    list: fixture.list,
    items: original,
    loadedCount: 250,
    scrollTop: 640,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  });
  fixture.list.querySelector<HTMLInputElement>("input")?.focus();
  const filtered = items(30, "Filtered");
  resetAuthorListViewport(fixture.viewport);
  renderAuthorListRows({
    list: fixture.list,
    items: filtered,
    loadedCount: 50,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  });
  strictEqual(fixture.document.activeElement, fixture.viewport);
  const firstProfile = fixture.list.querySelector<HTMLAnchorElement>("a.author-name");
  strictEqual(firstProfile?.textContent, "Filtered 0");
  strictEqual(
    firstProfile?.href,
    "https://www.zhihu.com/people/internal-Filtered-0",
  );
});

test("PROFILE-002/AC-091 virtual refresh restores the same Zhihu profile link by composite identity", () => {
  const fixture = createFocusFixture();
  const original = items(250);
  const options = {
    list: fixture.list,
    items: original,
    loadedCount: 250,
    scrollTop: 640,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  };
  renderAuthorListRows(options);
  const focused = fixture.list.querySelectorAll<HTMLAnchorElement>("a.author-name").item(4);
  focused.focus();

  const refreshed = original.map(({ author, tag }) => ({
    author: { ...author },
    tag: { ...tag },
  }));
  renderAuthorListRows({ ...options, items: refreshed });

  const restored = fixture.document.activeElement;
  strictEqual(restored?.tagName, "A");
  strictEqual(restored === focused, false);
  strictEqual(restored?.textContent, focused.textContent);
  strictEqual((restored as HTMLAnchorElement).href, focused.href);
  strictEqual((restored as HTMLAnchorElement).target, "_blank");
  strictEqual((restored as HTMLAnchorElement).rel, "noopener");
});

test("PROFILE-002/AC-091 incremental and virtual rows never make other platforms focusable Zhihu links", () => {
  const fixture = createFocusFixture();
  const mixed = items(230).map((item, index) => ({
    ...item,
    author: {
      ...item.author,
      platformId: index % 3 === 0
        ? "zhihu"
        : index % 3 === 1
        ? "youtube"
        : "future-site",
      userId: `shared/id ${index}`,
    },
  }));

  const incremental = renderAuthorListRows({
    list: fixture.list,
    items: mixed.slice(0, 180),
    loadedCount: 100,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  });
  strictEqual(incremental.virtualized, false);
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 100);
  for (const link of fixture.list.querySelectorAll<HTMLAnchorElement>("a.author-name")) {
    strictEqual(link.href.startsWith("https://www.zhihu.com/people/"), true);
    strictEqual(link.href.includes("shared%2Fid%20"), true);
  }
  for (const text of fixture.list.querySelectorAll<HTMLElement>("span.author-name")) {
    strictEqual(text.hasAttribute("href"), false);
    strictEqual(text.hasAttribute("tabindex"), false);
    strictEqual(text.tabIndex, -1);
  }

  const virtualized = renderAuthorListRows({
    list: fixture.list,
    items: mixed,
    loadedCount: 230,
    scrollTop: 640,
    viewportHeight: 640,
    createRow: fixture.createRow,
    focusFallback: fixture.viewport,
  });
  strictEqual(virtualized.virtualized, true);
  strictEqual(virtualized.mountedRowCount < mixed.length, true);
  strictEqual(
    fixture.list.querySelectorAll("a.author-name").length +
      fixture.list.querySelectorAll("span.author-name").length,
    virtualized.mountedRowCount,
  );
  for (const text of fixture.list.querySelectorAll<HTMLElement>("span.author-name")) {
    strictEqual(text.tabIndex, -1);
    strictEqual(text.closest("a"), null);
  }
});

test("MANAGE-001 empty candidates replace stale rows with the empty state", () => {
  const fixture = createFixture();
  renderAuthorListRows({
    list: fixture.list,
    items: items(10),
    loadedCount: 10,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  const result = renderAuthorListRows({
    list: fixture.list,
    items: [],
    loadedCount: 50,
    scrollTop: 0,
    viewportHeight: 640,
    createRow: fixture.createRow,
  });
  strictEqual(result.mountedRowCount, 0);
  strictEqual(result.virtualized, false);
  strictEqual(fixture.list.textContent, "没有匹配的本地记录");
  strictEqual(fixture.list.querySelectorAll(".author-row").length, 0);
});
