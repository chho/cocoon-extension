import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createZhihuProfileUrl } from "./zhihu-profile-url.ts";

test("PROFILE-001/AC-086 constructs an exact encoded Zhihu profile URL", () => {
  strictEqual(
    createZhihuProfileUrl("author/with ?query#fragment%"),
    "https://www.zhihu.com/people/author%2Fwith%20%3Fquery%23fragment%25",
  );
});
