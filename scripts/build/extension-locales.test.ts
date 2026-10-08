import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { build } from "vite";

import { readBaseManifest } from "./plugin-manifest.ts";

test("store metadata resolves English and Chinese messages in the production bundle", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const manifest = await readBaseManifest(resolve(root, "public/manifest.json"));
  strictEqual(manifest.default_locale, "en");
  strictEqual(manifest.name, "__MSG_extensionName__");
  strictEqual(manifest.description, "__MSG_extensionDescription__");

  const result = await build({ root, logLevel: "silent", build: { write: false } });
  ok(!Array.isArray(result) && "output" in result);
  for (const locale of ["en", "zh_CN"]) {
    const asset = result.output.find(
      (item) => item.fileName === `_locales/${locale}/messages.json`,
    );
    ok(asset?.type === "asset");
    const text =
      typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString();
    const messages = JSON.parse(text) as Record<string, { message: string }>;
    deepStrictEqual(Object.keys(messages).sort(), ["extensionDescription", "extensionName"]);
    strictEqual(messages.extensionName.message, "Cocoon");
    ok(messages.extensionDescription.message.length <= 132);
    ok(messages.extensionDescription.message.includes(locale === "en" ? "Zhihu" : "知乎首页"));
  }
});
