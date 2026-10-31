import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { IDBDatabase, IDBIndex, IDBObjectStore, indexedDB } from "fake-indexeddb";

import {
  DEFAULT_TAG_ID,
  STORAGE_KEY,
  ZHIHU_PLATFORM_ID,
  createInitialState,
  parseBlacklistState,
  type BlacklistState,
  type BlacklistedAuthor,
} from "../content/blacklist-state.ts";
import { BLACKLIST_REVISION_STORAGE_KEY } from "../core/blacklist-revision-contract.ts";
import { readLogicalState, storeLogicalState } from "./blacklist-repository.test-support.ts";
import {
  BLACKLIST_DATABASE_VERSION,
  BLACKLIST_STORE_NAMES,
  createBlacklistRepository,
} from "./blacklist-repository.ts";

const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const TIMESTAMP = "2026-08-25T12:34:56.789Z";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly removed: string[] = [];
  failGet = false;
  failRemoveCount = 0;
  failRevisionSetCount = 0;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.failGet) throw new Error("get failed");
    return { [key]: this.values.get(key) };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (BLACKLIST_REVISION_STORAGE_KEY in items && this.failRevisionSetCount > 0) {
      this.failRevisionSetCount -= 1;
      throw new Error("revision set failed");
    }
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    if (this.failRemoveCount > 0) {
      this.failRemoveCount -= 1;
      throw new Error("remove failed");
    }
    this.values.delete(key);
    this.removed.push(key);
  }
}

function uniqueDatabaseName(label: string): string {
  return `cocoon-test-${label}-${crypto.randomUUID()}`;
}

function author(userId: string, overrides: Partial<BlacklistedAuthor> = {}): BlacklistedAuthor {
  return {
    platformId: ZHIHU_PLATFORM_ID,
    userId,
    sourcePostId: null,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${userId}`,
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct",
    ...overrides,
  };
}

function legacyState(version: 1 | 2 | 3 | 4 | 5): unknown {
  const current = author(`legacy-${version}`, { memberHashId: HASH_A });
  const value: Record<string, unknown> = {
    schemaVersion: version,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [{ ...current }],
  };
  const legacyAuthor = (value.authors as Array<Record<string, unknown>>)[0]!;
  delete legacyAuthor.sourcePostId;
  if (version < 5) delete legacyAuthor.platformId;
  if (version < 4) delete legacyAuthor.memberHashId;
  if (version < 3) delete legacyAuthor.blockSource;
  if (version === 1) delete legacyAuthor.blacklistedAt;
  return value;
}

function malformedLegacyStates(): unknown[] {
  const tag = { tagId: DEFAULT_TAG_ID, name: "default" };
  const author = {
    userId: "legacy-user",
    authorNameAtCapture: "Legacy",
    tagId: DEFAULT_TAG_ID,
    cardImage: null,
  };
  const v1 = { schemaVersion: 1, tags: [tag], authors: [author] };
  return [
    { ...v1, extra: true },
    { ...v1, tags: [{ ...tag, extra: true }] },
    { ...v1, authors: [{ ...author, extra: true }] },
    { ...v1, authors: [{ ...author, userId: "u".repeat(513) }] },
    { ...v1, authors: [{ ...author, authorNameAtCapture: "A".repeat(501) }] },
  ];
}

function createHarness(
  label: string,
  storage = new MemoryStorage(),
  beforeMigrationComplete?: () => void,
) {
  const databaseName = uniqueDatabaseName(label);
  const repository = createBlacklistRepository({
    indexedDB,
    databaseName,
    storage,
    beforeMigrationComplete,
  });
  return { databaseName, repository, storage };
}

async function readStoreValues(databaseName: string, storeName: string): Promise<unknown[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, BLACKLIST_DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    return await new Promise<unknown[]>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error("read failed"));
      request.onsuccess = () => resolve(request.result as unknown[]);
    });
  } finally {
    database.close();
  }
}

test("POST-002 shares one immutable post across 1000 independent user transactions", async () => {
  const harness = createHarness("shared-post");
  const post = {
    postId: "zhihu:answer:23",
    platformId: "zhihu" as const,
    kind: "answer" as const,
    contentId: "23",
    title: "First title",
    url: "https://www.zhihu.com/question/12/answer/23",
  };
  const [first, repeated] = await Promise.all([
    harness.repository.ensurePost(post),
    harness.repository.ensurePost({ ...post, title: "Later title" }),
  ]);
  deepStrictEqual(first, repeated);
  const input = {
    platformId: "zhihu",
    userId: "",
    authorNameAtCapture: "Synthetic",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    sourcePostId: post.postId,
  };
  for (let index = 0; index < 1000; index += 1) {
    if (index === 500) {
      strictEqual(
        (
          await harness.repository.commitUpvoter({
            ...input,
            userId: "invalid",
            blacklistedAt: "invalid",
          })
        ).status,
        "invalid",
      );
    }
    strictEqual(
      (await harness.repository.commitUpvoter({ ...input, userId: `user-${index}` })).status,
      "persisted",
    );
  }
  strictEqual(
    (await harness.repository.commitUpvoter({ ...input, userId: "user-0", sourcePostId: null }))
      .status,
    "duplicate",
  );
  const stored = await readLogicalState(indexedDB, harness.databaseName);
  strictEqual(stored.state.authors.length, 1000);
  strictEqual(
    stored.state.authors.every((item) => item.sourcePostId === post.postId),
    true,
  );
  deepStrictEqual(stored.state.posts, [post]);
  const removed = await harness.repository.removeAuthor({ platformId: "zhihu", userId: "user-0" });
  strictEqual(removed.removed?.sourcePostId, post.postId);
  strictEqual((await harness.repository.restoreAuthor(removed.removed!)).status, "persisted");
  await storeLogicalState(
    indexedDB,
    harness.databaseName,
    createInitialState(),
    stored.revision + 2,
  );
  strictEqual((await harness.repository.restoreAuthor(removed.removed!)).status, "invalid");
  await rejects(harness.repository.commitUpvoter({ ...input, userId: "late" }), {
    name: "SourcePostUnavailableError",
  });
  strictEqual((await harness.repository.querySummary()).authorCount, 0);
});

test("POST-002 a failed author transaction preserves the shared post and earlier users", async () => {
  const harness = createHarness("isolated-author-error");
  const post = {
    postId: "zhihu:article:7",
    platformId: "zhihu" as const,
    kind: "article" as const,
    contentId: "7",
    title: "Synthetic",
    url: "https://zhuanlan.zhihu.com/p/7",
  };
  await harness.repository.ensurePost(post);
  const input = {
    platformId: "zhihu",
    userId: "before",
    authorNameAtCapture: "Synthetic",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    sourcePostId: post.postId,
  };
  strictEqual((await harness.repository.commitUpvoter(input)).status, "persisted");
  const original = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore["add"]>) {
    if (this.name === BLACKLIST_STORE_NAMES.authors)
      throw new DOMException("Synthetic per-user constraint", "ConstraintError");
    return original.apply(this, args);
  };
  try {
    await rejects(harness.repository.commitUpvoter({ ...input, userId: "failed" }), {
      name: "ConstraintError",
    });
  } finally {
    IDBObjectStore.prototype.add = original;
  }
  strictEqual(
    (await harness.repository.commitUpvoter({ ...input, userId: "after" })).status,
    "persisted",
  );
  const stored = await readLogicalState(indexedDB, harness.databaseName);
  deepStrictEqual(
    stored.state.authors.map((item) => item.userId),
    ["before", "after"],
  );
  deepStrictEqual(stored.state.posts, [post]);
});

test("POST-004 duplicate direct commits backfill aliases without replacing first provenance", async () => {
  const harness = createHarness("direct-provenance");
  const firstPost = {
    postId: "zhihu:article:8",
    platformId: "zhihu" as const,
    kind: "article" as const,
    contentId: "8",
    title: "First",
    url: "https://zhuanlan.zhihu.com/p/8",
  };
  const nextPost = {
    ...firstPost,
    postId: "zhihu:article:9",
    contentId: "9",
    title: "Next",
    url: "https://zhuanlan.zhihu.com/p/9",
  };
  await harness.repository.ensurePost(firstPost);
  await harness.repository.ensurePost(nextPost);
  const input = {
    platformId: "zhihu",
    userId: "direct",
    memberHashId: null,
    authorNameAtCapture: "First name",
    tag: { tagId: DEFAULT_TAG_ID, name: "default" },
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
    sourcePostId: firstPost.postId,
  };
  strictEqual((await harness.repository.commitAuthor(input)).status, "persisted");
  const duplicate = await harness.repository.commitAuthor({
    ...input,
    memberHashId: HASH_A,
    sourcePostId: nextPost.postId,
    authorNameAtCapture: "Ignored",
  });
  strictEqual(duplicate.status, "duplicate");
  strictEqual(duplicate.author?.sourcePostId, firstPost.postId);
  strictEqual(duplicate.author?.memberHashId, HASH_A);
  strictEqual(duplicate.author?.authorNameAtCapture, "First name");
  strictEqual(
    (
      await harness.repository.restoreAuthor({
        ...author("other"),
        platformId: "other",
        sourcePostId: firstPost.postId,
      })
    ).status,
    "invalid",
  );
});

test("POST-002 failed post persistence writes no authors and preserves quota classification", async () => {
  const harness = createHarness("post-quota");
  await harness.repository.querySummary();
  const original = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore["add"]>) {
    if (this.name === BLACKLIST_STORE_NAMES.posts)
      throw new DOMException("Synthetic quota", "QuotaExceededError");
    return original.apply(this, args);
  };
  try {
    await rejects(
      harness.repository.ensurePost({
        postId: "zhihu:article:9",
        platformId: "zhihu",
        kind: "article",
        contentId: "9",
        title: "Synthetic",
        url: "https://zhuanlan.zhihu.com/p/9",
      }),
      { name: "QuotaExceededError" },
    );
  } finally {
    IDBObjectStore.prototype.add = original;
  }
  strictEqual((await harness.repository.querySummary()).authorCount, 0);
  deepStrictEqual(await readStoreValues(harness.databaseName, BLACKLIST_STORE_NAMES.posts), []);
});

test("AC-093 migrates each valid v1-v5 state once into normalized stores", async () => {
  for (const version of [1, 2, 3, 4, 5] as const) {
    const harness = createHarness(`v${version}`);
    const legacy = legacyState(version);
    harness.storage.values.set(STORAGE_KEY, legacy);

    await harness.repository.querySummary();
    const stored = await readLogicalState(indexedDB, harness.databaseName);
    const parsed = parseBlacklistState(legacy);
    strictEqual(parsed.status === "migrated" || parsed.status === "valid", true);
    deepStrictEqual(stored.state, parsed.state);
    strictEqual(stored.revision, 0);
    strictEqual(harness.storage.values.has(STORAGE_KEY), false);

    const authors = await readStoreValues(harness.databaseName, BLACKLIST_STORE_NAMES.authors);
    const identifiers = await readStoreValues(
      harness.databaseName,
      BLACKLIST_STORE_NAMES.identifiers,
    );
    const tags = await readStoreValues(harness.databaseName, BLACKLIST_STORE_NAMES.tags);
    const metadata = await readStoreValues(harness.databaseName, BLACKLIST_STORE_NAMES.metadata);
    strictEqual(authors.length, 1);
    strictEqual(identifiers.length, version >= 4 ? 2 : 1);
    strictEqual(tags.length, 1);
    strictEqual(metadata.length, 1);
    strictEqual(
      metadata.some((value) => JSON.stringify(value) === JSON.stringify(parsed.state)),
      false,
    );
  }
});

test("AC-093 initializes only missing legacy data and keeps malformed, future, or unreadable input non-authoritative", async () => {
  const missing = createHarness("missing");
  await missing.repository.querySummary();
  deepStrictEqual(
    (await readLogicalState(indexedDB, missing.databaseName)).state,
    createInitialState(),
  );

  for (const legacy of [
    { schemaVersion: 5, authors: [], tags: [] },
    { schemaVersion: 6, authors: [], tags: [] },
    ...malformedLegacyStates(),
  ]) {
    const harness = createHarness("invalid");
    harness.storage.values.set(STORAGE_KEY, legacy);
    await rejects(harness.repository.querySummary(), /unreadable|malformed/i);
    deepStrictEqual(
      await readStoreValues(harness.databaseName, BLACKLIST_STORE_NAMES.metadata),
      [],
    );
    strictEqual(harness.storage.values.get(STORAGE_KEY), legacy);
  }

  const unreadable = createHarness("unreadable");
  unreadable.storage.failGet = true;
  await rejects(unreadable.repository.querySummary(), /unreadable/i);
  deepStrictEqual(
    await readStoreValues(unreadable.databaseName, BLACKLIST_STORE_NAMES.metadata),
    [],
  );
});

test("AC-093 aborts migration atomically and leaves the legacy key untouched", async () => {
  const harness = createHarness("abort", new MemoryStorage(), () => {
    throw new Error("injected migration abort");
  });
  const legacy = legacyState(5);
  harness.storage.values.set(STORAGE_KEY, legacy);

  await rejects(harness.repository.querySummary(), /migration abort/i);
  strictEqual(harness.storage.values.get(STORAGE_KEY), legacy);
  for (const storeName of Object.values(BLACKLIST_STORE_NAMES)) {
    deepStrictEqual(await readStoreValues(harness.databaseName, storeName), []);
  }
});

test("AC-093 committed IDB wins over a stale legacy key and retries cleanup without reimport", async () => {
  const storage = new MemoryStorage();
  storage.failRemoveCount = 1;
  const harness = createHarness("cleanup", storage);
  storage.values.set(STORAGE_KEY, legacyState(5));

  const first = await harness.repository.querySummary();
  const firstStored = await readLogicalState(indexedDB, harness.databaseName);
  strictEqual(storage.values.has(STORAGE_KEY), true);
  storage.values.set(STORAGE_KEY, {
    ...createInitialState(),
    authors: [author("stale-author")],
  });

  const restarted = createBlacklistRepository({
    indexedDB,
    databaseName: harness.databaseName,
    storage,
  });
  const second = await restarted.querySummary();
  deepStrictEqual(second, first);
  deepStrictEqual(await readLogicalState(indexedDB, harness.databaseName), firstStored);
  strictEqual(storage.values.has(STORAGE_KEY), false);
  deepStrictEqual(storage.removed, [STORAGE_KEY]);
});

test("AC-093 revision publication failure never rolls back durable data and is repaired later", async () => {
  const harness = createHarness("revision");
  harness.storage.failRevisionSetCount = 3;
  await harness.repository.querySummary();

  const committed = await harness.repository.commitAuthor({
    sourcePostId: null,
    platformId: ZHIHU_PLATFORM_ID,
    userId: "durable-author",
    memberHashId: null,
    authorNameAtCapture: "Durable author",
    tag: { tagId: DEFAULT_TAG_ID, name: "default" },
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
  });
  strictEqual(committed.status, "persisted");
  strictEqual(harness.storage.values.has(BLACKLIST_REVISION_STORAGE_KEY), false);

  await harness.repository.querySummary();
  const stored = await readLogicalState(indexedDB, harness.databaseName);
  strictEqual(stored.state.authors[0]?.userId, "durable-author");
  deepStrictEqual(harness.storage.values.get(BLACKLIST_REVISION_STORAGE_KEY), {
    version: 1,
    revision: 1,
  });
});

test("STORAGE-001 creates normalized stores and unique identifier/name indexes", async () => {
  const harness = createHarness("schema");
  await harness.repository.querySummary();
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(harness.databaseName);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    deepStrictEqual(
      [...database.objectStoreNames].sort(),
      Object.values(BLACKLIST_STORE_NAMES).sort(),
    );
    const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readonly");
    strictEqual(
      transaction.objectStore(BLACKLIST_STORE_NAMES.authors).index("by-platform-user").unique,
      true,
    );
    strictEqual(
      transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers).index("by-platform-identifier")
        .unique,
      true,
    );
    strictEqual(transaction.objectStore(BLACKLIST_STORE_NAMES.tags).index("by-name").unique, true);
  } finally {
    database.close();
  }
});

function stateWithSyntheticAuthors(count: number): BlacklistState {
  return {
    ...createInitialState(),
    authors: Array.from({ length: count }, (_, index) => author(`existing-${index}`)),
  };
}

function observeTargetedTransactions() {
  const originalStoreGetAll = IDBObjectStore.prototype.getAll;
  const originalIndexGetAll = IDBIndex.prototype.getAll;
  const originalTransaction = IDBDatabase.prototype.transaction;
  const authorEnumerations: string[] = [];
  let transactionCount = 0;
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    if (this.name === BLACKLIST_STORE_NAMES.authors) authorEnumerations.push("store");
    return originalStoreGetAll.apply(this, args);
  };
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (this.objectStore.name === BLACKLIST_STORE_NAMES.authors) {
      authorEnumerations.push(this.name);
    }
    return originalIndexGetAll.apply(this, args);
  };
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
    transactionCount += 1;
    return originalTransaction.apply(this, args);
  };
  return {
    authorEnumerations,
    transactionCount: () => transactionCount,
    restore() {
      IDBObjectStore.prototype.getAll = originalStoreGetAll;
      IDBIndex.prototype.getAll = originalIndexGetAll;
      IDBDatabase.prototype.transaction = originalTransaction;
    },
  };
}

test("AC-094 targeted author operations never enumerate or replace the author collection", async () => {
  const harness = createHarness("targeted");
  const initial = stateWithSyntheticAuthors(250);
  await harness.repository.querySummary();
  await storeLogicalState(indexedDB, harness.databaseName, initial);

  const observation = observeTargetedTransactions();

  try {
    const direct = await harness.repository.commitAuthor({
      sourcePostId: null,
      platformId: ZHIHU_PLATFORM_ID,
      userId: "new-direct",
      memberHashId: HASH_A,
      authorNameAtCapture: "New direct",
      tag: { tagId: DEFAULT_TAG_ID, name: "default" },
      isNewTag: false,
      blacklistedAt: TIMESTAMP,
    });
    strictEqual(direct.status, "persisted");
    strictEqual(
      (
        await harness.repository.commitAuthor({
          sourcePostId: null,
          platformId: ZHIHU_PLATFORM_ID,
          userId: "new-direct",
          memberHashId: HASH_A,
          authorNameAtCapture: "Ignored duplicate",
          tag: { tagId: DEFAULT_TAG_ID, name: "default" },
          isNewTag: false,
          blacklistedAt: TIMESTAMP,
        })
      ).status,
      "duplicate",
    );
    strictEqual(
      (
        await harness.repository.backfillMemberHash(
          { platformId: ZHIHU_PLATFORM_ID, userId: "existing-0" },
          HASH_B,
        )
      ).status,
      "persisted",
    );
    strictEqual(
      (
        await harness.repository.commitUpvoter({
          sourcePostId: null,
          platformId: ZHIHU_PLATFORM_ID,
          userId: "new-upvoter",
          authorNameAtCapture: "New upvoter",
          tagId: DEFAULT_TAG_ID,
          blacklistedAt: TIMESTAMP,
        })
      ).status,
      "persisted",
    );
    deepStrictEqual(
      await harness.repository.preflightDirect({
        platformId: ZHIHU_PLATFORM_ID,
        userId: "new-direct",
        expectedBlacklistedAt: TIMESTAMP,
      }),
      { status: "ready" },
    );
  } finally {
    observation.restore();
  }
  deepStrictEqual(observation.authorEnumerations, []);
  strictEqual(observation.transactionCount(), 5);
});

test("AC-094 duplicate author commit ignores a tag deleted after the drawer opened", async () => {
  const harness = createHarness("duplicate-deleted-tag");
  await harness.repository.querySummary();
  const first = await harness.repository.commitAuthor({
    sourcePostId: null,
    platformId: ZHIHU_PLATFORM_ID,
    userId: "existing-direct",
    memberHashId: null,
    authorNameAtCapture: "Existing direct",
    tag: { tagId: DEFAULT_TAG_ID, name: "default" },
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
  });
  strictEqual(first.status, "persisted");

  const duplicate = await harness.repository.commitAuthor({
    sourcePostId: null,
    platformId: ZHIHU_PLATFORM_ID,
    userId: "existing-direct",
    memberHashId: null,
    authorNameAtCapture: "Ignored duplicate",
    tag: { tagId: "deleted-after-open", name: "Deleted" },
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
  });

  strictEqual(duplicate.status, "duplicate");
  strictEqual(duplicate.revision, first.revision);
  strictEqual(duplicate.author.tagId, DEFAULT_TAG_ID);
});

test("AC-094 targeted transactions enforce same-platform cross-field uniqueness and cross-platform isolation", async () => {
  const harness = createHarness("identity");
  await harness.repository.querySummary();
  strictEqual(
    (
      await harness.repository.commitAuthor({
        sourcePostId: null,
        platformId: ZHIHU_PLATFORM_ID,
        userId: "primary",
        memberHashId: HASH_A,
        authorNameAtCapture: "Primary",
        tag: { tagId: DEFAULT_TAG_ID, name: "default" },
        isNewTag: false,
        blacklistedAt: TIMESTAMP,
      })
    ).status,
    "persisted",
  );

  strictEqual(
    (
      await harness.repository.commitUpvoter({
        sourcePostId: null,
        platformId: ZHIHU_PLATFORM_ID,
        userId: HASH_A,
        authorNameAtCapture: "Collision",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
      })
    ).status,
    "duplicate",
  );
  strictEqual(
    (
      await harness.repository.commitUpvoter({
        sourcePostId: null,
        platformId: "youtube",
        userId: HASH_A,
        authorNameAtCapture: "Other platform",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
      })
    ).status,
    "invalid",
  );
  await storeLogicalState(
    indexedDB,
    harness.databaseName,
    {
      schemaVersion: 6,
      posts: [],
      tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
      authors: [
        author("primary", { memberHashId: HASH_A }),
        {
          ...author(HASH_A),
          platformId: "youtube",
          memberHashId: null,
        },
      ],
    },
    2,
  );
  strictEqual((await readLogicalState(indexedDB, harness.databaseName)).state.authors.length, 2);
});

test("AC-094 repository rejects out-of-scope and oversized targeted writes", async () => {
  const harness = createHarness("targeted-validation");
  await harness.repository.querySummary();
  const direct = {
    platformId: ZHIHU_PLATFORM_ID,
    userId: "valid-user",
    sourcePostId: null,
    memberHashId: null,
    authorNameAtCapture: "Valid author",
    tag: { tagId: DEFAULT_TAG_ID, name: "default" },
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
  } as const;

  strictEqual(
    (await harness.repository.commitAuthor({ ...direct, platformId: "youtube" })).status,
    "invalid",
  );
  strictEqual(
    (
      await harness.repository.commitAuthor({
        ...direct,
        authorNameAtCapture: "A".repeat(501),
      })
    ).status,
    "invalid",
  );
  strictEqual(
    (
      await harness.repository.commitUpvoter({
        sourcePostId: null,
        platformId: "youtube",
        userId: "other-platform",
        authorNameAtCapture: "Other platform",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
      })
    ).status,
    "invalid",
  );
  strictEqual(
    (
      await harness.repository.backfillMemberHash(
        { platformId: ZHIHU_PLATFORM_ID, userId: "A".repeat(32) },
        HASH_A,
      )
    ).status,
    "invalid",
  );
  const stored = await readLogicalState(indexedDB, harness.databaseName);
  strictEqual(stored.revision, 0);
  deepStrictEqual(stored.state.authors, []);
});

test("AC-096 management mutations remain atomic on normalized records", async () => {
  const harness = createHarness("management-mutations");
  await harness.repository.querySummary();
  const reading = { tagId: "reading", name: "Reading" };
  const first = author("first", { tagId: reading.tagId });
  const second = author("second");
  await storeLogicalState(indexedDB, harness.databaseName, {
    schemaVersion: 6,
    posts: [],
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }, reading],
    authors: [first, second],
  });

  const removed = await harness.repository.removeAuthor({
    platformId: first.platformId,
    userId: first.userId,
  });
  strictEqual(removed.status, "persisted");
  strictEqual((await harness.repository.restoreAuthor(first)).status, "persisted");
  strictEqual((await harness.repository.renameTag(reading.tagId, "Research")).status, "persisted");
  strictEqual(
    (
      await harness.repository.removeAuthors([
        { platformId: first.platformId, userId: first.userId },
        { platformId: second.platformId, userId: second.userId },
      ])
    ).status,
    "persisted",
  );

  const stored = await readLogicalState(indexedDB, harness.databaseName);
  deepStrictEqual(stored.state.authors, []);
  strictEqual(stored.state.tags[1]?.name, "Research");
});

test("POST-004 physical storage uses the atomic v3 schema", () => {
  strictEqual(BLACKLIST_DATABASE_VERSION, 3);
});

test("AC-094 tag deletion reads only authors referencing that tag", async () => {
  const harness = createHarness("delete-tag");
  await harness.repository.querySummary();
  const state: BlacklistState = {
    schemaVersion: 6,
    posts: [],
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "reading", name: "Reading" },
    ],
    authors: [author("default-author"), author("tagged-author", { tagId: "reading" })],
  };
  await storeLogicalState(indexedDB, harness.databaseName, state);

  const original = IDBIndex.prototype.getAll;
  const queries: string[] = [];
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (this.objectStore.name === BLACKLIST_STORE_NAMES.authors) queries.push(this.name);
    return original.apply(this, args);
  };
  try {
    const result = await harness.repository.deleteTag("reading");
    strictEqual(result.status, "persisted");
  } finally {
    IDBIndex.prototype.getAll = original;
  }
  deepStrictEqual(queries, ["by-tag"]);
  const stored = await readLogicalState(indexedDB, harness.databaseName);
  strictEqual(stored.state.authors[1]?.tagId, DEFAULT_TAG_ID);
});
