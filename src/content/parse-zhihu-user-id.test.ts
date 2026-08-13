import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { parseZhihuUserId } from "./parse-zhihu-user-id.ts";

test("parses an absolute Zhihu profile URL", () => {
  strictEqual(
    parseZhihuUserId("https://www.zhihu.com/people/example-user"),
    "example-user",
  );
});

test("parses a relative Zhihu profile URL", () => {
  strictEqual(parseZhihuUserId("/people/example-user"), "example-user");
});

test("percent-decodes a valid user ID", () => {
  strictEqual(
    parseZhihuUserId("/people/%E5%BC%A0%E4%B8%89"),
    "张三",
  );
});

test("rejects an off-origin URL", () => {
  strictEqual(
    parseZhihuUserId("https://example.com/people/example-user"),
    null,
  );
});

test("rejects a non-people path", () => {
  strictEqual(parseZhihuUserId("/question/example-user"), null);
});

test("rejects a nested people path", () => {
  strictEqual(parseZhihuUserId("/people/example-user/answers"), null);
});

test("rejects encoded slashes and backslashes", () => {
  strictEqual(parseZhihuUserId("/people/example%2Fuser"), null);
  strictEqual(parseZhihuUserId("/people/example%5Cuser"), null);
});

test("rejects whitespace around a user ID", () => {
  strictEqual(parseZhihuUserId("/people/%20example-user%20"), null);
});

test("rejects malformed percent encoding", () => {
  strictEqual(parseZhihuUserId("/people/%E0%A4%A"), null);
});

test("rejects empty or missing user IDs", () => {
  strictEqual(parseZhihuUserId("/people/"), null);
  strictEqual(parseZhihuUserId("/people"), null);
});
