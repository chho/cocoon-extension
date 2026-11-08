export const ZHIHU_ORIGIN = "https://www.zhihu.com";
export const VOTER_PAGE_SIZE = 50;

function canUpgradeArticleNext(
  url: URL,
  expectedPath: string,
  expectedOrder: string | null,
): boolean {
  return (
    url.origin === "http://www.zhihu.com" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    expectedOrder !== null &&
    url.searchParams.getAll("order").length === 1 &&
    /^\/api\/v4\/articles\/[1-9]\d{0,63}\/likers$/.test(expectedPath)
  );
}

export function validateAndNormalizeNextUrl(
  next: string,
  expectedPath: string,
  expectedOrder: "default" | "newest" | null,
): string | null {
  try {
    const url = new URL(next, `${ZHIHU_ORIGIN}/`);
    if (url.protocol === "http:") {
      if (!canUpgradeArticleNext(url, expectedPath, expectedOrder)) return null;
      // Zhihu article paging can advertise HTTP; never send credentials over that URL.
      url.protocol = "https:";
    }
    if (url.origin !== ZHIHU_ORIGIN || url.pathname !== expectedPath) return null;
    if (expectedOrder !== null && url.searchParams.get("order") !== expectedOrder) return null;
    url.searchParams.set("limit", String(VOTER_PAGE_SIZE));
    return url.toString();
  } catch {
    return null;
  }
}
