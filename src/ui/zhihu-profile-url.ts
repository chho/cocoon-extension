const ZHIHU_PROFILE_BASE_URL = "https://www.zhihu.com/people/";
const ZHIHU_PLATFORM_ID = "zhihu";

export function createZhihuProfileUrl(userId: string): string {
  return `${ZHIHU_PROFILE_BASE_URL}${encodeURIComponent(userId)}`;
}

export function createAuthorProfileUrl(
  platformId: string,
  userId: string,
): string | null {
  return platformId === ZHIHU_PLATFORM_ID
    ? createZhihuProfileUrl(userId)
    : null;
}
