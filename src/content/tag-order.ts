import { DEFAULT_TAG_ID, MAX_STABLE_ID_CODE_POINTS, type CocoonTag } from "./blacklist-state.ts";

export const TAG_ORDER_STORAGE_KEY = "cocoonDrawerTagOrder";

export interface TagOrderPreferences {
  readonly schemaVersion: 1;
  readonly tagIds: readonly string[];
}

export interface ParsedTagOrderPreferences {
  readonly status: "missing" | "valid" | "malformed";
  readonly preferences: TagOrderPreferences;
}

export interface TagOrderDependencies {
  readonly read: () => Promise<unknown>;
  readonly write: (preferences: TagOrderPreferences) => Promise<void>;
  readonly withExclusiveLock: <T>(operation: () => Promise<T>, signal: AbortSignal) => Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCustomTagId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value !== DEFAULT_TAG_ID &&
    Array.from(value).length <= MAX_STABLE_ID_CODE_POINTS
  );
}

export function parseTagOrderPreferences(value: unknown): ParsedTagOrderPreferences {
  const fallback: TagOrderPreferences = { schemaVersion: 1, tagIds: [] };
  if (value === undefined) {
    return { status: "missing", preferences: fallback };
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "schemaVersion,tagIds" ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.tagIds)
  ) {
    return { status: "malformed", preferences: fallback };
  }
  const ids = new Set<string>();
  for (const id of value.tagIds) {
    if (!isCustomTagId(id) || ids.has(id)) {
      return { status: "malformed", preferences: fallback };
    }
    ids.add(id);
  }
  return { status: "valid", preferences: { schemaVersion: 1, tagIds: [...ids] } };
}

export function orderDrawerTags(tags: readonly CocoonTag[], order: readonly string[]): CocoonTag[] {
  const remaining = new Map(tags.map((tag) => [tag.tagId, tag]));
  const ordered: CocoonTag[] = [];
  for (const id of [DEFAULT_TAG_ID, ...order]) {
    const tag = remaining.get(id);
    if (tag) {
      ordered.push(tag);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

export function moveCustomTag(
  ids: readonly string[],
  movedId: string,
  beforeId: string | null,
): string[] {
  const customIds = ids.filter((id) => id !== DEFAULT_TAG_ID);
  if (!isCustomTagId(movedId) || !customIds.includes(movedId) || movedId === beforeId) {
    return customIds;
  }
  if (beforeId !== null && (!isCustomTagId(beforeId) || !customIds.includes(beforeId))) {
    return customIds;
  }
  customIds.splice(customIds.indexOf(movedId), 1);
  const position = beforeId === null ? customIds.length : customIds.indexOf(beforeId);
  customIds.splice(position, 0, movedId);
  return customIds;
}

async function readWhileLocked(
  dependencies: TagOrderDependencies,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    // A cancelled read can release the lock; an already-issued write must not.
    const reading = new Promise<unknown>((resolve) => resolve(dependencies.read()));
    return await Promise.race([reading, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function saveTagOrder(
  dependencies: TagOrderDependencies,
  tagIds: readonly string[],
  signal: AbortSignal,
): Promise<TagOrderPreferences> {
  const desired = parseTagOrderPreferences({ schemaVersion: 1, tagIds });
  if (desired.status !== "valid") {
    throw new Error("Invalid tag order preferences.");
  }
  signal.throwIfAborted();
  return dependencies.withExclusiveLock(async () => {
    signal.throwIfAborted();
    const current = parseTagOrderPreferences(await readWhileLocked(dependencies, signal));
    signal.throwIfAborted();
    const next = desired.preferences;
    if (
      current.status === "valid" &&
      current.preferences.tagIds.length === next.tagIds.length &&
      current.preferences.tagIds.every((id, index) => id === next.tagIds[index])
    ) {
      return current.preferences;
    }
    // Once issued, a storage write cannot be rolled back by aborting the UI operation.
    await dependencies.write(next);
    return next;
  }, signal);
}
