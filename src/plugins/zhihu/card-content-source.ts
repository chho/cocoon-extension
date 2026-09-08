import {
  resolveZhihuContentSource,
  type ZhihuContentSource,
} from "../../content/zhihu-content-source.ts";

export function getCardContentSource(card: HTMLElement): ZhihuContentSource | null {
  const content = card.querySelector<HTMLElement>(".ContentItem[data-zop]");
  if (!content) return null;
  // Expanded text can link to other answers/articles; only the card's own title identifies it.
  const hrefs = Array.from(
    content.querySelectorAll<HTMLAnchorElement>(".ContentItem-title a[href]"),
  )
    .filter(
      (link) =>
        link.closest(".ContentItem") === content &&
        link.closest(".RichContent-inner, .RichText") === null,
    )
    .map((link) => link.getAttribute("href") ?? "");
  return resolveZhihuContentSource(hrefs);
}
