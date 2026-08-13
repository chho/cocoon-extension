import { rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  captureZhihuPage,
  createPageCaptureExpression,
} from "./zhihu-page-capture.mjs";

test("URL mismatch exits before every DOM query and fetch", async () => {
  let domQueries = 0;
  let fetches = 0;
  const environment = {
    location: {
      href: "https://www.zhihu.com/question/1",
      origin: "https://www.zhihu.com",
    },
    document: {
      querySelectorAll() {
        domQueries += 1;
        return [];
      },
    },
    async fetch() {
      fetches += 1;
      throw new Error("fetch must not run");
    },
  };

  await rejects(
    captureZhihuPage(environment, 3),
    /URL changed before capture/u,
  );
  strictEqual(domQueries, 0);
  strictEqual(fetches, 0);
});

test("serialized page capture expression carries the bounded limit", () => {
  const expression = createPageCaptureExpression(7);
  strictEqual(expression.includes("captureZhihuPage"), true);
  strictEqual(expression.endsWith("(globalThis, 7)"), true);
  strictEqual(
    expression.indexOf("environment.location.href") <
      expression.indexOf("environment.document.querySelectorAll"),
    true,
  );
});
