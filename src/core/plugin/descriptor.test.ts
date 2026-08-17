import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  parseChromeMatchPattern,
  urlMatchesChromePattern,
  validatePluginDescriptor,
} from "./descriptor.ts";

test("ARCH-004 accepts strict local descriptor metadata", () => {
  deepStrictEqual(validatePluginDescriptor({
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
  }), {
    valid: true,
    descriptor: {
      id: "zhihu",
      matches: ["https://www.zhihu.com/"],
    },
  });
});

test("ARCH-004 rejects extra keys, invalid IDs, empty matches, and duplicate matches", () => {
  for (const descriptor of [
    { id: "zhihu", matches: ["https://www.zhihu.com/"], permissions: ["tabs"] },
    { id: "", matches: ["https://www.zhihu.com/"] },
    { id: "Zhihu", matches: ["https://www.zhihu.com/"] },
    { id: "zhihu", matches: [] },
    {
      id: "zhihu",
      matches: ["https://www.zhihu.com/", "https://www.zhihu.com/"],
    },
  ]) {
    strictEqual(validatePluginDescriptor(descriptor).valid, false);
  }
});

test("ARCH-004 validates explicit Chrome patterns and rejects broad or malformed patterns", () => {
  for (const pattern of [
    "https://www.zhihu.com/",
    "https://*.example.com/*",
    "*://example.com/path/*",
    "file:///local/*",
  ]) {
    strictEqual(parseChromeMatchPattern(pattern) !== null, true, pattern);
  }
  for (const pattern of [
    "",
    "<all_urls>",
    "https://www.zhihu.com",
    "https://*foo.example.com/*",
    "https://example.com:443/*",
    "javascript://example.com/*",
  ]) {
    strictEqual(parseChromeMatchPattern(pattern), null, pattern);
  }
});

test("ARCH-002 URL matching follows scheme, wildcard host, and path without widening exact root", () => {
  strictEqual(
    urlMatchesChromePattern(
      new URL("https://www.zhihu.com/?from=test"),
      "https://www.zhihu.com/",
    ),
    true,
  );
  strictEqual(
    urlMatchesChromePattern(
      new URL("https://www.zhihu.com/question/1"),
      "https://www.zhihu.com/",
    ),
    false,
  );
  strictEqual(
    urlMatchesChromePattern(
      new URL("https://sub.example.com/feed/1"),
      "https://*.example.com/feed/*",
    ),
    true,
  );
});
