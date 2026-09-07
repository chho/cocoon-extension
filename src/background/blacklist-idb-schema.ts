import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type { BlacklistState, BlacklistedAuthor, CocoonTag } from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";

const { DEFAULT_TAG_ID, parseBlacklistState } =
  backgroundBlacklistState as typeof BlacklistStateModule;

export const BLACKLIST_DATABASE_NAME = "cocoon-blacklist";
export const BLACKLIST_DATABASE_VERSION = 2;
export const BLACKLIST_METADATA_KEY = "state";

export const BLACKLIST_STORE_NAMES = Object.freeze({
  authors: "authors",
  identifiers: "identifiers",
  tags: "tags",
  metadata: "metadata",
  importSessions: "import-sessions",
  importAuthors: "import-authors",
  importIdentifiers: "import-identifiers",
  importTags: "import-tags",
  importChunks: "import-chunks",
});

export const LIVE_BLACKLIST_STORE_NAMES = Object.freeze([
  BLACKLIST_STORE_NAMES.authors,
  BLACKLIST_STORE_NAMES.identifiers,
  BLACKLIST_STORE_NAMES.tags,
  BLACKLIST_STORE_NAMES.metadata,
] as const);

export interface StoredAuthor extends BlacklistedAuthor {
  readonly authorKey: string;
  readonly order: number;
  readonly nameSearch: string;
  readonly timeAsc: number;
  readonly timeDesc: number;
}

export interface StoredIdentifier {
  readonly identifierKey: string;
  readonly platformId: string;
  readonly identifier: string;
  readonly authorKey: string;
}

export interface StoredTag extends CocoonTag {
  readonly nameKey: string;
  readonly order: number;
}

export interface StoredBlacklistMetadata {
  readonly key: typeof BLACKLIST_METADATA_KEY;
  readonly migrationComplete: true;
  readonly logicalSchemaVersion: 5;
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
  readonly nextAuthorOrder: number;
  readonly nextTagOrder: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function authorKey(platformId: string, userId: string): string {
  return JSON.stringify([platformId, userId]);
}

export function identifierKey(platformId: string, identifier: string): string {
  return JSON.stringify([platformId, identifier]);
}

function authorTimeKeys(blacklistedAt: string | null): {
  readonly timeAsc: number;
  readonly timeDesc: number;
} {
  if (blacklistedAt === null) {
    return { timeAsc: Number.MAX_SAFE_INTEGER, timeDesc: Number.MAX_SAFE_INTEGER };
  }
  const timestamp = Date.parse(blacklistedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Blacklist author time is invalid.");
  return { timeAsc: timestamp, timeDesc: -timestamp };
}

export function createStoredAuthor(author: BlacklistedAuthor, order: number): StoredAuthor {
  return {
    authorKey: authorKey(author.platformId, author.userId),
    order,
    nameSearch: author.authorNameAtCapture.toLowerCase(),
    ...authorTimeKeys(author.blacklistedAt),
    ...author,
  };
}

export function createStoredIdentifier(
  author: Pick<BlacklistedAuthor, "platformId" | "userId">,
  identifier: string,
): StoredIdentifier {
  return {
    identifierKey: identifierKey(author.platformId, identifier),
    platformId: author.platformId,
    identifier,
    authorKey: authorKey(author.platformId, author.userId),
  };
}

export function createStoredTag(tag: CocoonTag, order: number): StoredTag {
  return { ...tag, nameKey: tag.name.toLowerCase(), order };
}

export function createMetadata(state: BlacklistState, revision: number): StoredBlacklistMetadata {
  return {
    key: BLACKLIST_METADATA_KEY,
    migrationComplete: true,
    logicalSchemaVersion: 5,
    revision,
    authorCount: state.authors.length,
    tagCount: state.tags.length,
    nextAuthorOrder: state.authors.length,
    nextTagOrder: state.tags.length,
  };
}

const STORED_AUTHOR_KEYS = [
  "authorKey",
  "order",
  "nameSearch",
  "timeAsc",
  "timeDesc",
  "platformId",
  "userId",
  "memberHashId",
  "authorNameAtCapture",
  "tagId",
  "blacklistedAt",
  "blockSource",
] as const;

function hasValidStoredAuthorIndexes(value: Record<string, unknown>, tag: CocoonTag): boolean {
  if (!isNonNegativeSafeInteger(value.order) || typeof value.nameSearch !== "string") return false;
  const times = [value.timeAsc, value.timeDesc];
  if (!times.every((time) => typeof time === "number" && Number.isFinite(time))) return false;
  return value.tagId === tag.tagId;
}

function logicalAuthorValue(value: Record<string, unknown>): Record<string, unknown> {
  return {
    platformId: value.platformId,
    userId: value.userId,
    memberHashId: value.memberHashId,
    authorNameAtCapture: value.authorNameAtCapture,
    tagId: value.tagId,
    blacklistedAt: value.blacklistedAt,
    blockSource: value.blockSource,
  };
}

function storedAuthorMatches(value: Record<string, unknown>, expected: StoredAuthor): boolean {
  return (["authorKey", "nameSearch", "timeAsc", "timeDesc"] as const).every(
    (key) => value[key] === expected[key],
  );
}

export function parseStoredAuthor(value: unknown, tag: CocoonTag): StoredAuthor | null {
  if (!isRecord(value) || !hasExactKeys(value, STORED_AUTHOR_KEYS)) return null;
  if (!hasValidStoredAuthorIndexes(value, tag)) return null;
  const tags =
    tag.tagId === DEFAULT_TAG_ID ? [tag] : [{ tagId: DEFAULT_TAG_ID, name: "default" }, tag];
  const parsed = parseBlacklistState({
    schemaVersion: 5,
    tags,
    authors: [logicalAuthorValue(value)],
  });
  if (parsed.status !== "valid") return null;
  const author = parsed.state.authors[0];
  if (!author) return null;
  const expected = createStoredAuthor(author, value.order as number);
  return storedAuthorMatches(value, expected) ? expected : null;
}

export function parseStoredIdentifier(value: unknown): StoredIdentifier | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["identifierKey", "platformId", "identifier", "authorKey"]) ||
    typeof value.platformId !== "string" ||
    typeof value.identifier !== "string" ||
    typeof value.authorKey !== "string" ||
    value.identifierKey !== identifierKey(value.platformId, value.identifier)
  ) {
    return null;
  }
  return {
    identifierKey: value.identifierKey as string,
    platformId: value.platformId,
    identifier: value.identifier,
    authorKey: value.authorKey,
  };
}

export function parseStoredTag(value: unknown): StoredTag | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tagId", "name", "nameKey", "order"]) ||
    typeof value.tagId !== "string" ||
    typeof value.name !== "string" ||
    value.nameKey !== value.name.toLowerCase() ||
    !isNonNegativeSafeInteger(value.order)
  ) {
    return null;
  }
  const tags =
    value.tagId === DEFAULT_TAG_ID
      ? [{ tagId: value.tagId, name: value.name }]
      : [
          { tagId: DEFAULT_TAG_ID, name: "default" },
          { tagId: value.tagId, name: value.name },
        ];
  const parsed = parseBlacklistState({ schemaVersion: 5, tags, authors: [] });
  const tag = parsed.status === "valid" ? parsed.state.tags.at(-1) : undefined;
  return tag ? { ...tag, nameKey: value.nameKey as string, order: value.order } : null;
}

const METADATA_KEYS = [
  "key",
  "migrationComplete",
  "logicalSchemaVersion",
  "revision",
  "authorCount",
  "tagCount",
  "nextAuthorOrder",
  "nextTagOrder",
] as const;

function hasMetadataConstants(value: Record<string, unknown>): boolean {
  return (
    value.key === BLACKLIST_METADATA_KEY &&
    value.migrationComplete === true &&
    value.logicalSchemaVersion === 5
  );
}

function parseMetadataCounts(value: Record<string, unknown>): readonly number[] | null {
  const counts = [
    value.revision,
    value.authorCount,
    value.tagCount,
    value.nextAuthorOrder,
    value.nextTagOrder,
  ];
  return counts.every(isNonNegativeSafeInteger) ? (counts as number[]) : null;
}

export function parseStoredMetadata(value: unknown): StoredBlacklistMetadata | null {
  if (!isRecord(value) || !hasExactKeys(value, METADATA_KEYS) || !hasMetadataConstants(value)) {
    return null;
  }
  const counts = parseMetadataCounts(value);
  if (!counts) return null;
  const [revision, authorCount, tagCount, nextAuthorOrder, nextTagOrder] = counts;
  if (nextAuthorOrder! < authorCount! || nextTagOrder! < tagCount!) return null;
  return {
    key: BLACKLIST_METADATA_KEY,
    migrationComplete: true,
    logicalSchemaVersion: 5,
    revision: revision!,
    authorCount: authorCount!,
    tagCount: tagCount!,
    nextAuthorOrder: nextAuthorOrder!,
    nextTagOrder: nextTagOrder!,
  };
}

export function incrementMetadata(
  metadata: StoredBlacklistMetadata,
  counts: { readonly authors?: number; readonly tags?: number } = {},
): StoredBlacklistMetadata {
  if (metadata.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Blacklist revision is exhausted.");
  }
  const authorCount = metadata.authorCount + (counts.authors ?? 0);
  const tagCount = metadata.tagCount + (counts.tags ?? 0);
  if (authorCount < 0 || tagCount < 1) {
    throw new Error("Blacklist metadata count would become invalid.");
  }
  return {
    ...metadata,
    revision: metadata.revision + 1,
    authorCount,
    tagCount,
    nextAuthorOrder: metadata.nextAuthorOrder + Math.max(0, counts.authors ?? 0),
    nextTagOrder: metadata.nextTagOrder + Math.max(0, counts.tags ?? 0),
  };
}

export function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.oncomplete = () => resolve();
  });
}

function createQueryAuthorIndexes(authors: IDBObjectStore): void {
  authors.createIndex("by-platform", "platformId", { unique: false });
  for (const direction of ["asc", "desc"] as const) {
    const time = direction === "asc" ? "timeAsc" : "timeDesc";
    authors.createIndex(`by-time-${direction}`, [time, "authorKey"], { unique: true });
    authors.createIndex(`by-platform-time-${direction}`, ["platformId", time, "authorKey"], {
      unique: true,
    });
    authors.createIndex(`by-tag-time-${direction}`, ["tagId", time, "authorKey"], {
      unique: true,
    });
    authors.createIndex(
      `by-platform-tag-time-${direction}`,
      ["platformId", "tagId", time, "authorKey"],
      { unique: true },
    );
  }
}

function createLiveStores(database: IDBDatabase): void {
  const authors = database.createObjectStore(BLACKLIST_STORE_NAMES.authors, {
    keyPath: "authorKey",
  });
  authors.createIndex("by-platform-user", ["platformId", "userId"], { unique: true });
  authors.createIndex("by-tag", "tagId", { unique: false });
  authors.createIndex("by-order", "order", { unique: true });
  createQueryAuthorIndexes(authors);

  const identifiers = database.createObjectStore(BLACKLIST_STORE_NAMES.identifiers, {
    keyPath: "identifierKey",
  });
  identifiers.createIndex("by-platform-identifier", ["platformId", "identifier"], {
    unique: true,
  });
  identifiers.createIndex("by-author", "authorKey", { unique: false });

  const tags = database.createObjectStore(BLACKLIST_STORE_NAMES.tags, { keyPath: "tagId" });
  tags.createIndex("by-name", "nameKey", { unique: true });
  tags.createIndex("by-order", "order", { unique: true });
  database.createObjectStore(BLACKLIST_STORE_NAMES.metadata, { keyPath: "key" });
}

function createImportStores(database: IDBDatabase): void {
  const sessions = database.createObjectStore(BLACKLIST_STORE_NAMES.importSessions, {
    keyPath: "sessionId",
  });
  sessions.createIndex("by-expires-at", "expiresAt", { unique: false });

  const authors = database.createObjectStore(BLACKLIST_STORE_NAMES.importAuthors, {
    keyPath: ["sessionId", "index"],
  });
  authors.createIndex("by-session", "sessionId", { unique: false });
  authors.createIndex("by-session-author", ["sessionId", "platformId", "userId"], {
    unique: true,
  });
  authors.createIndex("by-session-tag", ["sessionId", "tagId"], { unique: false });

  const identifiers = database.createObjectStore(BLACKLIST_STORE_NAMES.importIdentifiers, {
    keyPath: ["sessionId", "platformId", "identifier"],
  });
  identifiers.createIndex("by-session", "sessionId", { unique: false });
  identifiers.createIndex("by-session-author", ["sessionId", "authorIndex"], {
    unique: false,
  });

  const tags = database.createObjectStore(BLACKLIST_STORE_NAMES.importTags, {
    keyPath: ["sessionId", "index"],
  });
  tags.createIndex("by-session", "sessionId", { unique: false });
  tags.createIndex("by-session-tag", ["sessionId", "tagId"], { unique: true });
  tags.createIndex("by-session-name", ["sessionId", "nameKey"], { unique: true });

  const chunks = database.createObjectStore(BLACKLIST_STORE_NAMES.importChunks, {
    keyPath: ["sessionId", "kind", "chunkIndex"],
  });
  chunks.createIndex("by-session", "sessionId", { unique: false });
  chunks.createIndex("by-session-kind", ["sessionId", "kind", "chunkIndex"], {
    unique: true,
  });
}

function upgradeV1Authors(transaction: IDBTransaction): void {
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.authors);
  createQueryAuthorIndexes(authors);
  const cursorRequest = authors.openCursor();
  cursorRequest.onerror = () => transaction.abort();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const raw = cursor.value as Record<string, unknown>;
    if (
      !isNonNegativeSafeInteger(raw.order) ||
      typeof raw.authorNameAtCapture !== "string" ||
      !(typeof raw.blacklistedAt === "string" || raw.blacklistedAt === null)
    ) {
      transaction.abort();
      return;
    }
    try {
      cursor.update({
        ...raw,
        nameSearch: raw.authorNameAtCapture.toLowerCase(),
        ...authorTimeKeys(raw.blacklistedAt as string | null),
      });
      cursor.continue();
    } catch {
      transaction.abort();
    }
  };
}

export function openBlacklistDatabase(
  factory: IDBFactory,
  databaseName = BLACKLIST_DATABASE_NAME,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, BLACKLIST_DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked."));
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction || event.oldVersion > 1) {
        transaction?.abort();
        return;
      }
      try {
        if (event.oldVersion === 0) createLiveStores(database);
        else upgradeV1Authors(transaction);
        createImportStores(database);
      } catch {
        transaction.abort();
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
