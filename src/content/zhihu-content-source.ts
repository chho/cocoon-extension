const ZHIHU_ORIGIN = "https://www.zhihu.com";
const ZHUANLAN_ORIGIN = "https://zhuanlan.zhihu.com";

export type ZhihuContentSource =
  | {
      readonly kind: "answer";
      readonly contentId: string;
      readonly questionId: string;
    }
  | { readonly kind: "article"; readonly contentId: string };

export function parseZhihuContentHref(
  href: string,
): ZhihuContentSource | null {
  try {
    const url = new URL(href, `${ZHIHU_ORIGIN}/`);
    if (url.origin === ZHIHU_ORIGIN) {
      const answerMatch = /^\/question\/(\d+)\/answer\/(\d+)\/?$/.exec(
        url.pathname,
      );
      if (answerMatch) {
        return {
          kind: "answer",
          questionId: answerMatch[1],
          contentId: answerMatch[2],
        };
      }

      const articleMatch = /^\/p\/(\d+)\/?$/.exec(url.pathname);
      return articleMatch
        ? { kind: "article", contentId: articleMatch[1] }
        : null;
    }

    if (url.origin === ZHUANLAN_ORIGIN) {
      const articleMatch = /^\/p\/(\d+)\/?$/.exec(url.pathname);
      return articleMatch
        ? { kind: "article", contentId: articleMatch[1] }
        : null;
    }

    return null;
  } catch {
    return null;
  }
}

function sourceKey(source: ZhihuContentSource): string {
  return source.kind === "answer"
    ? `${source.kind}:${source.questionId}:${source.contentId}`
    : `${source.kind}:${source.contentId}`;
}

export function resolveZhihuContentSource(
  hrefs: Iterable<string>,
): ZhihuContentSource | null {
  const sources = new Map<string, ZhihuContentSource>();
  for (const href of hrefs) {
    const source = parseZhihuContentHref(href);
    if (source) {
      sources.set(sourceKey(source), source);
    }
  }

  return sources.size === 1 ? (sources.values().next().value ?? null) : null;
}
