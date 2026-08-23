import { createHash } from "node:crypto";

export const FORMAT_BASELINE_VERSION = 1;

export function hashContent(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function compareFormatBaseline(baselineEntries, files) {
  const baselineByPath = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const exactDebt = [];
  const changedDebt = [];
  const newViolations = [];
  const staleResolved = [];
  const missingFiles = [];

  for (const entry of baselineEntries) {
    const file = filesByPath.get(entry.path);
    if (!file) {
      missingFiles.push(entry.path);
    } else if (!file.unformatted) {
      staleResolved.push(entry.path);
    } else if (file.hash !== entry.sha256) {
      changedDebt.push(entry.path);
    } else {
      exactDebt.push(entry.path);
    }
  }

  for (const file of files) {
    if (file.unformatted && !baselineByPath.has(file.path)) {
      newViolations.push(file.path);
    }
  }

  const sort = (paths) => paths.sort((left, right) => left.localeCompare(right));
  return {
    exactDebt: sort(exactDebt),
    changedDebt: sort(changedDebt),
    newViolations: sort(newViolations),
    staleResolved: sort(staleResolved),
    missingFiles: sort(missingFiles),
    matches:
      changedDebt.length === 0 &&
      newViolations.length === 0 &&
      staleResolved.length === 0 &&
      missingFiles.length === 0,
  };
}

export function planDefaultFormat(baselineEntries, files) {
  const comparison = compareFormatBaseline(baselineEntries, files);
  const skippedPaths = new Set(comparison.exactDebt);
  return {
    formatPaths: files
      .filter((file) => file.unformatted && !skippedPaths.has(file.path))
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right)),
    retainedBaseline: baselineEntries.filter((entry) => skippedPaths.has(entry.path)),
    skippedBaselinePaths: comparison.exactDebt,
  };
}

export function planExplicitFormat(baselineEntries, files, selectedPaths) {
  const selected = new Set(selectedPaths);
  return {
    formatPaths: files
      .filter((file) => selected.has(file.path) && file.unformatted)
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right)),
    retainedBaseline: baselineEntries.filter((entry) => !selected.has(entry.path)),
    skippedBaselinePaths: [],
  };
}

export function parseFormatBaseline(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== FORMAT_BASELINE_VERSION ||
    !Array.isArray(value.files)
  ) {
    throw new Error(`Invalid Prettier baseline: expected version ${FORMAT_BASELINE_VERSION}.`);
  }

  const entries = value.files.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      !/^[a-f\d]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`Invalid Prettier baseline entry at index ${index}.`);
    }
    return { path: entry.path, sha256: entry.sha256 };
  });

  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Invalid Prettier baseline: duplicate paths.");
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function serializeFormatBaseline(entries) {
  return `${JSON.stringify({ version: FORMAT_BASELINE_VERSION, files: entries }, null, 2)}\n`;
}
