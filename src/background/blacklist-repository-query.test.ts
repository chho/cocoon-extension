import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  IDBIndex,
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore,
  indexedDB,
} from "fake-indexeddb";

import {
  DEFAULT_TAG_ID,
  type BlacklistState,
  type BlacklistedAuthor,
} from "../content/blacklist-state.ts";
import {
  BLACKLIST_DATABASE_VERSION,
  BLACKLIST_STORE_NAMES,
  authorKey,
  createMetadata,
  createStoredIdentifier,
  createStoredTag,
  openBlacklistDatabase,
  transactionDone,
} from "./blacklist-idb-schema.ts";
import { StaleBlacklistCursorError } from "./blacklist-repository-query.ts";
import { storeLogicalState } from "./blacklist-repository.test-support.ts";
import { createBlacklistRepository } from "./blacklist-repository.ts";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: FakeIDBKeyRange,
});

const EARLY = "2025-01-01T00:00:00.000Z";
const SAME = "2026-01-01T00:00:00.000Z";
const LATE = "2026-08-25T12:34:56.789Z";
const HASH = "a".repeat(32);

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values.get(key) };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function uniqueDatabaseName(label: string): string {
  return `cocoon-query-${label}-${crypto.randomUUID()}`;
}

function author(
  platformId: string,
  userId: string,
  overrides: Partial<BlacklistedAuthor> = {},
): BlacklistedAuthor {
  return {
    platformId,
    userId,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${userId}`,
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: SAME,
    blockSource: "direct",
    ...overrides,
  };
}

function queryState(): BlacklistState {
  return {
    schemaVersion: 5,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "reading", name: "Reading" },
    ],
    authors: [
      author("zhihu", "early", { blacklistedAt: EARLY }),
      author("zhihu", "equal-a"),
      author("zhihu", "equal-b", { tagId: "reading", memberHashId: HASH }),
      author("youtube", "other-platform", { tagId: "reading", blacklistedAt: LATE }),
      author("zhihu", "null-a", { blacklistedAt: null }),
      author("zhihu", "null-b", { blacklistedAt: null }),
    ],
  };
}

async function createRepository(label: string) {
  const databaseName = uniqueDatabaseName(label);
  const repository = createBlacklistRepository({
    indexedDB,
    databaseName,
    storage: new MemoryStorage(),
  });
  await repository.querySummary();
  await storeLogicalState(indexedDB, databaseName, queryState());
  return repository;
}

function authorPageQuery(
  overrides: Partial<
    Parameters<Awaited<ReturnType<typeof createRepository>>["queryAuthorsPage"]>[0]
  > = {},
) {
  return {
    revision: null,
    cursor: null,
    limit: 2,
    search: "",
    searchScope: "author" as const,
    tagId: null,
    platformId: null,
    direction: "asc" as const,
    ...overrides,
  };
}

async function collectAuthorIds(
  repository: Awaited<ReturnType<typeof createRepository>>,
  query: ReturnType<typeof authorPageQuery>,
): Promise<string[]> {
  const ids: string[] = [];
  let revision: number | null = query.revision;
  let cursor: string | null = query.cursor;
  do {
    const page = await repository.queryAuthorsPage({ ...query, revision, cursor });
    ids.push(...page.items.map(({ author: item }) => `${item.platformId}:${item.userId}`));
    revision = page.revision;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

test("BUG-016 v1 upgrades atomically to v2 and backfills only query fields", async () => {
  const databaseName = uniqueDatabaseName("upgrade");
  const existingAuthor = author("zhihu", "legacy", { memberHashId: HASH, blacklistedAt: null });
  const state: BlacklistState = {
    schemaVersion: 5,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [existingAuthor],
  };
  const database = await createVersionOneDatabase(databaseName, state);
  database.close();

  const upgraded = await openBlacklistDatabase(indexedDB, databaseName);
  strictEqual(upgraded.version, BLACKLIST_DATABASE_VERSION);
  const transaction = upgraded.transaction(Object.values(BLACKLIST_STORE_NAMES), "readonly");
  const rawAuthor = await request(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).getAll());
  strictEqual(rawAuthor.length, 1);
  deepStrictEqual(rawAuthor[0], {
    authorKey: authorKey("zhihu", "legacy"),
    order: 0,
    nameSearch: "synthetic legacy",
    timeAsc: Number.MAX_SAFE_INTEGER,
    timeDesc: Number.MAX_SAFE_INTEGER,
    ...existingAuthor,
  });
  strictEqual(
    transaction.objectStore(BLACKLIST_STORE_NAMES.authors).indexNames.contains("by-time-asc"),
    true,
  );
  strictEqual(
    transaction.objectStore(BLACKLIST_STORE_NAMES.authors).indexNames.contains("by-time-desc"),
    true,
  );
  strictEqual(upgraded.objectStoreNames.contains(BLACKLIST_STORE_NAMES.importSessions), true);
  await transactionDone(transaction);
  upgraded.close();
});

test("BUG-016 invalid v1 author aborts upgrade and preserves the v1 database", async () => {
  const databaseName = uniqueDatabaseName("upgrade-abort");
  const invalid = author("zhihu", "legacy", { blacklistedAt: "invalid" });
  const state = {
    schemaVersion: 5 as const,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [invalid],
  };
  const database = await createVersionOneDatabase(databaseName, state);
  database.close();

  await rejects(openBlacklistDatabase(indexedDB, databaseName));
  const preserved = await openExistingDatabase(databaseName);
  strictEqual(preserved.version, 1);
  const transaction = preserved.transaction(BLACKLIST_STORE_NAMES.authors, "readonly");
  const raw = await request(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).getAll());
  strictEqual(raw.length, 1);
  strictEqual("nameSearch" in (raw[0] as Record<string, unknown>), false);
  await transactionDone(transaction);
  preserved.close();
});

test("BUG-016 keyset pages have no gaps or duplicates for equal/null times in both directions", async () => {
  const repository = await createRepository("keyset");
  deepStrictEqual(await collectAuthorIds(repository, authorPageQuery()), [
    "zhihu:early",
    "zhihu:equal-a",
    "zhihu:equal-b",
    "youtube:other-platform",
    "zhihu:null-a",
    "zhihu:null-b",
  ]);
  deepStrictEqual(await collectAuthorIds(repository, authorPageQuery({ direction: "desc" })), [
    "youtube:other-platform",
    "zhihu:equal-a",
    "zhihu:equal-b",
    "zhihu:early",
    "zhihu:null-a",
    "zhihu:null-b",
  ]);
});

test("BUG-016 author query applies case-insensitive substring and tag/platform AND filters", async () => {
  const repository = await createRepository("filters");
  const substring = await repository.queryAuthorsPage(
    authorPageQuery({ search: "THETIC EQUAL", limit: 50 }),
  );
  deepStrictEqual(
    substring.items.map(({ author: item }) => item.userId),
    ["equal-a", "equal-b"],
  );
  const filtered = await repository.queryAuthorsPage(
    authorPageQuery({
      tagId: "reading",
      platformId: "zhihu",
      direction: "desc",
      limit: 50,
    }),
  );
  deepStrictEqual(
    filtered.items.map(({ author: item }) => item.userId),
    ["equal-b"],
  );
  strictEqual(filtered.totalCount, 1);
});

test("BUG-016 Popup search can match tag names without changing options author-only search", async () => {
  const repository = await createRepository("popup-tag-search");
  const popup = await repository.queryAuthorsPage(
    authorPageQuery({ search: "reading", searchScope: "author-or-tag", limit: 50 }),
  );
  const options = await repository.queryAuthorsPage(
    authorPageQuery({ search: "reading", searchScope: "author", limit: 50 }),
  );
  strictEqual(popup.items.length > 0, true);
  strictEqual(options.items.length, 0);
});

test("BUG-016 cursors are query- and revision-bound", async () => {
  const repository = await createRepository("stale");
  const first = await repository.queryAuthorsPage(authorPageQuery({ limit: 1 }));
  strictEqual(typeof first.nextCursor, "string");
  await rejects(
    repository.queryAuthorsPage(
      authorPageQuery({
        revision: first.revision,
        cursor: first.nextCursor,
        search: "changed",
        limit: 1,
      }),
    ),
    StaleBlacklistCursorError,
  );
  await rejects(
    repository.queryAuthorsPage(
      authorPageQuery({ revision: first.revision + 1, cursor: first.nextCursor, limit: 1 }),
    ),
    StaleBlacklistCursorError,
  );
});

test("BUG-016 bounded tag/platform facets expose counts and stable cursors", async () => {
  const repository = await createRepository("facets");
  const firstTags = await repository.queryTagsPage({ revision: null, cursor: null, limit: 1 });
  deepStrictEqual(firstTags.tags, [
    { tagId: "default", name: "default", isDefault: true, authorCount: 4 },
  ]);
  const secondTags = await repository.queryTagsPage({
    revision: firstTags.revision,
    cursor: firstTags.nextCursor,
    limit: 1,
  });
  deepStrictEqual(secondTags.tags, [
    { tagId: "reading", name: "Reading", isDefault: false, authorCount: 2 },
  ]);
  const firstPlatforms = await repository.queryPlatformsPage({
    revision: null,
    cursor: null,
    limit: 1,
  });
  deepStrictEqual(firstPlatforms.platforms, ["youtube"]);
  const secondPlatforms = await repository.queryPlatformsPage({
    revision: firstPlatforms.revision,
    cursor: firstPlatforms.nextCursor,
    limit: 1,
  });
  deepStrictEqual(secondPlatforms.platforms, ["zhihu"]);
});

test("BUG-016 identity batches match aliases without crossing platform boundaries", async () => {
  const repository = await createRepository("identities");
  const result = await repository.queryIdentityMatches({
    revision: null,
    identities: [
      { platformId: "zhihu", identifier: "equal-b" },
      { platformId: "zhihu", identifier: HASH },
      { platformId: "youtube", identifier: "equal-b" },
      { platformId: "zhihu", identifier: "missing" },
      { platformId: "youtube", identifier: "other-platform" },
    ],
  });
  deepStrictEqual(result.matches, [
    { platformId: "zhihu", identifier: "equal-b" },
    { platformId: "zhihu", identifier: HASH },
    { platformId: "youtube", identifier: "other-platform" },
  ]);
});

test("BUG-016 query hot paths never call getAll on authors or identifiers", async () => {
  const repository = await createRepository("hot-path");
  const originalStoreGetAll = IDBObjectStore.prototype.getAll;
  const originalIndexGetAll = IDBIndex.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    if (
      this.name === BLACKLIST_STORE_NAMES.authors ||
      this.name === BLACKLIST_STORE_NAMES.identifiers
    ) {
      throw new Error("hot-path collection read");
    }
    return originalStoreGetAll.apply(this, args);
  };
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (
      this.objectStore.name === BLACKLIST_STORE_NAMES.authors ||
      this.objectStore.name === BLACKLIST_STORE_NAMES.identifiers
    ) {
      throw new Error("hot-path collection read");
    }
    return originalIndexGetAll.apply(this, args);
  };
  try {
    await repository.querySummary();
    await repository.queryAuthorsPage(authorPageQuery({ limit: 50 }));
    await repository.queryTagsPage({ revision: null, cursor: null, limit: 50 });
    await repository.queryPlatformsPage({ revision: null, cursor: null, limit: 50 });
    await repository.queryIdentityMatches({
      revision: null,
      identities: [{ platformId: "zhihu", identifier: HASH }],
    });
  } finally {
    IDBObjectStore.prototype.getAll = originalStoreGetAll;
    IDBIndex.prototype.getAll = originalIndexGetAll;
  }
});

async function request<Result>(value: IDBRequest<Result>): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed."));
    value.onsuccess = () => resolve(value.result);
  });
}

async function createVersionOneDatabase(
  databaseName: string,
  state: BlacklistState,
): Promise<IDBDatabase> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onerror = () => reject(open.error ?? new Error("Unable to create v1 database."));
    open.onupgradeneeded = () => {
      const authors = open.result.createObjectStore(BLACKLIST_STORE_NAMES.authors, {
        keyPath: "authorKey",
      });
      authors.createIndex("by-platform-user", ["platformId", "userId"], { unique: true });
      authors.createIndex("by-tag", "tagId", { unique: false });
      authors.createIndex("by-order", "order", { unique: true });
      const identifiers = open.result.createObjectStore(BLACKLIST_STORE_NAMES.identifiers, {
        keyPath: "identifierKey",
      });
      identifiers.createIndex("by-platform-identifier", ["platformId", "identifier"], {
        unique: true,
      });
      identifiers.createIndex("by-author", "authorKey", { unique: false });
      const tags = open.result.createObjectStore(BLACKLIST_STORE_NAMES.tags, { keyPath: "tagId" });
      tags.createIndex("by-name", "nameKey", { unique: true });
      tags.createIndex("by-order", "order", { unique: true });
      open.result.createObjectStore(BLACKLIST_STORE_NAMES.metadata, { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
  });
  const transaction = database.transaction(
    [
      BLACKLIST_STORE_NAMES.authors,
      BLACKLIST_STORE_NAMES.identifiers,
      BLACKLIST_STORE_NAMES.tags,
      BLACKLIST_STORE_NAMES.metadata,
    ],
    "readwrite",
  );
  state.tags.forEach((tag, order) =>
    transaction.objectStore(BLACKLIST_STORE_NAMES.tags).add(createStoredTag(tag, order)),
  );
  state.authors.forEach((item, order) => {
    transaction.objectStore(BLACKLIST_STORE_NAMES.authors).add({
      authorKey: authorKey(item.platformId, item.userId),
      order,
      ...item,
    });
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.identifiers)
      .add(createStoredIdentifier(item, item.userId));
    if (item.memberHashId !== null) {
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.identifiers)
        .add(createStoredIdentifier(item, item.memberHashId));
    }
  });
  transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).add(createMetadata(state, 0));
  await transactionDone(transaction);
  return database;
}

function openExistingDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName);
    open.onerror = () => reject(open.error ?? new Error("Unable to open database."));
    open.onsuccess = () => resolve(open.result);
  });
}
