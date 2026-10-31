import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createOptionsAuthorRow } from "./options-author-row.ts";
import { renderAuthorListRows } from "./author-list-view.ts";
import type { AuthorListItem } from "../ui/blacklist-list-values.ts";
import { parseBlacklistAuthorDto } from "../core/blacklist-rpc-values.ts";

const post = {
  postId: "zhihu:answer:456",
  platformId: "zhihu" as const,
  kind: "answer" as const,
  contentId: "456",
  title: "<img src=x> 合成标题",
  url: "https://www.zhihu.com/question/123/answer/456",
};
const author = {
  platformId: "zhihu",
  userId: "synthetic-author",
  memberHashId: null,
  authorName: "Synthetic author",
  tagId: "default",
  blacklistedAt: "2026-10-30T00:00:00.000Z",
  source: "direct" as const,
  sourcePostId: post.postId,
  sourcePost: post,
};

test("POST-003 renders a safe text-only post link and explicit missing provenance", () => {
  const dom = new JSDOM("<!doctype html>");
  try {
    const options = {
      document: dom.window.document,
      item: { author, tag: { tagId: "default", name: "default", isDefault: true } },
      writesEnabled: true,
      selected: false,
      onSelectionChange: () => true,
      onRemove: () => {},
    };
    const row = createOptionsAuthorRow(options);
    const link = row.querySelector<HTMLAnchorElement>("a.source-post");
    strictEqual(link?.textContent, post.title);
    strictEqual(link?.href, post.url);
    strictEqual(link?.target, "_blank");
    strictEqual(link?.rel, "noopener");
    strictEqual(link?.getAttribute("aria-label"), `关联帖子：${post.title}`);
    strictEqual(row.querySelector("img"), null);
    strictEqual(row.querySelector(".source-name")?.textContent, "手动屏蔽");
    const missing = createOptionsAuthorRow({
      ...options,
      item: { ...options.item, author: { ...author, sourcePostId: null, sourcePost: null } },
    });
    strictEqual(missing.querySelector(".source-post")?.textContent, "未记录");
    strictEqual(missing.querySelector("a.source-post"), null);
  } finally {
    dom.window.close();
  }
});

test("POST-003 virtual refresh restores the same post link or the viewport fallback", () => {
  const dom = new JSDOM('<div tabindex="-1"><div id="list"></div></div>');
  try {
    const document = dom.window.document;
    const list = document.querySelector<HTMLElement>("#list")!;
    const item = { author, tag: { tagId: "default", name: "default", isDefault: true } };
    const options = {
      list,
      items: [item],
      loadedCount: 1,
      candidateCount: 201,
      scrollTop: 0,
      viewportHeight: 128,
      createRow: (rowItem: AuthorListItem) =>
        createOptionsAuthorRow({
          document,
          item: rowItem,
          writesEnabled: true,
          selected: false,
          onSelectionChange: () => true,
          onRemove: () => {},
        }),
    };
    renderAuthorListRows(options);
    list.querySelector<HTMLAnchorElement>("a.source-post")!.focus();
    renderAuthorListRows({ ...options, items: [{ ...item, author: { ...author } }] });
    strictEqual(document.activeElement, list.querySelector("a.source-post"));
    renderAuthorListRows({ ...options, items: [] });
    strictEqual(document.activeElement, list.parentElement);
  } finally {
    dom.window.close();
  }
});

test("POST-003 DTO validates matching post identity and safe URL; undo may carry only reference", () => {
  strictEqual(parseBlacklistAuthorDto(author)?.sourcePostId, post.postId);
  strictEqual(parseBlacklistAuthorDto({ ...author, sourcePost: null })?.sourcePostId, post.postId);
  for (const invalid of [
    { ...author, sourcePostId: null },
    { ...author, platformId: "youtube" },
    { ...author, sourcePostId: "zhihu:answer:999" },
    { ...author, sourcePost: { ...post, url: "javascript:alert(1)" } },
    { ...author, sourcePost: { ...post, extra: true } },
    { ...author, sourcePost: undefined },
  ])
    strictEqual(parseBlacklistAuthorDto(invalid), null);
});
