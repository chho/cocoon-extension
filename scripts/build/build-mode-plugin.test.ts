import { strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "vite";

const root = resolve(import.meta.dirname, "../..");

test("BUILD-001 project config selects isolated output directories for both build modes", async () => {
  for (const mode of ["production", "diagnostic"]) {
    const config = await resolveConfig({ root, mode, logLevel: "silent" }, "build");
    strictEqual(config.build.outDir, mode === "diagnostic" ? "dist-dev" : "dist");
    strictEqual(config.build.emptyOutDir, true);
    strictEqual(config.publicDir, "");
  }
});

test("BUILD-001 commands retain production defaults and explicitly opt into diagnostics", async () => {
  const { scripts } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  strictEqual(scripts.build, "tsc --noEmit && vite build");
  strictEqual(scripts.dev, "vite build --watch");
  strictEqual(scripts["build:dev"], "tsc --noEmit && vite build --mode diagnostic");
  strictEqual(scripts["build:all"], "npm run build && npm run build:dev");
  strictEqual(scripts["dev:diagnostic"], "vite build --watch --mode diagnostic");
  strictEqual(scripts.test.includes("src/diagnostics/*.test.ts"), true);
});
