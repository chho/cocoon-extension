export const ZHIHU_ORIGIN = "https://www.zhihu.com";
export const VOTER_PAGE_SIZE = 50;

export function validateAndNormalizeNextUrl(
  next: string,
  expectedPath: string,
  expectedOrder: "default" | "newest" | null,
): string | null {
  try {
    const url = new URL(next, `${ZHIHU_ORIGIN}/`);
    if (url.origin !== ZHIHU_ORIGIN || url.pathname !== expectedPath) return null;
    if (expectedOrder !== null && url.searchParams.get("order") !== expectedOrder) return null;
    url.searchParams.set("limit", String(VOTER_PAGE_SIZE));
    return url.toString();
  } catch {
    return null;
  }
}
