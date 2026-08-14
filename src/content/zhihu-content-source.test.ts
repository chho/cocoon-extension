import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  parseZhihuContentHref,
  resolveZhihuContentSource,
} from "./zhihu-content-source.ts";

test("VOTER-002 parses the contracted answer route", () => {
  deepStrictEqual(
    parseZhihuContentHref(
      "https://www.zhihu.com/question/123456/answer/987654?utm_source=feed",
    ),
    { kind: "answer", questionId: "123456", contentId: "987654" },
  );
});

test("VOTER-002 parses zhuanlan and contracted www article routes", () => {
  deepStrictEqual(parseZhihuContentHref("https://zhuanlan.zhihu.com/p/12345"), {
    kind: "article",
    contentId: "12345",
  });
  deepStrictEqual(parseZhihuContentHref("/p/54321"), {
    kind: "article",
    contentId: "54321",
  });
});

test("VOTER-002 rejects off-origin, malformed, and lookalike paths", () => {
  for (const href of [
    "https://example.com/question/1/answer/2",
    "https://www.zhihu.com/question/not-a-number/answer/2",
    "https://www.zhihu.com/question/1/answer/2/comments",
    "https://zhuanlan.zhihu.com/p/not-a-number",
    "not a valid URL%",
  ]) {
    strictEqual(parseZhihuContentHref(href), null);
  }
});

test("VOTER-001/002 enables a card only when all content links resolve unambiguously", () => {
  deepStrictEqual(
    resolveZhihuContentSource([
      "/question/1/answer/2",
      "https://www.zhihu.com/question/1/answer/2?from=feed",
      "/people/someone",
    ]),
    { kind: "answer", questionId: "1", contentId: "2" },
  );
  strictEqual(
    resolveZhihuContentSource([
      "/question/1/answer/2",
      "/question/1/answer/3",
    ]),
    null,
  );
  strictEqual(
    resolveZhihuContentSource([
      "/question/1/answer/2",
      "/question/9/answer/2",
    ]),
    null,
  );
  strictEqual(resolveZhihuContentSource(["/people/someone"]), null);
});
