import type { CocoonTag } from "../content/blacklist-state.ts";
import type {
  BlacklistAuthorListItemDto,
  BlacklistIdentityQueryDto,
  BlacklistSearchScope,
  BlacklistSummaryDto,
  BlacklistTagUsageDto,
  BlacklistTimeDirection,
} from "../core/blacklist-query-rpc-contract.ts";
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  identifierKey,
  parseStoredAuthor,
  parseStoredIdentifier,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
  type StoredAuthor,
  type StoredBlacklistMetadata,
} from "./blacklist-idb-schema.ts";
import { logicalAuthor } from "./blacklist-repository-records.ts";

export class StaleBlacklistCursorError extends Error {
  constructor() {
    super("Blacklist query cursor is stale.");
  }
}

export interface AuthorPageQuery {
  readonly revision: number | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly search: string;
  readonly searchScope: BlacklistSearchScope;
  readonly tagId: string | null;
  readonly platformId: string | null;
  readonly direction: BlacklistTimeDirection;
}

export interface AuthorPageResult extends BlacklistSummaryDto {
  readonly items: readonly BlacklistAuthorListItemDto[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface RevisionPageQuery {
  readonly revision: number | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TagPageResult extends BlacklistSummaryDto {
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly nextCursor: string | null;
}

export interface PlatformPageResult extends BlacklistSummaryDto {
  readonly platforms: readonly string[];
  readonly nextCursor: string | null;
}

export interface IdentityMatchQuery {
  readonly revision: number | null;
  readonly identities: readonly BlacklistIdentityQueryDto[];
}

export interface IdentityMatchResult {
  readonly revision: number;
  readonly matches: readonly BlacklistIdentityQueryDto[];
}

interface AuthorCursor {
  readonly version: 1;
  readonly operation: "authors-page";
  readonly revision: number;
  readonly search: string;
  readonly searchScope: BlacklistSearchScope;
  readonly tagId: string | null;
  readonly platformId: string | null;
  readonly direction: BlacklistTimeDirection;
  readonly key: readonly IDBValidKey[];
  readonly totalCount: number;
}

type TagCursor = Readonly<{ version: 1; operation: "tags-page"; revision: number; order: number }>;

interface PlatformCursor {
  readonly version: 1;
  readonly operation: "platforms-page";
  readonly revision: number;
  readonly platformId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function summary(metadata: StoredBlacklistMetadata): BlacklistSummaryDto {
  return {
    revision: metadata.revision,
    authorCount: metadata.authorCount,
    tagCount: metadata.tagCount,
  };
}

async function metadataFrom(transaction: IDBTransaction): Promise<StoredBlacklistMetadata> {
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
  );
  const metadata = parseStoredMetadata(raw);
  if (!metadata) throw new Error("IndexedDB blacklist metadata is unreadable.");
  return metadata;
}

function requireRevision(metadata: StoredBlacklistMetadata, revision: number | null): void {
  if (revision !== null && revision !== metadata.revision) throw new StaleBlacklistCursorError();
}

function encodeCursor(cursor: AuthorCursor | TagCursor | PlatformCursor): string {
  return JSON.stringify(cursor);
}

function parseJsonCursor(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function authorCursorKeyMatches(
  key: unknown,
  query: AuthorPageQuery,
): key is readonly IDBValidKey[] {
  if (!Array.isArray(key)) return false;
  const prefix = authorPrefix(query);
  if (key.length !== prefix.length + 2) return false;
  if (!prefix.every((part, index) => key[index] === part)) return false;
  return (
    typeof key.at(-2) === "number" && Number.isFinite(key.at(-2)) && typeof key.at(-1) === "string"
  );
}

const AUTHOR_CURSOR_KEYS =
  "version operation revision search searchScope tagId platformId direction key totalCount".split(
    " ",
  );

function hasAuthorCursorHeader(parsed: Record<string, unknown>): boolean {
  if (parsed.version !== 1 || parsed.operation !== "authors-page") return false;
  if (!Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0) return false;
  return Number.isSafeInteger(parsed.totalCount) && (parsed.totalCount as number) >= 0;
}

function authorCursorQueryMatches(
  parsed: Record<string, unknown>,
  query: AuthorPageQuery,
): boolean {
  return (
    parsed.search === query.search &&
    parsed.searchScope === query.searchScope &&
    parsed.tagId === query.tagId &&
    parsed.platformId === query.platformId &&
    parsed.direction === query.direction
  );
}

function parseAuthorCursor(value: string, query: AuthorPageQuery): AuthorCursor | null {
  const parsed = parseJsonCursor(value);
  if (!parsed || !hasExactKeys(parsed, AUTHOR_CURSOR_KEYS)) return null;
  if (!hasAuthorCursorHeader(parsed) || !authorCursorQueryMatches(parsed, query)) return null;
  if (!authorCursorKeyMatches(parsed.key, query)) return null;
  return parsed as unknown as AuthorCursor;
}

function parseTagCursor(value: string): TagCursor | null {
  const parsed = parseJsonCursor(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "operation", "revision", "order"]) ||
    parsed.version !== 1 ||
    parsed.operation !== "tags-page" ||
    !Number.isSafeInteger(parsed.revision) ||
    (parsed.revision as number) < 0 ||
    !Number.isSafeInteger(parsed.order) ||
    (parsed.order as number) < 0
  ) {
    return null;
  }
  return parsed as unknown as TagCursor;
}

function parsePlatformCursor(value: string): PlatformCursor | null {
  const parsed = parseJsonCursor(value);
  if (
    !parsed ||
    !hasExactKeys(parsed, ["version", "operation", "revision", "platformId"]) ||
    parsed.version !== 1 ||
    parsed.operation !== "platforms-page" ||
    !Number.isSafeInteger(parsed.revision) ||
    (parsed.revision as number) < 0 ||
    typeof parsed.platformId !== "string" ||
    parsed.platformId.length === 0
  ) {
    return null;
  }
  return parsed as unknown as PlatformCursor;
}

async function tagsById(transaction: IDBTransaction): Promise<Map<string, CocoonTag>> {
  const rawTags = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.tags).index("by-order").getAll(),
  );
  const tags = rawTags.map(parseStoredTag);
  if (tags.some((tag) => tag === null)) throw new Error("IndexedDB tag records are unreadable.");
  return new Map(tags.map((tag) => [tag!.tagId, { tagId: tag!.tagId, name: tag!.name }]));
}

function authorIndexName(query: AuthorPageQuery): string {
  const scope = query.platformId
    ? query.tagId
      ? "platform-tag-"
      : "platform-"
    : query.tagId
      ? "tag-"
      : "";
  return `by-${scope}time-${query.direction}`;
}

function authorPrefix(query: AuthorPageQuery): readonly IDBValidKey[] {
  if (query.platformId && query.tagId) return [query.platformId, query.tagId];
  if (query.platformId) return [query.platformId];
  if (query.tagId) return [query.tagId];
  return [];
}

function authorRange(
  prefix: readonly IDBValidKey[],
  cursorKey?: readonly IDBValidKey[],
): IDBKeyRange | null {
  if (prefix.length === 0) return cursorKey ? IDBKeyRange.lowerBound(cursorKey, true) : null;
  const upper = [...prefix, []];
  return cursorKey
    ? IDBKeyRange.bound(cursorKey, upper, true, false)
    : IDBKeyRange.bound(prefix, upper, false, false);
}

function authorMatches(author: StoredAuthor, tag: CocoonTag, query: AuthorPageQuery): boolean {
  if (!query.search) return true;
  const search = query.search.toLowerCase();
  return (
    author.nameSearch.includes(search) ||
    (query.searchScope === "author-or-tag" && tag.name.toLowerCase().includes(search))
  );
}

function authorItem(author: StoredAuthor, tag: CocoonTag): BlacklistAuthorListItemDto {
  const logical = logicalAuthor(author);
  return {
    author: {
      platformId: logical.platformId,
      userId: logical.userId,
      memberHashId: logical.memberHashId,
      authorName: logical.authorNameAtCapture,
      tagId: logical.tagId,
      blacklistedAt: logical.blacklistedAt,
      source: logical.blockSource,
    },
    tag: {
      tagId: tag.tagId,
      name: tag.name,
      isDefault: tag.tagId === "default",
    },
  };
}

interface AuthorScanResult {
  readonly items: readonly BlacklistAuthorListItemDto[];
  readonly lastIncludedKey: readonly IDBValidKey[] | null;
  readonly totalCount: number;
  readonly hasMore: boolean;
}

function scanAuthors(options: {
  readonly index: IDBIndex;
  readonly range: IDBKeyRange | null;
  readonly tags: ReadonlyMap<string, CocoonTag>;
  readonly query: AuthorPageQuery;
  readonly countAll: boolean;
}): Promise<AuthorScanResult> {
  return new Promise<AuthorScanResult>((resolve, reject) => {
    const { index, range, tags, query, countAll } = options;
    const items: BlacklistAuthorListItemDto[] = [];
    let totalCount = 0;
    let lastIncludedKey: readonly IDBValidKey[] | null = null;
    let hasMore = false;
    const request = index.openCursor(range);
    request.onerror = () => reject(request.error ?? new Error("Author query failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ items, lastIncludedKey, totalCount, hasMore });
        return;
      }
      const raw = cursor.value as Record<string, unknown>;
      const tag = typeof raw.tagId === "string" ? tags.get(raw.tagId) : undefined;
      const parsed = tag ? parseStoredAuthor(raw, tag) : null;
      if (!parsed || !tag || !Array.isArray(cursor.key)) {
        reject(new Error("IndexedDB author query record is unreadable."));
        return;
      }
      if (authorMatches(parsed, tag, query)) {
        totalCount += 1;
        if (items.length < query.limit) {
          items.push(authorItem(parsed, tag));
          lastIncludedKey = cursor.key as IDBValidKey[];
        } else if (!countAll) {
          hasMore = true;
          resolve({ items, lastIncludedKey, totalCount, hasMore });
          return;
        } else {
          hasMore = true;
        }
      }
      cursor.continue();
    };
  });
}

export async function querySummary(database: IDBDatabase): Promise<BlacklistSummaryDto> {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const result = summary(await metadataFrom(transaction));
  await done;
  return result;
}

function authorCursorFor(
  query: AuthorPageQuery,
  metadata: StoredBlacklistMetadata,
): AuthorCursor | null {
  if (!query.cursor) return null;
  const cursor = parseAuthorCursor(query.cursor, query);
  if (!cursor || cursor.revision !== metadata.revision) throw new StaleBlacklistCursorError();
  return cursor;
}

export async function queryAuthorsPage(
  database: IDBDatabase,
  query: AuthorPageQuery,
): Promise<AuthorPageResult> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, query.revision);
  const cursor = authorCursorFor(query, metadata);
  const tags = await tagsById(transaction);
  const index = transaction
    .objectStore(BLACKLIST_STORE_NAMES.authors)
    .index(authorIndexName(query));
  const scan = await scanAuthors({
    index,
    range: authorRange(authorPrefix(query), cursor?.key),
    tags,
    query,
    countAll: cursor === null,
  });
  await done;
  const totalCount = cursor?.totalCount ?? scan.totalCount;
  const hasMore = cursor === null ? totalCount > scan.items.length : scan.hasMore;
  const nextCursor =
    hasMore && scan.lastIncludedKey
      ? encodeCursor({
          version: 1,
          operation: "authors-page",
          revision: metadata.revision,
          search: query.search,
          searchScope: query.searchScope,
          tagId: query.tagId,
          platformId: query.platformId,
          direction: query.direction,
          key: scan.lastIncludedKey,
          totalCount,
        })
      : null;
  return { ...summary(metadata), items: scan.items, nextCursor, totalCount };
}

export async function queryTagsPage(
  database: IDBDatabase,
  query: RevisionPageQuery,
): Promise<TagPageResult> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, query.revision);
  const cursor = query.cursor ? parseTagCursor(query.cursor) : null;
  if (query.cursor && (!cursor || cursor.revision !== metadata.revision)) {
    throw new StaleBlacklistCursorError();
  }
  const index = transaction.objectStore(BLACKLIST_STORE_NAMES.tags).index("by-order");
  const range = cursor ? IDBKeyRange.lowerBound(cursor.order, true) : null;
  const raw = await requestResult(index.getAll(range, query.limit + 1));
  const parsed = raw.map(parseStoredTag);
  if (parsed.some((tag) => tag === null)) throw new Error("IndexedDB tag records are unreadable.");
  const selected = parsed.slice(0, query.limit).map((tag) => tag!);
  const authorIndex = transaction.objectStore(BLACKLIST_STORE_NAMES.authors).index("by-tag");
  const counts = await Promise.all(
    selected.map((tag) => requestResult(authorIndex.count(tag.tagId))),
  );
  await done;
  return {
    ...summary(metadata),
    tags: selected.map((tag, indexValue) => ({
      tagId: tag.tagId,
      name: tag.name,
      isDefault: tag.tagId === "default",
      authorCount: counts[indexValue] ?? 0,
    })),
    nextCursor:
      parsed.length > query.limit
        ? encodeCursor({
            version: 1,
            operation: "tags-page",
            revision: metadata.revision,
            order: selected.at(-1)!.order,
          })
        : null,
  };
}

function scanPlatformIds(
  index: IDBIndex,
  range: IDBKeyRange | null,
  limit: number,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const values: string[] = [];
    const request = index.openKeyCursor(range, "nextunique");
    request.onerror = () => reject(request.error ?? new Error("Platform query failed."));
    request.onsuccess = () => {
      const entry = request.result;
      if (!entry || values.length > limit) {
        resolve(values);
        return;
      }
      if (typeof entry.key !== "string") {
        reject(new Error("IndexedDB platform key is unreadable."));
        return;
      }
      values.push(entry.key);
      entry.continue();
    };
  });
}

export async function queryPlatformsPage(
  database: IDBDatabase,
  query: RevisionPageQuery,
): Promise<PlatformPageResult> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, query.revision);
  const cursor = query.cursor ? parsePlatformCursor(query.cursor) : null;
  if (query.cursor && (!cursor || cursor.revision !== metadata.revision)) {
    throw new StaleBlacklistCursorError();
  }
  const index = transaction.objectStore(BLACKLIST_STORE_NAMES.authors).index("by-platform");
  const range = cursor ? IDBKeyRange.lowerBound(cursor.platformId, true) : null;
  const platforms = await scanPlatformIds(index, range, query.limit);
  await done;
  const selected = platforms.slice(0, query.limit);
  return {
    ...summary(metadata),
    platforms: selected,
    nextCursor:
      platforms.length > query.limit
        ? encodeCursor({
            version: 1,
            operation: "platforms-page",
            revision: metadata.revision,
            platformId: selected.at(-1)!,
          })
        : null,
  };
}

export async function queryIdentityMatches(
  database: IDBDatabase,
  query: IdentityMatchQuery,
): Promise<IdentityMatchResult> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.identifiers, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, query.revision);
  const store = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  const raw = await Promise.all(
    query.identities.map(({ platformId, identifier }) =>
      requestResult(store.get(identifierKey(platformId, identifier))),
    ),
  );
  const matches: BlacklistIdentityQueryDto[] = [];
  raw.forEach((value, index) => {
    if (value === undefined) return;
    const expected = query.identities[index]!;
    const parsed = parseStoredIdentifier(value);
    if (
      !parsed ||
      parsed.platformId !== expected.platformId ||
      parsed.identifier !== expected.identifier
    ) {
      throw new Error("IndexedDB identifier record is unreadable.");
    }
    matches.push(expected);
  });
  await done;
  return { revision: metadata.revision, matches };
}
