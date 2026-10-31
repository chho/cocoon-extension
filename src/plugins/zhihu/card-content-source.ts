import {
  parseZhihuContentHref,
  resolveZhihuContentSource,
  type ZhihuContentSource,
} from "../../content/zhihu-content-source.ts";
import type * as SourcePostModule from "../../core/source-post.ts";
import type { SourcePost } from "../../core/source-post.ts";
// @ts-expect-error Vite resolves the content-only copy during bundling.
import * as contentSourcePost from "../../core/source-post.ts?content-copy";
const { parseSourcePost } = contentSourcePost as typeof SourcePostModule;

function ownTitleLinks(card: HTMLElement): HTMLAnchorElement[] {
  const content = card.querySelector<HTMLElement>(".ContentItem[data-zop]");
  if (!content) return [];
  // Expanded text and nested cards cannot supply the current card's provenance.
  return Array.from(
    content.querySelectorAll<HTMLAnchorElement>(".ContentItem-title a[href]"),
  ).filter(
    (link) =>
      link.closest(".ContentItem") === content &&
      link.closest(".RichContent-inner, .RichText") === null,
  );
}

export function getCardContentSource(card: HTMLElement): ZhihuContentSource | null {
  return resolveZhihuContentSource(
    ownTitleLinks(card).map((link) => link.getAttribute("href") ?? ""),
  );
}

function matchesCapturedSource(
  source: ZhihuContentSource,
  expected: ZhihuContentSource | null,
): boolean {
  if (!expected || source.kind !== expected.kind || source.contentId !== expected.contentId) {
    return false;
  }
  return (
    source.kind !== "answer" ||
    (expected.kind === "answer" && source.questionId === expected.questionId)
  );
}

export function getCardSourcePost(
  card: HTMLElement,
  expected: ZhihuContentSource | null,
): SourcePost | null {
  const links = ownTitleLinks(card);
  if (links.length !== 1) return null;
  const link = links[0];
  const href = link.getAttribute("href") ?? "";
  const source = parseZhihuContentHref(href);
  if (!source || !matchesCapturedSource(source, expected)) return null;
  const url = new URL(href, "https://www.zhihu.com/");
  if (url.username || url.password) return null;
  return parseSourcePost({
    postId: `zhihu:${source.kind}:${source.contentId}`,
    platformId: "zhihu",
    kind: source.kind,
    contentId: source.contentId,
    title: (link.textContent ?? "").trim(),
    url:
      source.kind === "answer"
        ? `https://www.zhihu.com/question/${source.questionId}/answer/${source.contentId}`
        : `https://zhuanlan.zhihu.com/p/${source.contentId}`,
  });
}
