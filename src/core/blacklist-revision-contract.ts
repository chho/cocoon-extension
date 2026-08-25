export const BLACKLIST_REVISION_STORAGE_KEY = "cocoonBlacklistRevision";
export const BLACKLIST_REVISION_SIGNAL_VERSION = 1 as const;

export interface BlacklistChangeEventSource {
  addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
}

export interface BlacklistRevisionSignal {
  readonly version: typeof BLACKLIST_REVISION_SIGNAL_VERSION;
  readonly revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBlacklistRevisionSignal(value: unknown): BlacklistRevisionSignal | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "revision" ||
    keys[1] !== "version" ||
    value.version !== BLACKLIST_REVISION_SIGNAL_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return null;
  }
  return {
    version: BLACKLIST_REVISION_SIGNAL_VERSION,
    revision: value.revision as number,
  };
}

export function parseBlacklistRevisionChange(
  changes: Record<string, unknown>,
  areaName: string,
): BlacklistRevisionSignal | null {
  if (areaName !== "local") return null;
  const change = changes[BLACKLIST_REVISION_STORAGE_KEY];
  if (!isRecord(change) || !("newValue" in change)) return null;
  return parseBlacklistRevisionSignal(change.newValue);
}

export function createBlacklistRevisionSignal(revision: number): BlacklistRevisionSignal {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Blacklist revision must be a non-negative safe integer.");
  }
  return { version: BLACKLIST_REVISION_SIGNAL_VERSION, revision };
}
