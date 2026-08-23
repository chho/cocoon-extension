import { relative } from "node:path";

import { normalizeProjectPath } from "./project-scope.mjs";

export const ESLINT_BASELINE_VERSION = 1;

export function normalizeSourceLine(sourceLine) {
  return sourceLine.trim().replace(/\s+/gu, " ");
}

function warningKey(warning) {
  return JSON.stringify([
    warning.path,
    warning.ruleId,
    warning.messageId,
    warning.message,
    warning.sourceLine,
  ]);
}

function compareWarnings(left, right) {
  return warningKey(left).localeCompare(warningKey(right));
}

export function collectWarningEntries(results, projectRoot) {
  const warningCounts = new Map();

  for (const result of results) {
    const path = normalizeProjectPath(relative(projectRoot, result.filePath));
    const sourceLines = (result.source ?? "").split(/\r?\n/u);
    for (const message of result.messages) {
      if (message.severity !== 1) {
        continue;
      }

      const warning = {
        path,
        ruleId: message.ruleId ?? null,
        messageId: message.messageId ?? null,
        message: message.message,
        sourceLine: normalizeSourceLine(sourceLines[(message.line ?? 1) - 1] ?? ""),
      };
      const key = warningKey(warning);
      const existing = warningCounts.get(key);
      warningCounts.set(
        key,
        existing ? { ...existing, count: existing.count + 1 } : { ...warning, count: 1 },
      );
    }
  }

  return [...warningCounts.values()].sort(compareWarnings);
}

export function compareWarningBaseline(baselineWarnings, actualWarnings) {
  const baselineByKey = new Map(baselineWarnings.map((warning) => [warningKey(warning), warning]));
  const actualByKey = new Map(actualWarnings.map((warning) => [warningKey(warning), warning]));
  const added = [];
  const stale = [];

  for (const [key, warning] of actualByKey) {
    const baselineCount = baselineByKey.get(key)?.count ?? 0;
    if (warning.count > baselineCount) {
      added.push({ ...warning, count: warning.count - baselineCount });
    }
  }

  for (const [key, warning] of baselineByKey) {
    const actualCount = actualByKey.get(key)?.count ?? 0;
    if (warning.count > actualCount) {
      stale.push({ ...warning, count: warning.count - actualCount });
    }
  }

  return {
    added: added.sort(compareWarnings),
    stale: stale.sort(compareWarnings),
    matches: added.length === 0 && stale.length === 0,
  };
}

export function countWarnings(warnings) {
  return warnings.reduce((total, warning) => total + warning.count, 0);
}

export function parseWarningBaseline(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== ESLINT_BASELINE_VERSION ||
    !Array.isArray(value.warnings)
  ) {
    throw new Error(`Invalid ESLint baseline: expected version ${ESLINT_BASELINE_VERSION}.`);
  }

  const warnings = value.warnings.map((warning, index) => {
    if (
      typeof warning !== "object" ||
      warning === null ||
      Array.isArray(warning) ||
      typeof warning.path !== "string" ||
      (typeof warning.ruleId !== "string" && warning.ruleId !== null) ||
      (typeof warning.messageId !== "string" && warning.messageId !== null) ||
      typeof warning.message !== "string" ||
      typeof warning.sourceLine !== "string" ||
      !Number.isSafeInteger(warning.count) ||
      warning.count < 1
    ) {
      throw new Error(`Invalid ESLint baseline warning at index ${index}.`);
    }
    return { ...warning };
  });

  const sorted = [...warnings].sort(compareWarnings);
  if (new Set(sorted.map(warningKey)).size !== sorted.length) {
    throw new Error("Invalid ESLint baseline: duplicate warning fingerprints.");
  }

  return sorted;
}
