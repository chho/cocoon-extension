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
  type BlacklistTransferEnvelopeV2,
} from "../core/blacklist-transfer-values.ts";
import {
  ImportChunkConflictError,
  ImportSessionExpiredError,
  IncompleteBlacklistImportError,
  StaleBlacklistExportError,
  TransferFinalizeConflictError,
} from "./blacklist-transfer-repository-errors.ts";
import { parseStoredImportAuthor } from "./blacklist-idb-import-schema.ts";
import { openBlacklistDatabase, requestResult, transactionDone } from "./blacklist-idb-schema.ts";
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

import type { SourcePost } from "../core/source-post.ts";
import { createBlacklistTransferController } from "./blacklist-transfer-controller.ts";
import { createBlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import { parseBlacklistTransferRequest } from "../core/blacklist-transfer-rpc-contract.ts";
import {
  BLACKLIST_TRANSFER_RPC_BYTES,
  blacklistTransferJsonBytes,
  parseBlacklistTransferFileJson,
} from "../core/blacklist-transfer-values.ts";
import { createBlacklistTransferResponse } from "../core/blacklist-transfer-rpc-contract.ts";
import { prepareBlacklistTransferJson } from "../options/transfer-file.ts";
import { runBlacklistExport, runBlacklistImport } from "../options/transfer-pipeline.ts";

const POST: SourcePost = {
  postId: "zhihu:answer:2",
  platformId: "zhihu",
  kind: "answer",
  contentId: "2",
  title: "First synthetic title",
  url: "https://www.zhihu.com/question/1/answer/2",
};
const OTHER_POST: SourcePost = {
  postId: "zhihu:article:3",
  platformId: "zhihu",
  kind: "article",
  contentId: "3",
  title: "Other synthetic title",
  url: "https://zhuanlan.zhihu.com/p/3",
};

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
    sourcePostId: null,
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
  tags: BlacklistTransferEnvelopeV2["tags"] = [{ tagId: DEFAULT_TAG_ID, name: "default" }],
): BlacklistTransferEnvelopeV2 {
  return {
    product: "cocoon-blacklist",
    formatVersion: 2,
    exportedAt: TIME,
    schemaVersion: 6,
    authors,
    tags,
    posts: [],
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
  value: BlacklistTransferEnvelopeV2,
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
  value: BlacklistTransferEnvelopeV2,
): Promise<void> {
  if (value.posts.length > 0) {
    await repository.stagePostsChunk({
      sessionId,
      chunkIndex: 0,
      startIndex: 0,
      posts: value.posts,
    });
  }
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
    schemaVersion: 6,
    authors: imported.authors,
    tags: imported.tags,
    posts: [],
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
    schemaVersion: 6,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "local-work", name: "Work" },
    ],
    authors: [localDuplicate],
    posts: [],
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
      schemaVersion: 6,
      tags: [
        { tagId: DEFAULT_TAG_ID, name: "default" },
        { tagId: "local", name: "Local" },
      ],
      authors: [storedAuthor("owner", { memberHashId: HASH_A })],
      posts: [],
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
    schemaVersion: 6,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "one", name: "One" },
      { tagId: "two", name: "Two" },
    ],
    authors: [storedAuthor("a"), storedAuthor("b", { tagId: "one" }), storedAuthor("c")],
    posts: [],
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
    sourcePostId: null,
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
      this.name === BLACKLIST_STORE_NAMES.identifiers ||
      this.name === BLACKLIST_STORE_NAMES.posts
    ) {
      throw new Error("live getAll forbidden");
    }
    return originalStoreGetAll.apply(this, args);
  };
  IDBIndex.prototype.getAll = function (...args: Parameters<IDBIndex["getAll"]>) {
    if (
      this.objectStore.name === BLACKLIST_STORE_NAMES.authors ||
      this.objectStore.name === BLACKLIST_STORE_NAMES.identifiers ||
      this.objectStore.name === BLACKLIST_STORE_NAMES.posts
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

function transferClient(repository: ReturnType<typeof createBlacklistRepository>) {
  const controller = createBlacklistTransferController(repository);
  return createBlacklistTransferRpcClient(async (candidate) => {
    const request = parseBlacklistTransferRequest(candidate);
    if (!request) throw new Error("Invalid test request");
    return controller.handleTransfer(
      request.operation === "export-authors-page"
        ? { ...request, input: { ...request.input, limit: 1 } }
        : request,
    );
  });
}

test("POST-005 full export/import roundtrip deduplicates shared posts across pages and excludes orphans", async () => {
  const source = createHarness("posts-roundtrip-source");
  await replaceLive(source.repository, source.databaseName, {
    ...createInitialState(),
    posts: [POST, OTHER_POST],
    authors: [
      storedAuthor("a", { sourcePostId: POST.postId }),
      storedAuthor("b", { sourcePostId: POST.postId }),
    ],
  });
  const exported = await runBlacklistExport({ client: transferClient(source.repository) });
  const json = await new Blob([...exported.parts]).text();
  const parsed = parseBlacklistTransferFileJson(json);
  strictEqual(parsed.status, "valid");
  if (parsed.status !== "valid") throw new Error("Expected valid export");
  deepStrictEqual(parsed.transfer.posts, [POST]);
  deepStrictEqual(
    parsed.transfer.authors.map(({ sourcePostId }) => sourcePostId),
    [POST.postId, POST.postId],
  );
  const target = createHarness("posts-roundtrip-target");
  await replaceLive(target.repository, target.databaseName, {
    ...createInitialState(),
    posts: [OTHER_POST],
    authors: [storedAuthor("old", { sourcePostId: OTHER_POST.postId })],
  });
  const prepared = prepareBlacklistTransferJson(json);
  if (prepared.status !== "valid") throw new Error("Expected prepared export");
  await runBlacklistImport({
    client: transferClient(target.repository),
    prepared: prepared.prepared,
    mode: "replace",
    resumeSessionId: null,
  });
  const result = (await readLogicalState(indexedDB, target.databaseName)).state;
  deepStrictEqual(result.posts, [POST]);
  deepStrictEqual(result.authors, parsed.transfer.authors);
});

test("POST-005 merge keeps first shared title and never overwrites existing author provenance", async () => {
  const harness = createHarness("posts-merge");
  const existing = storedAuthor("existing");
  await replaceLive(harness.repository, harness.databaseName, {
    ...createInitialState(),
    posts: [POST],
    authors: [existing],
  });
  const imported = {
    ...transfer([
      author("existing", { sourcePostId: OTHER_POST.postId }),
      author("new", { sourcePostId: POST.postId }),
    ]),
    posts: [{ ...POST, title: "Later title" }, OTHER_POST],
  };
  const session = await beginImport(harness.repository, imported);
  await stageSingleChunkTransfer(harness.repository, session.sessionId, imported);
  await harness.repository.finalizeMerge(session.sessionId);
  const result = (await readLogicalState(indexedDB, harness.databaseName)).state;
  deepStrictEqual(result.authors[0], existing);
  strictEqual(result.authors[1]?.sourcePostId, POST.postId);
  strictEqual(result.posts.find(({ postId }) => postId === POST.postId)?.title, POST.title);
});

test("POST-005 finalize rejects missing imported refs even when live posts exist, with atomic rollback", async () => {
  for (const mode of ["merge", "replace"] as const) {
    const harness = createHarness(`missing-post-${mode}`);
    const before = { ...createInitialState(), posts: [POST], authors: [storedAuthor("old")] };
    await replaceLive(harness.repository, harness.databaseName, before);
    const imported = {
      ...transfer([author("new", { sourcePostId: POST.postId })]),
      posts: [OTHER_POST],
    };
    const session = await beginImport(harness.repository, imported);
    await stageSingleChunkTransfer(harness.repository, session.sessionId, imported);
    await rejects(
      mode === "merge"
        ? harness.repository.finalizeMerge(session.sessionId)
        : harness.repository.finalizeReplace(session.sessionId),
      IncompleteBlacklistImportError,
    );
    deepStrictEqual((await readLogicalState(indexedDB, harness.databaseName)).state, before);
    strictEqual((await harness.repository.inspectImport(session.sessionId))?.status, "ready");
  }
});

test("POST-005 author export pages budget attached post titles inside the RPC limit", async () => {
  const harness = createHarness("post-page-bytes");
  const posts: SourcePost[] = Array.from({ length: 120 }, (_, index) => ({
    ...OTHER_POST,
    postId: `zhihu:article:${index + 1}`,
    contentId: String(index + 1),
    title: "😀".repeat(500),
    url: `https://zhuanlan.zhihu.com/p/${index + 1}`,
  }));
  await replaceLive(harness.repository, harness.databaseName, {
    ...createInitialState(),
    posts,
    authors: posts.map((post, index) =>
      storedAuthor(`synthetic-${index}`, {
        sourcePostId: post.postId,
        authorNameAtCapture: "😀".repeat(500),
      }),
    ),
  });
  const begun = await harness.repository.beginExport();
  let cursor: string | null = null;
  let count = 0;
  let pages = 0;
  do {
    const page = await harness.repository.exportAuthorsPage({
      revision: begun.revision,
      cursor,
      limit: 500,
    });
    strictEqual(
      (blacklistTransferJsonBytes(
        createBlacklistTransferResponse("export-authors-page", true, page),
      ) ?? Infinity) <= BLACKLIST_TRANSFER_RPC_BYTES,
      true,
    );
    strictEqual(page.posts.length, page.items.length);
    count += page.items.length;
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor !== null);
  strictEqual(count, 120);
  strictEqual(pages > 1, true);
});

test("POST-005 post staging is persistent, duplicate-safe and rejects conflicting cross-chunk post ids", async () => {
  const harness = createHarness("post-chunk-retry");
  const value = {
    ...transfer([author("new", { sourcePostId: POST.postId })]),
    posts: [POST, OTHER_POST],
  };
  const metadata = {
    ...createBlacklistTransferFileMetadata(
      value,
      new TextEncoder().encode(JSON.stringify(value)).byteLength,
    ),
    postChunkCount: 2,
  };
  const session = await harness.repository.beginImport(metadata);
  const chunk = { sessionId: session.sessionId, chunkIndex: 0, startIndex: 0, posts: [POST] };
  await harness.repository.stagePostsChunk(chunk);
  const restarted = createBlacklistRepository(harness.options);
  strictEqual((await restarted.stagePostsChunk(chunk)).status, "duplicate");
  await rejects(
    restarted.stagePostsChunk({ ...chunk, chunkIndex: 1, startIndex: 1 }),
    ImportChunkConflictError,
  );
  await restarted.stagePostsChunk({ ...chunk, chunkIndex: 1, startIndex: 1, posts: [OTHER_POST] });
  await restarted.stageTagsChunk({
    sessionId: session.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    tags: value.tags,
  });
  await restarted.stageAuthorsChunk({
    sessionId: session.sessionId,
    chunkIndex: 0,
    startIndex: 0,
    authors: value.authors,
  });
  await restarted.finalizeReplace(session.sessionId);
  deepStrictEqual((await readLogicalState(indexedDB, harness.databaseName)).state.posts, [
    POST,
    OTHER_POST,
  ]);
});

test("POST-005 legacy sessions reject posts and references at staging and revalidate before atomic finalize", async () => {
  const harness = createHarness("legacy-reject-provenance");
  const before = { ...createInitialState(), posts: [POST], authors: [storedAuthor("old")] };
  await replaceLive(harness.repository, harness.databaseName, before);
  const value = transfer([author("legacy")]);
  const metadata = createBlacklistTransferFileMetadata(value, JSON.stringify(value).length - 31, 1);
  const session = await harness.repository.beginImport(metadata);
  const input = { sessionId: session.sessionId, chunkIndex: 0, startIndex: 0 };
  await rejects(
    harness.repository.stagePostsChunk({ ...input, posts: [POST] }),
    ImportChunkConflictError,
  );
  await rejects(
    harness.repository.stageAuthorsChunk({
      ...input,
      authors: [author("legacy", { sourcePostId: POST.postId })],
    }),
    ImportChunkConflictError,
  );
  await stageSingleChunkTransfer(harness.repository, session.sessionId, value);
  const database = await openBlacklistDatabase(indexedDB, harness.databaseName);
  try {
    const transaction = database.transaction(BLACKLIST_STORE_NAMES.importAuthors, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(BLACKLIST_STORE_NAMES.importAuthors);
    const staged = parseStoredImportAuthor(await requestResult(store.get([session.sessionId, 0])));
    if (!staged) throw new Error("Expected staged author");
    store.put({ ...staged, sourcePostId: POST.postId });
    await done;
  } finally {
    database.close();
  }
  await rejects(
    harness.repository.finalizeReplace(session.sessionId),
    IncompleteBlacklistImportError,
  );
  deepStrictEqual((await readLogicalState(indexedDB, harness.databaseName)).state, before);
  strictEqual((await harness.repository.inspectImport(session.sessionId))?.status, "ready");
});

test("POST-005 legacy format1 pipeline import writes null references and no posts", async () => {
  const value = transfer([author("legacy")]);
  const header = { ...value, posts: undefined };
  const json = JSON.stringify({
    ...header,
    formatVersion: 1,
    schemaVersion: 5,
    authors: value.authors.map((item) => ({ ...item, sourcePostId: undefined })),
  });
  const prepared = prepareBlacklistTransferJson(json);
  if (prepared.status !== "valid") throw new Error("Expected prepared legacy import");
  const harness = createHarness("legacy-posts");
  await runBlacklistImport({
    client: transferClient(harness.repository),
    prepared: prepared.prepared,
    mode: "replace",
    resumeSessionId: null,
  });
  const result = (await readLogicalState(indexedDB, harness.databaseName)).state;
  deepStrictEqual(result.authors, value.authors);
  deepStrictEqual(result.posts, []);
});
