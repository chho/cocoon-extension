import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { compareWarningBaseline } from "./eslint-baseline.mjs";

function warning(overrides = {}) {
  return {
    path: "src/example.ts",
    ruleId: "complexity",
    messageId: "complex",
    message: "Function 'example' has a complexity of 11. Maximum allowed is 10.",
    sourceLine: "function example(value) {",
    count: 1,
    ...overrides,
  };
}

test("an unchanged warning baseline passes", () => {
  const baseline = [warning()];

  deepStrictEqual(compareWarningBaseline(baseline, structuredClone(baseline)), {
    added: [],
    stale: [],
    matches: true,
  });
});

test("removing one warning and adding another fails as substitution", () => {
  const comparison = compareWarningBaseline(
    [warning()],
    [warning({ ruleId: "max-depth", messageId: "tooDeeply", message: "Too deeply nested." })],
  );

  strictEqual(comparison.matches, false);
  strictEqual(comparison.added.length, 1);
  strictEqual(comparison.stale.length, 1);
});

test("worsening a metric fails even when the warning count is unchanged", () => {
  const comparison = compareWarningBaseline(
    [warning()],
    [warning({ message: "Function 'example' has a complexity of 12. Maximum allowed is 10." })],
  );

  strictEqual(comparison.matches, false);
  strictEqual(comparison.added.length, 1);
  strictEqual(comparison.stale.length, 1);
});

test("resolved warning debt fails until its baseline entry is removed", () => {
  const comparison = compareWarningBaseline([warning()], []);

  strictEqual(comparison.matches, false);
  strictEqual(comparison.added.length, 0);
  deepStrictEqual(comparison.stale, [warning()]);
});
