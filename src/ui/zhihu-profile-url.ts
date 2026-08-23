const ZHIHU_PROFILE_BASE_URL = "https://www.zhihu.com/people/";

export function createZhihuProfileUrl(userId: string): string {
  return `${ZHIHU_PROFILE_BASE_URL}${encodeURIComponent(userId)}`;
}
