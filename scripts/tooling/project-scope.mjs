import { extname } from "node:path";

export const ESLINT_TARGET_PATTERNS = [
  "*.{js,mjs,ts}",
  "src/**/*.{js,mjs,ts}",
  "scripts/**/*.{js,mjs,ts}",
];

const ignoredRoots = new Set(["docs", "dist", "node_modules", ".pi"]);
const lintDirectories = new Set(["src", "scripts"]);
const lintExtensions = new Set([".js", ".mjs", ".ts"]);
const maintainedDirectories = new Set(["src", "scripts", "popup", "options", "public"]);
const nestedFormatExtensions = new Set([".ts", ".mjs", ".css", ".html", ".json"]);
const rootFormatExtensions = new Set([".js", ".ts", ".json"]);

export function normalizeProjectPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function isIgnoredProjectPath(path) {
  const [root] = normalizeProjectPath(path).split("/");
  return ignoredRoots.has(root);
}

export function isMaintainedLintPath(path) {
  const normalizedPath = normalizeProjectPath(path);
  if (isIgnoredProjectPath(normalizedPath) || !lintExtensions.has(extname(normalizedPath))) {
    return false;
  }

  const parts = normalizedPath.split("/");
  return parts.length === 1 || lintDirectories.has(parts[0]);
}

export function isMaintainedFormatPath(path) {
  const normalizedPath = normalizeProjectPath(path);
  if (isIgnoredProjectPath(normalizedPath)) {
    return false;
  }

  const parts = normalizedPath.split("/");
  if (parts.length === 1) {
    return rootFormatExtensions.has(extname(normalizedPath));
  }

  return maintainedDirectories.has(parts[0]) && nestedFormatExtensions.has(extname(normalizedPath));
}
