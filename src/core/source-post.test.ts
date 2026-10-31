import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { isSourcePostId, parseSourcePost } from "./source-post.ts";

const answer = {
  postId: "zhihu:answer:23",
  platformId: "zhihu",
  kind: "answer",
  contentId: "23",
  title: "Synthetic <title>",
  url: "https://www.zhihu.com/question/12/answer/23",
};

test("POST-001 accepts only canonical exact post records with bounded Unicode titles", () => {
  deepStrictEqual(parseSourcePost(answer), answer);
  const article = {
    ...answer,
    postId: "zhihu:article:23",
    kind: "article",
    url: "https://zhuanlan.zhihu.com/p/23",
  };
  deepStrictEqual(parseSourcePost(article), article);
  strictEqual(parseSourcePost({ ...answer, title: "😀".repeat(500) })?.title.length, 1000);
  for (const patch of [
    { title: "" },
    { title: " title " },
    { title: "😀".repeat(501) },
    { extra: true },
    { platformId: "other" },
    { contentId: "023" },
    { postId: "zhihu:answer:24" },
    { url: answer.url + "?x=1" },
    { url: answer.url + "#x" },
    { url: answer.url + "\n" },
    { url: "https://user@www.zhihu.com/question/12/answer/23" },
    { url: "https://www.zhihu.com/question/012/answer/23" },
    { url: "https://www.zhihu.com/question/12/answer/24" },
    { url: "http://www.zhihu.com/question/12/answer/23" },
  ])
    strictEqual(parseSourcePost({ ...answer, ...patch }), null);
  for (const id of ["zhihu:answer:1", "zhihu:article:" + "9".repeat(64)])
    strictEqual(isSourcePostId(id), true);
  for (const id of [
    null,
    "zhihu:answer:1\n",
    "zhihu:answer:0",
    "zhihu:answer:01",
    "zhihu:answer:" + "9".repeat(65),
    "other:answer:1",
    "zhihu:question:1",
  ])
    strictEqual(isSourcePostId(id), false);
});
