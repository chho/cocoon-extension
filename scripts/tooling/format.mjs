import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

import {
  parseFormatBaseline,
  planDefaultFormat,
  planExplicitFormat,
  serializeFormatBaseline,
} from "./format-baseline.mjs";
import { collectFormatTargets, inspectFormatFiles } from "./prettier-files.mjs";
import { isMaintainedFormatPath, normalizeProjectPath } from "./project-scope.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "prettier-baseline.json");
const baselineSource = await readFile(baselinePath, "utf8");
const baseline = parseFormatBaseline(JSON.parse(baselineSource));
const absoluteTargets = await collectFormatTargets(projectRoot);
const files = await inspectFormatFiles(projectRoot, absoluteTargets);
const filesByPath = new Map(files.map((file) => [file.path, file]));
const argumentsAsPaths = process.argv.slice(2);

let plan;
if (argumentsAsPaths.length === 0) {
  plan = planDefaultFormat(baseline, files);
} else {
  const selectedPaths = argumentsAsPaths.map((argument) =>
    normalizeProjectPath(relative(projectRoot, resolve(projectRoot, argument))),
  );
  const invalidPaths = selectedPaths.filter(
    (path) => !isMaintainedFormatPath(path) || !filesByPath.has(path),
  );
  if (invalidPaths.length > 0) {
    throw new Error(
      `Explicit format paths must be existing maintained files:\n${invalidPaths.join("\n")}`,
    );
  }
  plan = planExplicitFormat(baseline, files, selectedPaths);
}

for (const path of plan.formatPaths) {
  const file = filesByPath.get(path);
  await writeFile(file.absolutePath, file.formatted, "utf8");
}

const nextBaselineSource = serializeFormatBaseline(plan.retainedBaseline);
if (nextBaselineSource !== baselineSource) {
  await writeFile(baselinePath, nextBaselineSource, "utf8");
}

console.log(`Formatted ${plan.formatPaths.length} file(s).`);
if (plan.skippedBaselinePaths.length > 0) {
  console.log(
    `Skipped ${plan.skippedBaselinePaths.length} exact unchanged legacy baseline file(s).`,
  );
}
