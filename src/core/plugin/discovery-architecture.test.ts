import { strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

test("ARCH-001 discovery uses only eager Vite globs for bundled local plugins", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "discovery.ts"),
    "utf8",
  );
  strictEqual((source.match(/import\.meta\.glob/g) ?? []).length, 2);
  strictEqual((source.match(/eager:\s*true/g) ?? []).length, 2);
  strictEqual(/\bimport\s*\(/.test(source), false);
  strictEqual(/\beval\s*\(/.test(source), false);
  strictEqual(/new\s+Function\b/.test(source), false);
});

test("ARCH-004 Zhihu runtime imports its descriptor instead of duplicating metadata", async () => {
  const pluginSource = await readFile(
    resolve(import.meta.dirname, "../../plugins/zhihu/plugin.ts"),
    "utf8",
  );
  strictEqual(pluginSource.includes('from "./plugin.json"'), true);
  strictEqual(pluginSource.includes("https://www.zhihu.com/"), false);
  strictEqual(/\bid:\s*["']zhihu["']/.test(pluginSource), false);
});
