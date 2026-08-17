import type { SitePluginDescriptor } from "./contract.ts";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SUPPORTED_MATCH_SCHEMES = new Set(["http", "https", "*", "file", "ftp"]);

interface ParsedChromeMatchPattern {
  readonly scheme: string;
  readonly host: string;
  readonly path: string;
}

export type PluginDescriptorValidation =
  | { readonly valid: true; readonly descriptor: SitePluginDescriptor }
  | { readonly valid: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isValidMatchHost(host: string): boolean {
  if (host === "*") {
    return true;
  }

  const hostname = host.startsWith("*.") ? host.slice(2) : host;
  if (!hostname || hostname.includes("*") || hostname.includes(":")) {
    return false;
  }

  return hostname.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

export function parseChromeMatchPattern(
  value: unknown,
): ParsedChromeMatchPattern | null {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value === "<all_urls>" ||
    /[\u0000-\u0020\\#]/.test(value)
  ) {
    return null;
  }

  const match = /^([a-z*]+):\/\/([^/]*)(\/.*)$/i.exec(value);
  if (!match) {
    return null;
  }

  const scheme = match[1]?.toLowerCase();
  const host = match[2]?.toLowerCase();
  const path = match[3];
  if (!scheme || host === undefined || !path || !SUPPORTED_MATCH_SCHEMES.has(scheme)) {
    return null;
  }

  if (scheme === "file") {
    return host === "" ? { scheme, host, path } : null;
  }
  if (!isValidMatchHost(host)) {
    return null;
  }

  return { scheme, host, path };
}

export function validatePluginDescriptor(
  value: unknown,
): PluginDescriptorValidation {
  if (!isRecord(value)) {
    return { valid: false, errors: ["descriptor must be an object"] };
  }
  if (!hasExactKeys(value, ["id", "matches"])) {
    return {
      valid: false,
      errors: ["descriptor must contain exactly id and matches"],
    };
  }

  const errors: string[] = [];
  const { id, matches } = value;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    errors.push("descriptor id must match /^[a-z][a-z0-9-]*$/");
  }
  if (!Array.isArray(matches) || matches.length === 0) {
    errors.push("descriptor matches must be a non-empty array");
  }

  const parsedMatches: string[] = [];
  const seenMatches = new Set<string>();
  if (Array.isArray(matches)) {
    for (const matchPattern of matches) {
      if (parseChromeMatchPattern(matchPattern) === null) {
        errors.push(`invalid Chrome match pattern: ${String(matchPattern)}`);
        continue;
      }
      if (seenMatches.has(matchPattern as string)) {
        errors.push(`duplicate Chrome match pattern: ${String(matchPattern)}`);
        continue;
      }
      seenMatches.add(matchPattern as string);
      parsedMatches.push(matchPattern as string);
    }
  }

  if (errors.length > 0 || typeof id !== "string") {
    return { valid: false, errors };
  }
  return {
    valid: true,
    descriptor: { id, matches: parsedMatches },
  };
}

function wildcardPathMatches(pathPattern: string, pathname: string): boolean {
  const expression = pathPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(pathname);
}

export function urlMatchesChromePattern(url: URL, pattern: string): boolean {
  const parsed = parseChromeMatchPattern(pattern);
  if (!parsed) {
    return false;
  }

  const urlScheme = url.protocol.slice(0, -1).toLowerCase();
  const schemeMatches = parsed.scheme === "*"
    ? urlScheme === "http" || urlScheme === "https"
    : parsed.scheme === urlScheme;
  if (!schemeMatches) {
    return false;
  }

  if (parsed.scheme !== "file") {
    const hostname = url.hostname.toLowerCase();
    const hostMatches = parsed.host === "*" ||
      (parsed.host.startsWith("*.")
        ? hostname === parsed.host.slice(2) ||
          hostname.endsWith(`.${parsed.host.slice(2)}`)
        : hostname === parsed.host);
    if (!hostMatches) {
      return false;
    }
  }

  return wildcardPathMatches(parsed.path, url.pathname);
}
