import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createAuthorProfileUrl,
  createZhihuProfileUrl,
} from "./zhihu-profile-url.ts";

test("PROFILE-002/AC-091 constructs an exact encoded Zhihu profile URL only for Zhihu", () => {
  const userId = "author/with ?query#fragment%";
  const expected =
    "https://www.zhihu.com/people/author%2Fwith%20%3Fquery%23fragment%25";
  strictEqual(createZhihuProfileUrl(userId), expected);
  strictEqual(createAuthorProfileUrl("zhihu", userId), expected);
  strictEqual(createAuthorProfileUrl("youtube", userId), null);
  strictEqual(createAuthorProfileUrl("future-site", userId), null);
});
