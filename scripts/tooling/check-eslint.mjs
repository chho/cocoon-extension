import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { ESLint } from "eslint";

import {
  collectWarningEntries,
  compareWarningBaseline,
  countWarnings,
  parseWarningBaseline,
} from "./eslint-baseline.mjs";
import { ESLINT_TARGET_PATTERNS } from "./project-scope.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "eslint-warning-baseline.json");

function describeWarning(warning) {
  const rule = warning.ruleId ?? "unknown-rule";
  const messageId = warning.messageId ?? "unknown-message";
  return `${warning.path} [${rule}/${messageId}] x${warning.count}\n  ${warning.message}\n  ${warning.sourceLine}`;
}

const eslint = new ESLint({ cwd: projectRoot });
const results = await eslint.lintFiles(ESLINT_TARGET_PATTERNS);
const errorCount = results.reduce((total, result) => total + result.errorCount, 0);

if (errorCount > 0) {
  const formatter = await eslint.loadFormatter("stylish");
  console.error(await formatter.format(results.filter((result) => result.errorCount > 0)));
  process.exitCode = 1;
} else {
  const baselineValue = JSON.parse(await readFile(baselinePath, "utf8"));
  const baselineWarnings = parseWarningBaseline(baselineValue);
  const actualWarnings = collectWarningEntries(results, projectRoot);
  const comparison = compareWarningBaseline(baselineWarnings, actualWarnings);

  if (!comparison.matches) {
    if (comparison.added.length > 0) {
      console.error(
        `New or worsened ESLint warnings (${countWarnings(comparison.added)}):\n${comparison.added.map(describeWarning).join("\n")}`,
      );
    }
    if (comparison.stale.length > 0) {
      console.error(
        `Resolved or changed baseline warnings to remove (${countWarnings(comparison.stale)}):\n${comparison.stale.map(describeWarning).join("\n")}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `ESLint warning baseline matched: ${countWarnings(actualWarnings)} warnings across ${actualWarnings.length} fingerprints.`,
    );
  }
}
