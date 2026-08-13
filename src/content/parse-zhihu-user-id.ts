const ZHIHU_ORIGIN = "https://www.zhihu.com";

export function parseZhihuUserId(profileHref: string): string | null {
  try {
    const profileUrl = new URL(profileHref, `${ZHIHU_ORIGIN}/`);
    if (profileUrl.origin !== ZHIHU_ORIGIN) {
      return null;
    }

    const profilePath = /^\/people\/([^/]+)\/?$/.exec(profileUrl.pathname);
    if (!profilePath) {
      return null;
    }

    const userId = decodeURIComponent(profilePath[1]);
    if (
      !userId ||
      userId !== userId.trim() ||
      userId.includes("/") ||
      userId.includes("\\")
    ) {
      return null;
    }

    return userId;
  } catch {
    return null;
  }
}
