import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { compareFormatBaseline, parseFormatBaseline } from "./format-baseline.mjs";
import { collectFormatTargets, inspectFormatFiles } from "./prettier-files.mjs";
import { isMaintainedFormatPath } from "./project-scope.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "prettier-baseline.json");
const baseline = parseFormatBaseline(JSON.parse(await readFile(baselinePath, "utf8")));
const invalidEntries = baseline
  .map((entry) => entry.path)
  .filter((path) => !isMaintainedFormatPath(path));

if (invalidEntries.length > 0) {
  console.error(`Prettier baseline contains out-of-scope paths:\n${invalidEntries.join("\n")}`);
  process.exitCode = 1;
} else {
  const files = await inspectFormatFiles(projectRoot, await collectFormatTargets(projectRoot));
  const comparison = compareFormatBaseline(baseline, files);

  if (!comparison.matches) {
    const failures = [
      ["Changed baseline files that remain unformatted", comparison.changedDebt],
      ["New Prettier violations", comparison.newViolations],
      ["Resolved baseline entries to remove", comparison.staleResolved],
      ["Missing baseline files", comparison.missingFiles],
    ];
    for (const [label, paths] of failures) {
      if (paths.length > 0) {
        console.error(`${label} (${paths.length}):\n${paths.join("\n")}`);
      }
    }
    process.exitCode = 1;
  } else if (comparison.exactDebt.length > 0) {
    console.warn(
      `Prettier baseline matched: ${comparison.exactDebt.length} unchanged legacy files remain.`,
    );
  } else {
    console.log("All format targets conform to Prettier.");
  }
}
