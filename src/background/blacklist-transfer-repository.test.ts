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
  createInitialState,
  type BlacklistState,
  type BlacklistedAuthor,
} from "../content/blacklist-state.ts";
import { BLACKLIST_REVISION_STORAGE_KEY } from "../core/blacklist-revision-contract.ts";
import {
  createBlacklistTransferFileMetadata,
  type BlacklistTransferAuthorDto,
  type BlacklistTransferEnvelopeV1,
} from "../core/blacklist-transfer-values.ts";
import {
  ImportChunkConflictError,
  ImportSessionExpiredError,
  IncompleteBlacklistImportError,
  StaleBlacklistExportError,
  TransferFinalizeConflictError,
} from "./blacklist-transfer-repository-errors.ts";
import { readLogicalState, storeLogicalState } from "./blacklist-repository.test-support.ts";
import {
  BLACKLIST_STORE_NAMES,
  createBlacklistRepository,
  type BlacklistRepositoryOptions,
} from "./blacklist-repository.ts";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: FakeIDBKeyRange,
});

const TIME = "2026-08-25T12:34:56.789Z";
const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const SESSION_A = "1".repeat(32);
const SESSION_B = "2".repeat(32);

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

function author(
  userId: string,
  overrides: Partial<BlacklistTransferAuthorDto> = {},
): BlacklistTransferAuthorDto {
  return {
    platformId: "zhihu",
    userId,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${userId}`,
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIME,
    blockSource: "direct",
    ...overrides,
  };
}

function storedAuthor(
  userId: string,
  overrides: Partial<BlacklistedAuthor> = {},
): BlacklistedAuthor {
  return author(userId, overrides) as BlacklistedAuthor;
}

function transfer(
  authors: readonly BlacklistTransferAuthorDto[],
  tags: BlacklistTransferEnvelopeV1["tags"] = [{ tagId: DEFAULT_TAG_ID, name: "default" }],
): BlacklistTransferEnvelopeV1 {
  return {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: TIME,
    schemaVersion: 5,
    authors,
    tags,
  };
}

function uniqueDatabaseName(label: string): string {
  return `cocoon-transfer-${label}-${crypto.randomUUID()}`;
}

function createHarness(label: string, overrides: Partial<BlacklistRepositoryOptions> = {}) {
  const storage = (overrides.storage as MemoryStorage | undefined) ?? new MemoryStorage();
  const databaseName = overrides.databaseName ?? uniqueDatabaseName(label);
  let now = 1_000;
  const sessionIds = [SESSION_A, SESSION_B];
  const options: BlacklistRepositoryOptions = {
    indexedDB,
    storage,
    databaseName,
    clock: () => now,
    randomSessionId: () => sessionIds.shift() ?? "3".repeat(32),
    ...overrides,
  };
  return {
    databaseName,
    options,
    repository: createBlacklistRepository(options),
    storage,
    setNow(value: number) {
      now = value;
    },
  };
}

async function beginImport(
  repository: ReturnType<typeof createBlacklistRepository>,
  value: BlacklistTransferEnvelopeV1,
  authorChunkCount = value.authors.length === 0 ? 0 : 1,
  tagChunkCount = 1,
) {
  const json = JSON.stringify(value);
  const metadata = {
    ...createBlacklistTransferFileMetadata(value, new TextEncoder().encode(json).byteLength),
    authorChunkCount,
    tagChunkCount,
  };
  return repository.beginImport(metadata);
}

async function stageSingleChunkTransfer(
  repository: ReturnType<typeof createBlacklistRepository>,
  sessionId: string,
  value: BlacklistTransferEnvelopeV1,
): Promise<void> {
  await repository.stageTagsChunk({
    sessionId,
    chunkIndex: 0,
    startIndex: 0,
    tags: value.tags,
  });
  if (value.authors.length > 0) {
    await repository.stageAuthorsChunk({
      sessionId,
      chunkIndex: 0,
      startIndex: 0,
      authors: value.authors,
    });
  }
}

async function replaceLive(
  repository: ReturnType<typeof createBlacklistRepository>,
  databaseName: string,
  state: BlacklistState,
): Promise<void> {
  await repository.querySummary();
  await storeLogicalState(indexedDB, databaseName, state);
}

test("BUG-016/AC-099 stages out of order, resumes after worker rebuild, and finalizes replace", async () => {
  const harness = createHarness("replace-roundtrip");
  await replaceLive(harness.repository, harness.databaseName, {
    ...createInitialState(),
    authors: [storedAuthor("old")],
  });
  const imported = transfer(
    [author("first", { tagId: "reading" }), author("second")],
    [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "reading", name: "Reading" },
    ],
  );
  const started = await beginImport(harness.repository, imported, 2);

  await harness.repository.stageAuthorsChunk({
    sessionId: started.sessionId,
    chunkIndex: 1,
    startIndex: 1,
    authors: [imported.authors[1]!],
  });
  await harness.repository.stageTagsChunk({
    sessionId: started.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    tags: imported.tags,
  });

  const restarted = createBlacklistRepository(harness.options);
  strictEqual((await restarted.inspectImport(started.sessionId))?.received.authors.count, 1);
  await restarted.stageAuthorsChunk({
    sessionId: started.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    authors: [imported.authors[0]!],
  });
  strictEqual((await restarted.inspectImport(started.sessionId))?.status, "ready");

  const result = await restarted.finalizeReplace(started.sessionId);
  strictEqual(result.revision, 2);
  deepStrictEqual((await readLogicalState(indexedDB, harness.databaseName)).state, {
    schemaVersion: 5,
    authors: imported.authors,
    tags: imported.tags,
  });
  strictEqual(await restarted.inspectImport(started.sessionId), null);
  deepStrictEqual(harness.storage.values.get(BLACKLIST_REVISION_STORAGE_KEY), {
    version: 1,
    revision: 2,
  });
});

test("BUG-016/AC-099 identical chunk retries are idempotent and conflicting retries are rejected", async () => {
  const harness = createHarness("chunk-retry");
  await harness.repository.querySummary();
  const imported = transfer([author("first"), author("second")]);
  const started = await beginImport(harness.repository, imported);
  await harness.repository.stageTagsChunk({
    sessionId: started.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    tags: imported.tags,
  });
  const input = {
    sessionId: started.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    authors: imported.authors,
  } as const;
  strictEqual((await harness.repository.stageAuthorsChunk(input)).status, "staged");
  strictEqual((await harness.repository.stageAuthorsChunk(input)).status, "duplicate");
  strictEqual(
    (await harness.repository.inspectImport(started.sessionId))?.received.authors.count,
    2,
  );

  await rejects(
    harness.repository.stageAuthorsChunk({
      ...input,
      authors: [author("changed"), imported.authors[1]!],
    }),
    ImportChunkConflictError,
  );
  strictEqual(
    (await harness.repository.inspectImport(started.sessionId))?.received.authors.count,
    2,
  );
});

test("BUG-016/AC-099 incomplete or conflicting staged data never changes live state", async () => {
  const harness = createHarness("incomplete");
  await replaceLive(harness.repository, harness.databaseName, {
    ...createInitialState(),
    authors: [storedAuthor("live")],
  });
  const imported = transfer([author("first"), author("second")]);
  const started = await beginImport(harness.repository, imported, 2);
  await harness.repository.stageTagsChunk({
    sessionId: started.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    tags: imported.tags,
  });
  await harness.repository.stageAuthorsChunk({
    sessionId: started.sessionId,
    chunkIndex: 1,
    startIndex: 1,
    authors: [imported.authors[1]!],
  });
  await rejects(
    harness.repository.finalizeReplace(started.sessionId),
    IncompleteBlacklistImportError,
  );
  deepStrictEqual(
    (await readLogicalState(indexedDB, harness.databaseName)).state.authors.map(
      ({ userId }) => userId,
    ),
    ["live"],
  );
  strictEqual((await harness.repository.inspectImport(started.sessionId))?.status, "receiving");
});

test("BUG-016/AC-099 sessions isolate identical identities and abort removes only its staging", async () => {
  const harness = createHarness("session-isolation");
  await harness.repository.querySummary();
  const imported = transfer([author("same", { memberHashId: HASH_A })]);
  const first = await beginImport(harness.repository, imported);
  const second = await beginImport(harness.repository, imported);
  await stageSingleChunkTransfer(harness.repository, first.sessionId, imported);
  await stageSingleChunkTransfer(harness.repository, second.sessionId, imported);

  strictEqual(await harness.repository.abortImport(first.sessionId), true);
  strictEqual(await harness.repository.inspectImport(first.sessionId), null);
  strictEqual((await harness.repository.inspectImport(second.sessionId))?.status, "ready");
  await harness.repository.finalizeReplace(second.sessionId);
  strictEqual((await readLogicalState(indexedDB, harness.databaseName)).state.authors.length, 1);
});

test("BUG-016/AC-099 merge keeps local authors and remaps same-name imported tags", async () => {
  const harness = createHarness("merge");
  const localDuplicate = storedAuthor("duplicate", {
    authorNameAtCapture: "Local exact value",
    tagId: "local-work",
    memberHashId: HASH_A,
  });
  await replaceLive(harness.repository, harness.databaseName, {
    schemaVersion: 5,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "local-work", name: "Work" },
    ],
    authors: [localDuplicate],
  });
  const imported = transfer(
    [
      author("duplicate", { authorNameAtCapture: "Ignored", memberHashId: HASH_B }),
      author("new", { tagId: "incoming-work" }),
    ],
    [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "incoming-work", name: "WORK" },
      { tagId: "new-tag", name: "New" },
    ],
  );
  const started = await beginImport(harness.repository, imported);
  await stageSingleChunkTransfer(harness.repository, started.sessionId, imported);

  const result = await harness.repository.finalizeMerge(started.sessionId);
  strictEqual(result.revision, 2);
  const state = (await readLogicalState(indexedDB, harness.databaseName)).state;
  deepStrictEqual(state.authors[0], localDuplicate);
  strictEqual(state.authors[1]?.tagId, "local-work");
  deepStrictEqual(state.tags, [
    { tagId: DEFAULT_TAG_ID, name: "default" },
    { tagId: "local-work", name: "Work" },
    { tagId: "new-tag", name: "New" },
  ]);
});

test("BUG-016/AC-099 tag-id/name and alias conflicts reject the whole finalize", async () => {
  for (const [label, imported] of [
    [
      "tag",
      transfer(
        [],
        [
          { tagId: DEFAULT_TAG_ID, name: "default" },
          { tagId: "local", name: "Different" },
        ],
      ),
    ],
    ["alias", transfer([author("new", { memberHashId: HASH_A })])],
  ] as const) {
    const harness = createHarness(`conflict-${label}`);
    await replaceLive(harness.repository, harness.databaseName, {
      schemaVersion: 5,
      tags: [
        { tagId: DEFAULT_TAG_ID, name: "default" },
        { tagId: "local", name: "Local" },
      ],
      authors: [storedAuthor("owner", { memberHashId: HASH_A })],
    });
    const started = await beginImport(harness.repository, imported);
    await stageSingleChunkTransfer(harness.repository, started.sessionId, imported);
    await rejects(
      harness.repository.finalizeMerge(started.sessionId),
      TransferFinalizeConflictError,
    );
    deepStrictEqual(
      (await readLogicalState(indexedDB, harness.databaseName)).state.authors.map(
        ({ userId }) => userId,
      ),
      ["owner"],
    );
    strictEqual((await harness.repository.inspectImport(started.sessionId))?.status, "ready");
  }
});

test("BUG-016/AC-099 quota and transaction abort leave live and staging retryable", async () => {
  for (const [label, beforeFinalizeCommit] of [
    [
      "quota",
      () => {
        throw new DOMException("synthetic quota", "QuotaExceededError");
      },
    ],
    ["abort", (transaction: IDBTransaction) => transaction.abort()],
  ] as const) {
    const databaseName = uniqueDatabaseName(label);
    const storage = new MemoryStorage();
    const failing = createHarness(label, { databaseName, storage, beforeFinalizeCommit });
    await replaceLive(failing.repository, failing.databaseName, {
      ...createInitialState(),
      authors: [storedAuthor("live")],
    });
    const imported = transfer([author("replacement")]);
    const started = await beginImport(failing.repository, imported);
    await stageSingleChunkTransfer(failing.repository, started.sessionId, imported);
    await rejects(failing.repository.finalizeReplace(started.sessionId));
    deepStrictEqual(
      (await readLogicalState(indexedDB, failing.databaseName)).state.authors.map(
        ({ userId }) => userId,
      ),
      ["live"],
    );
    strictEqual((await failing.repository.inspectImport(started.sessionId))?.status, "ready");

    const retry = createBlacklistRepository({
      indexedDB,
      databaseName,
      storage,
      clock: () => 1_000,
      randomSessionId: () => "4".repeat(32),
    });
    await retry.finalizeReplace(started.sessionId);
    deepStrictEqual(
      (await readLogicalState(indexedDB, databaseName)).state.authors.map(({ userId }) => userId),
      ["replacement"],
    );
  }
});

test("BUG-016/AC-099 injected clock drives expiry inspection and lazy cleanup without timers", async () => {
  const harness = createHarness("expiry");
  await harness.repository.querySummary();
  const imported = transfer([author("staged")]);
  const started = await beginImport(harness.repository, imported);
  harness.setNow(started.expiresAt);
  strictEqual((await harness.repository.inspectImport(started.sessionId))?.status, "expired");
  await rejects(
    harness.repository.stageAuthorsChunk({
      sessionId: started.sessionId,
      chunkIndex: 0,
      startIndex: 0,
      authors: imported.authors,
    }),
    ImportSessionExpiredError,
  );
  strictEqual(await harness.repository.cleanupExpiredImports(), 1);
  strictEqual(await harness.repository.inspectImport(started.sessionId), null);
});

test("BUG-016/AC-099 export pages preserve format order and become stale after revision changes", async () => {
  const harness = createHarness("export");
  await replaceLive(harness.repository, harness.databaseName, {
    schemaVersion: 5,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "one", name: "One" },
      { tagId: "two", name: "Two" },
    ],
    authors: [storedAuthor("a"), storedAuthor("b", { tagId: "one" }), storedAuthor("c")],
  });
  const started = await harness.repository.beginExport();
  strictEqual(started.authorCount, 3);
  strictEqual(started.tagCount, 3);
  strictEqual(started.exportedAt, new Date(1_000).toISOString());

  const tags: string[] = [];
  let tagCursor: string | null = null;
  do {
    const page = await harness.repository.exportTagsPage({
      revision: started.revision,
      cursor: tagCursor,
      limit: 1,
    });
    tags.push(...page.items.map(({ tagId }) => tagId));
    tagCursor = page.nextCursor;
  } while (tagCursor !== null);
  deepStrictEqual(tags, [DEFAULT_TAG_ID, "one", "two"]);

  const authors: string[] = [];
  let authorCursor: string | null = null;
  do {
    const page = await harness.repository.exportAuthorsPage({
      revision: started.revision,
      cursor: authorCursor,
      limit: 2,
    });
    authors.push(...page.items.map(({ userId }) => userId));
    authorCursor = page.nextCursor;
  } while (authorCursor !== null);
  deepStrictEqual(authors, ["a", "b", "c"]);
  deepStrictEqual(await harness.repository.finishExport(started.revision), {
    revision: started.revision,
  });

  await harness.repository.commitUpvoter({
    platformId: "zhihu",
    userId: "changed",
    authorNameAtCapture: "Changed",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIME,
  });
  await rejects(
    harness.repository.exportAuthorsPage({ revision: started.revision, cursor: null, limit: 1 }),
    StaleBlacklistExportError,
  );
  await rejects(harness.repository.finishExport(started.revision), StaleBlacklistExportError);
});

test("BUG-016/AC-099 transfer repository never calls live authors/identifiers getAll", async () => {
  const harness = createHarness("no-live-get-all");
  await harness.repository.querySummary();
  const imported = transfer([author("a"), author("b")]);
  const started = await beginImport(harness.repository, imported);
  await stageSingleChunkTransfer(harness.repository, started.sessionId, imported);

  const originalStoreGetAll = IDBObjectStore.prototype.getAll;
  const originalIndexGetAll = IDBIndex.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore["getAll"]>) {
    if (
      this.name === BLACKLIST_STORE_NAMES.authors ||
      this.name === BLACKLIST_STORE_NAMES.identifiers
    ) {
      throw new Error("live getAll forbidden");
    }
    return originalStoreGetAll.apply(this, args);
  };
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (
      this.objectStore.name === BLACKLIST_STORE_NAMES.authors ||
      this.objectStore.name === BLACKLIST_STORE_NAMES.identifiers
    ) {
      throw new Error("live getAll forbidden");
    }
    return originalIndexGetAll.apply(this, args);
  };
  try {
    await harness.repository.finalizeMerge(started.sessionId);
    const exported = await harness.repository.beginExport();
    await harness.repository.exportAuthorsPage({
      revision: exported.revision,
      cursor: null,
      limit: 500,
    });
    await harness.repository.exportTagsPage({
      revision: exported.revision,
      cursor: null,
      limit: 500,
    });
  } finally {
    IDBObjectStore.prototype.getAll = originalStoreGetAll;
    IDBIndex.prototype.getAll = originalIndexGetAll;
  }
});
