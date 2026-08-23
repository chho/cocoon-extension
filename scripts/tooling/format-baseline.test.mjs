import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { compareFormatBaseline, hashContent, planDefaultFormat } from "./format-baseline.mjs";
import { isMaintainedFormatPath, isMaintainedLintPath } from "./project-scope.mjs";

const legacySource = "const legacy={value:true}\n";

function baseline(path = "src/legacy.ts", source = legacySource) {
  return { path, sha256: hashContent(source) };
}

function file(overrides = {}) {
  return {
    path: "src/legacy.ts",
    hash: hashContent(legacySource),
    unformatted: true,
    ...overrides,
  };
}

test("exact unchanged Prettier debt passes", () => {
  const comparison = compareFormatBaseline([baseline()], [file()]);

  strictEqual(comparison.matches, true);
  deepStrictEqual(comparison.exactDebt, ["src/legacy.ts"]);
});

test("changed baseline debt fails even when it remains unformatted", () => {
  const comparison = compareFormatBaseline(
    [baseline()],
    [file({ hash: hashContent("const legacy = {changed:true}\n") })],
  );

  strictEqual(comparison.matches, false);
  deepStrictEqual(comparison.changedDebt, ["src/legacy.ts"]);
});

test("a new unformatted file fails without a baseline entry", () => {
  const comparison = compareFormatBaseline(
    [],
    [file({ path: "src/new.ts", hash: hashContent("const value={new:true}\n") })],
  );

  strictEqual(comparison.matches, false);
  deepStrictEqual(comparison.newViolations, ["src/new.ts"]);
});

test("resolved debt fails until its baseline entry is removed", () => {
  const comparison = compareFormatBaseline([baseline()], [file({ unformatted: false })]);

  strictEqual(comparison.matches, false);
  deepStrictEqual(comparison.staleResolved, ["src/legacy.ts"]);
});

test("a baseline entry whose file is missing fails", () => {
  const comparison = compareFormatBaseline([baseline()], []);

  strictEqual(comparison.matches, false);
  deepStrictEqual(comparison.missingFiles, ["src/legacy.ts"]);
});

test("ignored roots are outside the maintained formatting scope", () => {
  for (const path of [
    "docs/local.ts",
    "dist/assets/content.js",
    "node_modules/package/index.js",
    ".pi/private.ts",
  ]) {
    strictEqual(isMaintainedFormatPath(path), false, path);
  }
  strictEqual(isMaintainedFormatPath("scripts/tooling/format.mjs"), true);
  strictEqual(isMaintainedLintPath("docs/local.js"), false);
  strictEqual(isMaintainedLintPath("scripts/tooling/check-eslint.mjs"), true);
});

test("safe default formatting skips exact debt and plans all other violations", () => {
  const exactEntry = baseline();
  const changedEntry = baseline("src/changed.ts", "const changed={old:true}\n");
  const files = [
    file(),
    file({ path: "src/changed.ts", hash: hashContent("const changed={new:true}\n") }),
    file({ path: "src/new.ts", hash: hashContent("const fresh={value:true}\n") }),
  ];

  const plan = planDefaultFormat([exactEntry, changedEntry], files);

  deepStrictEqual(plan.formatPaths, ["src/changed.ts", "src/new.ts"]);
  deepStrictEqual(plan.retainedBaseline, [exactEntry]);
  deepStrictEqual(plan.skippedBaselinePaths, ["src/legacy.ts"]);
});
