import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  STORAGE_KEY,
  createInitialState,
  parseBlacklistState,
  planAuthorBatchRemoval,
  planAuthorRemoval,
  planAuthorRestoration,
  planTagDeletion,
  planTagRename,
  type BlacklistState,
} from "../content/blacklist-state.ts";
import {
  MAX_BLACKLIST_TRANSFER_BYTES,
  blacklistRpcJsonByteLength,
  createBlacklistRpcRequest,
  createBlacklistRpcResponse,
  parseBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistRpcOperation,
  type BlacklistRpcRequest,
  type BlacklistTransferEnvelope,
} from "../core/blacklist-rpc-contract.ts";
import { createBlacklistManagementController } from "./blacklist-management-controller.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";

const TIME = "2026-08-21T10:00:00.000Z";
const HASH = "a".repeat(32);

function author(
  userId: string,
  overrides: Partial<BlacklistState["authors"][number]> = {},
): BlacklistState["authors"][number] {
  return {
    platformId: "zhihu",
    userId,
    memberHashId: null,
    authorNameAtCapture: `Author ${userId}`,
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIME,
    blockSource: "direct",
    ...overrides,
  };
}

class MemoryStorage {
  value: unknown;
  readonly sets: unknown[] = [];
  readonly setPayloads: Record<string, unknown>[] = [];
  readonly separateValues: Record<string, unknown>;
  failGet = false;
  failGetAfter: number | null = null;
  failSet = false;
  getCalls = 0;

  constructor(value: unknown, separateValues: Record<string, unknown> = {}) {
    this.value = value;
    this.separateValues = { ...separateValues };
  }

  async get(key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    if (this.failGet || (this.failGetAfter !== null && this.getCalls > this.failGetAfter)) {
      throw new Error("get failed");
    }
    return this.value === undefined ? {} : { [key]: this.value };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error("set failed");
    this.setPayloads.push(items);
    this.sets.push(items[STORAGE_KEY]);
    this.value = items[STORAGE_KEY];
  }
}

function repositoryContext(storage: MemoryStorage, state: BlacklistState) {
  return {
    baseRevision: storage.sets.length,
    revision: storage.sets.length,
    authorCount: state.authors.length,
    tagCount: state.tags.length,
  };
}

class MemoryRepository implements BlacklistRepository {
  private readonly storage: MemoryStorage;

  constructor(storage: MemoryStorage) {
    this.storage = storage;
  }

  private async read(): Promise<BlacklistState> {
    const values = await this.storage.get(STORAGE_KEY);
    const parsed = parseBlacklistState(values[STORAGE_KEY]);
    if (parsed.status === "malformed") throw new Error("unreadable state");
    if (parsed.status === "missing" || parsed.status === "migrated") {
      await this.write(parsed.state);
    }
    return parsed.state;
  }

  private async write(state: BlacklistState): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: state });
  }

  async hydrate() {
    return { state: await this.read(), revision: this.storage.sets.length };
  }

  async removeAuthor(identity: Parameters<typeof planAuthorRemoval>[1]) {
    const state = await this.read();
    const plan = planAuthorRemoval(state, identity);
    if (plan.status !== "ready") {
      return {
        status: "missing" as const,
        removed: null,
        ...repositoryContext(this.storage, state),
      };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      removed: plan.removed,
      ...repositoryContext(this.storage, plan.state),
    };
  }

  async restoreAuthor(author: Parameters<typeof planAuthorRestoration>[1]) {
    const state = await this.read();
    const plan = planAuthorRestoration(state, author);
    if (plan.status !== "ready") {
      return { status: plan.status, ...repositoryContext(this.storage, state) };
    }
    await this.write(plan.state);
    return { status: "persisted" as const, ...repositoryContext(this.storage, plan.state) };
  }

  async removeAuthors(identities: Parameters<typeof planAuthorBatchRemoval>[1]) {
    const state = await this.read();
    const plan = planAuthorBatchRemoval(state, identities);
    if (plan.status !== "ready") {
      return {
        status: plan.status,
        removedCount: 0,
        ...repositoryContext(this.storage, state),
      };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      removedCount: plan.removedCount,
      ...repositoryContext(this.storage, plan.state),
    };
  }

  async renameTag(tagId: string, name: string) {
    const state = await this.read();
    const plan = planTagRename(state, tagId, name);
    if (plan.status !== "ready") {
      return { status: plan.status, tag: null, ...repositoryContext(this.storage, state) };
    }
    await this.write(plan.state);
    const tag = plan.state.tags.find((candidate) => candidate.tagId === tagId) ?? null;
    return {
      status: "persisted" as const,
      tag,
      ...repositoryContext(this.storage, plan.state),
    };
  }

  async deleteTag(tagId: string) {
    const state = await this.read();
    const plan = planTagDeletion(state, tagId);
    if (plan.status !== "ready") {
      return {
        status: plan.status,
        deletedTagId: null,
        ...repositoryContext(this.storage, state),
      };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      deletedTagId: tagId,
      ...repositoryContext(this.storage, plan.state),
    };
  }

  async replaceAll(state: BlacklistState) {
    await this.write(state);
    return { state, revision: this.storage.sets.length };
  }

  async commitAuthor(): Promise<never> {
    throw new Error("not used by management tests");
  }
  async backfillMemberHash(): Promise<never> {
    throw new Error("not used by management tests");
  }
  async commitUpvoter(): Promise<never> {
    throw new Error("not used by management tests");
  }
  async preflightDirect(): Promise<never> {
    throw new Error("not used by management tests");
  }
}

function createMemoryRepository(storage: MemoryStorage): BlacklistRepository {
  return new MemoryRepository(storage);
}

function createHarness(
  value: unknown,
  options: {
    readonly separateValues?: Record<string, unknown>;
    readonly beforeLock?: (storage: MemoryStorage) => void;
    readonly failLock?: boolean;
    readonly now?: () => Date;
  } = {},
) {
  const storage = new MemoryStorage(value, options.separateValues);
  let lockCalls = 0;
  const controller = createBlacklistManagementController(
    createMemoryRepository(storage),
    {
      async runExclusive(operation) {
        lockCalls += 1;
        options.beforeLock?.(storage);
        if (options.failLock) throw new Error("lock failed");
        return operation();
      },
    },
    {
      async query() {
        return { status: "unsupported", count: 0 };
      },
    },
    options.now,
  );
  return { storage, controller, lockCalls: () => lockCalls };
}

function request(
  operation: BlacklistRpcOperation,
  input: Record<string, unknown> = {},
): BlacklistRpcRequest {
  return createBlacklistRpcRequest(operation, input);
}

function dto(value: BlacklistState["authors"][number]): BlacklistAuthorDto {
  return {
    platformId: value.platformId,
    userId: value.userId,
    memberHashId: value.memberHashId,
    authorName: value.authorNameAtCapture,
    tagId: value.tagId,
    blacklistedAt: value.blacklistedAt,
    source: value.blockSource,
  };
}

function removeResponseBytes(
  state: BlacklistState,
  removed: BlacklistState["authors"][number] | null,
): number {
  const response = createBlacklistRpcResponse("remove-one", true, {
    snapshot: {
      authors: state.authors.map(dto),
      tags: state.tags.map((tag) => ({
        ...tag,
        isDefault: tag.tagId === DEFAULT_TAG_ID,
      })),
    },
    removed: removed ? dto(removed) : null,
  });
  return blacklistRpcJsonByteLength(response) ?? Number.POSITIVE_INFINITY;
}

function nearLimitRemovalState() {
  const removed = author("r".repeat(512), {
    authorNameAtCapture: "R".repeat(500),
    memberHashId: HASH,
  });
  const createState = (count: number): BlacklistState => ({
    ...createInitialState(),
    authors: Array.from({ length: count }, (_, index) =>
      author(`filler-${index}`, { authorNameAtCapture: "F".repeat(500) }),
    ),
  });
  let low = 0;
  let high = 20_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (removeResponseBytes(createState(middle), null) <= MAX_BLACKLIST_TRANSFER_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const candidate = createState(low);
  if (removeResponseBytes(candidate, removed) <= MAX_BLACKLIST_TRANSFER_BYTES) {
    throw new Error("Unable to construct the remove response boundary fixture.");
  }
  return {
    removed,
    before: { ...candidate, authors: [removed, ...candidate.authors] } satisfies BlacklistState,
  };
}

function transfer(
  authors: BlacklistTransferEnvelope["authors"] = [],
  tags: BlacklistTransferEnvelope["tags"] = [{ tagId: DEFAULT_TAG_ID, name: "default" }],
): BlacklistTransferEnvelope {
  return {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: TIME,
    schemaVersion: 5,
    authors,
    tags,
  };
}

function transferRequest(
  operation: "import-merge" | "import-replace",
  value: BlacklistTransferEnvelope,
): BlacklistRpcRequest {
  return createBlacklistRpcRequest(operation, { transfer: value });
}

test("POPUP-009 snapshot initializes missing schema v5 once and returns an exact contract", async () => {
  const harness = createHarness(undefined);
  const response = await harness.controller.handle(request("snapshot"));
  strictEqual(response.ok, true);
  deepStrictEqual(response.data.snapshot, {
    authors: [],
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default", isDefault: true }],
  });
  strictEqual(harness.storage.sets.length, 1);
  deepStrictEqual(harness.storage.value, createInitialState());
  strictEqual(harness.lockCalls(), 1);
  strictEqual(parseBlacklistRpcResponse(response, "snapshot"), response);
});

test("POPUP-009 malformed state remains read-only for every management mutation", async () => {
  const malformed = { schemaVersion: 4, tags: [], authors: [], extra: true };
  const harness = createHarness(malformed);
  const operations: readonly BlacklistRpcRequest[] = [
    request("snapshot"),
    request("remove-one", {
      identity: { platformId: "zhihu", userId: "one" },
    }),
    request("restore-one", { author: dto(author("one")) }),
    request("remove-many", {
      identities: [{ platformId: "zhihu", userId: "one" }],
    }),
    request("rename-tag", { tagId: "tag", name: "Name" }),
    request("delete-tag", { tagId: "tag" }),
  ];
  for (const operation of operations) {
    const response = await harness.controller.handle(operation);
    strictEqual(response.ok, false);
    strictEqual(response.error, "storage-unreadable");
    strictEqual(response.data.snapshot, null);
  }
  deepStrictEqual(harness.storage.value, malformed);
  deepStrictEqual(harness.storage.sets, []);
});

test("POPUP-005 remove and exact undo preserve records and reject concurrent overwrite", async () => {
  const original = author("one", {
    memberHashId: HASH,
    authorNameAtCapture: "Preserved",
    blacklistedAt: "2024-01-02T03:04:05.006Z",
    blockSource: "upvoter",
  });
  const state: BlacklistState = { ...createInitialState(), authors: [original] };
  const harness = createHarness(state);
  const removed = await harness.controller.handle(
    request("remove-one", {
      identity: { platformId: original.platformId, userId: original.userId },
    }),
  );
  strictEqual(removed.ok, true);
  deepStrictEqual(removed.data.removed, dto(original));
  strictEqual(harness.storage.sets.length, 1);

  const restored = await harness.controller.handle(
    request("restore-one", { author: removed.data.removed }),
  );
  strictEqual(restored.ok, true);
  deepStrictEqual(harness.storage.value, state);
  strictEqual(harness.storage.sets.length, 2);

  const conflict = await harness.controller.handle(
    request("restore-one", { author: dto(original) }),
  );
  strictEqual(conflict.ok, false);
  strictEqual(conflict.error, "conflict");
  strictEqual(harness.storage.sets.length, 2);
  deepStrictEqual(harness.storage.value, state);
});

test("POPUP-005 undo rejects a concurrently deleted tag without writing", async () => {
  const original = author("one", { tagId: "later-deleted" });
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "later-deleted", name: "Later" }],
    authors: [],
  };
  const harness = createHarness(state);
  const response = await harness.controller.handle(
    request("restore-one", { author: dto(original) }),
  );
  strictEqual(response.ok, true);
  harness.storage.value = createInitialState();
  const conflict = await harness.controller.handle(
    request("restore-one", { author: dto(author("two", { tagId: "later-deleted" })) }),
  );
  strictEqual(conflict.ok, false);
  strictEqual(conflict.error, "invalid-tag");
  strictEqual(harness.storage.sets.length, 1);
});

test("MANAGE-001 remove-many is all-or-nothing and performs one storage set", async () => {
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [author("one"), author("two"), author("three")],
  };
  const missingHarness = createHarness(state);
  const rejected = await missingHarness.controller.handle(
    request("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "one" },
        { platformId: "zhihu", userId: "missing" },
      ],
    }),
  );
  strictEqual(rejected.ok, false);
  strictEqual(rejected.error, "not-found");
  deepStrictEqual(missingHarness.storage.value, state);
  strictEqual(missingHarness.storage.sets.length, 0);

  const harness = createHarness(state);
  const response = await harness.controller.handle(
    request("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "one" },
        { platformId: "zhihu", userId: "three" },
      ],
    }),
  );
  strictEqual(response.ok, true);
  strictEqual(harness.storage.sets.length, 1);
  deepStrictEqual((harness.storage.value as BlacklistState).authors, [state.authors[1]]);
});

test("MANAGE-002 rename and delete use latest state and preserve author fields", async () => {
  const tagged = author("one", { tagId: "reading", memberHashId: HASH });
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "reading", name: "Reading" },
      { tagId: "work", name: "Work" },
    ],
    authors: [tagged],
  };
  const harness = createHarness(state);
  const duplicate = await harness.controller.handle(
    request("rename-tag", { tagId: "reading", name: " work " }),
  );
  strictEqual(duplicate.ok, false);
  strictEqual(duplicate.error, "invalid-tag");
  strictEqual(harness.storage.sets.length, 0);

  const renamed = await harness.controller.handle(
    request("rename-tag", { tagId: "reading", name: " Personal " }),
  );
  strictEqual(renamed.ok, true);
  strictEqual(harness.storage.sets.length, 1);
  deepStrictEqual(renamed.data.snapshot?.authors[0], dto(tagged));

  const deleted = await harness.controller.handle(request("delete-tag", { tagId: "reading" }));
  strictEqual(deleted.ok, true);
  strictEqual(harness.storage.sets.length, 2);
  deepStrictEqual(deleted.data.snapshot?.authors[0], {
    ...dto(tagged),
    tagId: DEFAULT_TAG_ID,
  });
  strictEqual(
    deleted.data.snapshot?.tags.some(({ tagId }) => tagId === "reading"),
    false,
  );

  for (const operation of [
    request("rename-tag", { tagId: DEFAULT_TAG_ID, name: "Other" }),
    request("delete-tag", { tagId: DEFAULT_TAG_ID }),
  ]) {
    const protectedResponse = await harness.controller.handle(operation);
    strictEqual(protectedResponse.ok, false);
    strictEqual(protectedResponse.error, "invalid-tag");
  }
  strictEqual(harness.storage.sets.length, 2);
});

test("MANAGE-001 save failure returns the latest rollback snapshot without changing storage", async () => {
  const state: BlacklistState = { ...createInitialState(), authors: [author("one")] };
  const harness = createHarness(state);
  harness.storage.failSet = true;
  const response = await harness.controller.handle(
    request("remove-one", {
      identity: { platformId: "zhihu", userId: "one" },
    }),
  );
  strictEqual(response.ok, false);
  strictEqual(response.error, "save-failed");
  strictEqual(response.data.snapshot?.authors.length, 1);
  deepStrictEqual(harness.storage.value, state);
  deepStrictEqual(harness.storage.sets, []);
});

test("AC-095 committed removal stays successful without a post-commit snapshot read", async () => {
  const state: BlacklistState = { ...createInitialState(), authors: [author("one")] };
  const harness = createHarness(state);
  harness.storage.failGetAfter = 2;

  const response = await harness.controller.handle(
    request("remove-one", {
      identity: { platformId: "zhihu", userId: "one" },
    }),
  );

  strictEqual(response.ok, true);
  strictEqual(response.data.removed?.userId, "one");
  strictEqual(response.data.snapshot?.authors.length, 0);
  strictEqual(harness.storage.getCalls, 2);
  strictEqual((harness.storage.value as BlacklistState).authors.length, 0);
});

test("AC-095 oversized exact remove response is rejected before persistence", async () => {
  const { before, removed } = nearLimitRemovalState();
  const harness = createHarness(before);

  const response = await harness.controller.handle(
    request("remove-one", {
      identity: { platformId: removed.platformId, userId: removed.userId },
    }),
  );

  strictEqual(response.ok, false);
  strictEqual(response.error, "storage-unreadable");
  deepStrictEqual(harness.storage.sets, []);
  strictEqual((harness.storage.value as BlacklistState).authors.length, before.authors.length);
});

test("AC-089 locked export re-reads latest state, emits exact data, and does not write valid storage", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [author("stale")],
  };
  const latest: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "work", name: "Work" }],
    authors: [
      author("latest", { tagId: "work", memberHashId: HASH }),
      author("same-id", { platformId: "youtube" }),
    ],
  };
  const harness = createHarness(initial, {
    beforeLock(storage) {
      storage.value = latest;
    },
    now: () => new Date(TIME),
  });

  const response = await harness.controller.handle(request("export-json"));

  strictEqual(response.ok, true);
  deepStrictEqual(response.data.transfer, transfer(latest.authors, latest.tags));
  deepStrictEqual(harness.storage.sets, []);
  strictEqual(harness.lockCalls(), 1);
});

test("AC-089 export initializes migrated storage in one write but failures produce zero writes", async () => {
  const migrated = {
    schemaVersion: 4,
    tags: [{ tagId: "default", name: "default" }],
    authors: [
      {
        userId: "legacy",
        memberHashId: null,
        authorNameAtCapture: "Legacy",
        tagId: "default",
        blacklistedAt: TIME,
        blockSource: "direct",
      },
    ],
  };
  const success = createHarness(migrated, { now: () => new Date(TIME) });
  const exported = await success.controller.handle(request("export-json"));
  strictEqual(exported.ok, true);
  strictEqual(success.storage.sets.length, 1);
  strictEqual((success.storage.value as BlacklistState).authors[0]?.platformId, "zhihu");

  for (const harness of [
    createHarness({ ...migrated, extra: true }),
    createHarness(createInitialState(), { failLock: true }),
    createHarness(createInitialState(), { now: () => new Date(Number.NaN) }),
  ]) {
    const response = await harness.controller.handle(request("export-json"));
    strictEqual(response.ok, false);
    deepStrictEqual(harness.storage.sets, []);
  }
});

test("AC-089 merge re-reads under lock, writes once atomically, and keeps local duplicate records exact", async () => {
  const preserved = author("same", {
    authorNameAtCapture: "Preserved",
    blacklistedAt: "2020-01-02T03:04:05.006Z",
    blockSource: "upvoter",
  });
  const latest: BlacklistState = {
    ...createInitialState(),
    authors: [preserved, author("concurrent")],
  };
  const imported = transfer([
    author("same", { authorNameAtCapture: "Imported" }),
    author("new", { platformId: "youtube" }),
  ]);
  const harness = createHarness(createInitialState(), {
    beforeLock(storage) {
      storage.value = latest;
    },
  });

  const response = await harness.controller.handle(transferRequest("import-merge", imported));

  strictEqual(response.ok, true);
  strictEqual(harness.storage.sets.length, 1);
  deepStrictEqual((harness.storage.value as BlacklistState).authors, [
    preserved,
    latest.authors[1],
    imported.authors[1],
  ]);
  deepStrictEqual(
    response.data.snapshot?.authors.map(({ platformId, userId }) => ({
      platformId,
      userId,
    })),
    [
      { platformId: "zhihu", userId: "same" },
      { platformId: "zhihu", userId: "concurrent" },
      { platformId: "youtube", userId: "new" },
    ],
  );
});

test("AC-089 unchanged merge performs zero writes while migrated merge persists exactly once", async () => {
  const existing: BlacklistState = {
    ...createInitialState(),
    authors: [author("same")],
  };
  const unchanged = createHarness(existing);
  const unchangedResponse = await unchanged.controller.handle(
    transferRequest("import-merge", transfer([author("same")])),
  );
  strictEqual(unchangedResponse.ok, true);
  deepStrictEqual(unchanged.storage.sets, []);

  const migrated = createHarness({
    schemaVersion: 4,
    tags: [{ tagId: "default", name: "default" }],
    authors: [],
  });
  const migratedResponse = await migrated.controller.handle(
    transferRequest("import-merge", transfer()),
  );
  strictEqual(migratedResponse.ok, true);
  strictEqual(migrated.storage.sets.length, 1);
  deepStrictEqual(migrated.storage.value, createInitialState());
});

test("AC-089 replace reports exact counts, writes once, and touches only blacklist state", async () => {
  const settings = { cocoonRemotePreferences: { schemaVersion: 1, enabled: true } };
  const harness = createHarness(
    { ...createInitialState(), authors: [author("old")] },
    { separateValues: settings },
  );
  const imported = transfer(
    [
      author("same", { platformId: "zhihu", tagId: "work" }),
      author("same", { platformId: "youtube" }),
    ],
    [
      { tagId: "default", name: "default" },
      { tagId: "work", name: "Work" },
    ],
  );

  const response = await harness.controller.handle(transferRequest("import-replace", imported));

  strictEqual(response.ok, true);
  strictEqual(response.data.snapshot?.authors.length, 2);
  strictEqual(response.data.snapshot?.tags.length, 2);
  strictEqual(harness.storage.setPayloads.length, 1);
  deepStrictEqual(Object.keys(harness.storage.setPayloads[0] ?? {}), [STORAGE_KEY]);
  deepStrictEqual(harness.storage.separateValues, settings);
  deepStrictEqual(harness.storage.value, {
    schemaVersion: 5,
    authors: imported.authors,
    tags: imported.tags,
  });
});

test("AC-089 invalid, conflict, unreadable, lock, and write failures produce zero successful writes", async () => {
  const conflictState: BlacklistState = {
    ...createInitialState(),
    authors: [author("owner", { memberHashId: HASH })],
  };
  const conflict = createHarness(conflictState);
  const conflictResponse = await conflict.controller.handle(
    transferRequest("import-merge", transfer([author(HASH)])),
  );
  strictEqual(conflictResponse.ok, false);
  strictEqual(conflictResponse.error, "transfer-conflict");
  deepStrictEqual(conflict.storage.sets, []);

  const malformed = createHarness({ ...createInitialState(), extra: true });
  const malformedResponse = await malformed.controller.handle(
    transferRequest("import-replace", transfer()),
  );
  strictEqual(malformedResponse.ok, false);
  strictEqual(malformedResponse.error, "storage-unreadable");
  deepStrictEqual(malformed.storage.sets, []);

  const lockFailure = createHarness(createInitialState(), { failLock: true });
  const lockResponse = await lockFailure.controller.handle(
    transferRequest("import-replace", transfer()),
  );
  strictEqual(lockResponse.ok, false);
  strictEqual(lockResponse.error, "storage-unreadable");
  deepStrictEqual(lockFailure.storage.sets, []);

  const writeFailure = createHarness(createInitialState());
  writeFailure.storage.failSet = true;
  const writeResponse = await writeFailure.controller.handle(
    transferRequest("import-replace", transfer([author("new")])),
  );
  strictEqual(writeResponse.ok, false);
  strictEqual(writeResponse.error, "save-failed");
  deepStrictEqual(writeFailure.storage.sets, []);

  const invalidTransfer = {
    ...transfer(),
    product: "invalid",
  } as unknown as BlacklistTransferEnvelope;
  const invalid = createHarness(createInitialState());
  const invalidResponse = await invalid.controller.handle(
    transferRequest("import-replace", invalidTransfer),
  );
  strictEqual(invalidResponse.ok, false);
  strictEqual(invalidResponse.error, "invalid-transfer");
  strictEqual(invalid.lockCalls(), 0);
  deepStrictEqual(invalid.storage.sets, []);
});
