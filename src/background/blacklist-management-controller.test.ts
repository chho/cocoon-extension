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
  createBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistRpcOperation,
  type BlacklistRpcRequest,
} from "../core/blacklist-rpc-contract.ts";
import { createBlacklistManagementController } from "./blacklist-management-controller.ts";
import type { BlacklistRepository, MutationContext } from "./blacklist-repository-types.ts";

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

class MemoryStorage {
  value: unknown;
  readonly sets: unknown[] = [];
  failGet = false;
  failGetAfter: number | null = null;
  failSet = false;
  getCalls = 0;

  constructor(value: unknown) {
    this.value = value;
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
    this.sets.push(items[STORAGE_KEY]);
    this.value = items[STORAGE_KEY];
  }
}

function mutationContext(
  storage: MemoryStorage,
  state: BlacklistState,
  baseRevision: number,
): MutationContext {
  return {
    baseRevision,
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
    if (parsed.status === "missing" || parsed.status === "migrated") await this.write(parsed.state);
    return parsed.state;
  }

  private async write(state: BlacklistState): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: state });
  }

  async querySummary() {
    const state = await this.read();
    return {
      revision: this.storage.sets.length,
      authorCount: state.authors.length,
      tagCount: state.tags.length,
    };
  }

  async queryAuthorsPage(): Promise<never> {
    throw new Error("not used by management tests");
  }

  async queryTagsPage(): Promise<never> {
    throw new Error("not used by management tests");
  }

  async queryPlatformsPage(): Promise<never> {
    throw new Error("not used by management tests");
  }

  async queryIdentityMatches(): Promise<never> {
    throw new Error("not used by management tests");
  }

  async removeAuthor(identity: Parameters<typeof planAuthorRemoval>[1]) {
    const state = await this.read();
    const baseRevision = this.storage.sets.length;
    const plan = planAuthorRemoval(state, identity);
    if (plan.status !== "ready") {
      return {
        status: "missing" as const,
        removed: null,
        ...mutationContext(this.storage, state, baseRevision),
      };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      removed: plan.removed,
      ...mutationContext(this.storage, plan.state, baseRevision),
    };
  }

  async restoreAuthor(value: Parameters<typeof planAuthorRestoration>[1]) {
    const state = await this.read();
    const baseRevision = this.storage.sets.length;
    const plan = planAuthorRestoration(state, value);
    if (plan.status !== "ready") {
      return { status: plan.status, ...mutationContext(this.storage, state, baseRevision) };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      ...mutationContext(this.storage, plan.state, baseRevision),
    };
  }

  async removeAuthors(identities: Parameters<typeof planAuthorBatchRemoval>[1]) {
    const state = await this.read();
    const baseRevision = this.storage.sets.length;
    const plan = planAuthorBatchRemoval(state, identities);
    if (plan.status !== "ready") {
      return {
        status: plan.status,
        removedCount: 0,
        ...mutationContext(this.storage, state, baseRevision),
      };
    }
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      removedCount: plan.removedCount,
      ...mutationContext(this.storage, plan.state, baseRevision),
    };
  }

  async renameTag(tagId: string, name: string) {
    const state = await this.read();
    const baseRevision = this.storage.sets.length;
    const plan = planTagRename(state, tagId, name);
    if (plan.status !== "ready" && plan.status !== "unchanged") {
      return {
        status: plan.status,
        tag: null,
        ...mutationContext(this.storage, state, baseRevision),
      };
    }
    if (plan.status === "ready") await this.write(plan.state);
    return {
      status: plan.status === "ready" ? ("persisted" as const) : plan.status,
      tag: plan.state.tags.find((candidate) => candidate.tagId === tagId) ?? null,
      ...mutationContext(this.storage, plan.state, baseRevision),
    };
  }

  async deleteTag(tagId: string) {
    const state = await this.read();
    const baseRevision = this.storage.sets.length;
    const plan = planTagDeletion(state, tagId);
    if (plan.status !== "ready") {
      return {
        status: plan.status,
        deletedTagId: null,
        migratedCount: 0,
        ...mutationContext(this.storage, state, baseRevision),
      };
    }
    const migratedCount = state.authors.filter((item) => item.tagId === tagId).length;
    await this.write(plan.state);
    return {
      status: "persisted" as const,
      deletedTagId: tagId,
      migratedCount,
      ...mutationContext(this.storage, plan.state, baseRevision),
    };
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

function createHarness(
  value: unknown,
  options: {
    readonly beforeLock?: (storage: MemoryStorage) => void;
    readonly failLock?: boolean;
    readonly statusFailure?: boolean;
  } = {},
) {
  const storage = new MemoryStorage(value);
  let lockCalls = 0;
  const repository = new MemoryRepository(storage);
  const controller = createBlacklistManagementController(
    repository,
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
        if (options.statusFailure) throw new Error("status failed");
        return { status: "unsupported", count: 0 };
      },
    },
  );
  return { storage, controller, lockCalls: () => lockCalls };
}

function request(
  operation: BlacklistRpcOperation,
  input: Record<string, unknown> = {},
): BlacklistRpcRequest {
  return createBlacklistRpcRequest(operation, input);
}

test("POPUP-009 status bypasses the mutation lock and fails closed as connection-error", async () => {
  const success = createHarness(createInitialState());
  const response = await success.controller.handle(request("status"));
  strictEqual(parseBlacklistRpcResponse(response, "status"), response);
  strictEqual(response.data.status, "unsupported");
  strictEqual(response.data.count, 0);
  strictEqual(success.lockCalls(), 0);

  const failure = createHarness(createInitialState(), { statusFailure: true });
  const failed = await failure.controller.handle(request("status"));
  strictEqual(failed.ok, true);
  strictEqual(failed.data.status, "connection-error");
  strictEqual(failed.data.count, 0);
});

test("POPUP-009 malformed state remains read-only for every management mutation", async () => {
  const malformed = { schemaVersion: 5, tags: [], authors: [], extra: true };
  const operations: readonly BlacklistRpcRequest[] = [
    request("remove-one", { identity: { platformId: "zhihu", userId: "one" } }),
    request("restore-one", { author: dto(author("one")) }),
    request("remove-many", { identities: [{ platformId: "zhihu", userId: "one" }] }),
    request("rename-tag", { tagId: "tag", name: "Name" }),
    request("delete-tag", { tagId: "tag" }),
  ];
  for (const operation of operations) {
    const harness = createHarness(malformed);
    const response = await harness.controller.handle(operation);
    strictEqual(response.ok, false);
    strictEqual(response.error, "storage-unreadable");
    deepStrictEqual(harness.storage.value, malformed);
    deepStrictEqual(harness.storage.sets, []);
  }
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
  deepStrictEqual(
    {
      revision: removed.data.revision,
      authorCount: removed.data.authorCount,
      tagCount: removed.data.tagCount,
    },
    { revision: 1, authorCount: 0, tagCount: 1 },
  );

  const restored = await harness.controller.handle(
    request("restore-one", { author: removed.data.removed }),
  );
  strictEqual(restored.ok, true);
  deepStrictEqual(harness.storage.value, state);
  strictEqual(restored.data.revision, 2);
  strictEqual(restored.data.authorCount, 1);

  const conflict = await harness.controller.handle(
    request("restore-one", { author: dto(original) }),
  );
  strictEqual(conflict.ok, false);
  strictEqual(conflict.error, "conflict");
  strictEqual(harness.storage.sets.length, 2);
});

test("POPUP-005 undo rejects a concurrently deleted tag without writing", async () => {
  const original = author("one", { tagId: "later-deleted" });
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "later-deleted", name: "Later" }],
    authors: [],
  };
  const harness = createHarness(state);
  const restored = await harness.controller.handle(
    request("restore-one", { author: dto(original) }),
  );
  strictEqual(restored.ok, true);
  harness.storage.value = createInitialState();

  const conflict = await harness.controller.handle(
    request("restore-one", { author: dto(author("two", { tagId: "later-deleted" })) }),
  );
  strictEqual(conflict.ok, false);
  strictEqual(conflict.error, "invalid-tag");
  strictEqual(harness.storage.sets.length, 1);
});

test("MANAGE-001 remove-many is atomic and returns only its count delta", async () => {
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [author("one"), author("two"), author("three")],
  };
  const missing = createHarness(state);
  const rejected = await missing.controller.handle(
    request("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "one" },
        { platformId: "zhihu", userId: "missing" },
      ],
    }),
  );
  strictEqual(rejected.ok, false);
  strictEqual(rejected.error, "not-found");
  deepStrictEqual(missing.storage.value, state);
  deepStrictEqual(missing.storage.sets, []);

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
  strictEqual(response.data.removedCount, 2);
  strictEqual(response.data.authorCount, 1);
  deepStrictEqual((harness.storage.value as BlacklistState).authors, [state.authors[1]]);
});

test("MANAGE-002 rename and delete return deltas and preserve migrated author fields", async () => {
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

  const renamed = await harness.controller.handle(
    request("rename-tag", { tagId: "reading", name: " Personal " }),
  );
  strictEqual(renamed.ok, true);
  deepStrictEqual(renamed.data.tag, {
    tagId: "reading",
    name: "Personal",
    isDefault: false,
  });

  const deleted = await harness.controller.handle(request("delete-tag", { tagId: "reading" }));
  strictEqual(deleted.ok, true);
  strictEqual(deleted.data.deletedTagId, "reading");
  strictEqual(deleted.data.migratedCount, 1);
  const latest = harness.storage.value as BlacklistState;
  deepStrictEqual(latest.authors[0], { ...tagged, tagId: DEFAULT_TAG_ID });
  strictEqual(
    latest.tags.some(({ tagId }) => tagId === "reading"),
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
});

test("MANAGE-001 save, lock, and pre-mutation read failures leave state unchanged", async () => {
  const state: BlacklistState = { ...createInitialState(), authors: [author("one")] };
  const saveFailure = createHarness(state);
  saveFailure.storage.failSet = true;
  const failedSave = await saveFailure.controller.handle(
    request("remove-one", { identity: { platformId: "zhihu", userId: "one" } }),
  );
  strictEqual(failedSave.ok, false);
  strictEqual(failedSave.error, "save-failed");
  deepStrictEqual(saveFailure.storage.value, state);

  const readFailure = createHarness(state);
  readFailure.storage.failGet = true;
  const failedRead = await readFailure.controller.handle(
    request("remove-one", { identity: { platformId: "zhihu", userId: "one" } }),
  );
  strictEqual(failedRead.error, "storage-unreadable");
  deepStrictEqual(readFailure.storage.value, state);

  const lockFailure = createHarness(state, { failLock: true });
  const failedLock = await lockFailure.controller.handle(
    request("remove-one", { identity: { platformId: "zhihu", userId: "one" } }),
  );
  strictEqual(failedLock.error, "storage-unreadable");
  deepStrictEqual(lockFailure.storage.value, state);
});

test("AC-095 committed removal succeeds without a post-commit full-state read", async () => {
  const state: BlacklistState = { ...createInitialState(), authors: [author("one")] };
  const harness = createHarness(state);
  harness.storage.failGetAfter = 2;

  const response = await harness.controller.handle(
    request("remove-one", { identity: { platformId: "zhihu", userId: "one" } }),
  );

  strictEqual(response.ok, true);
  strictEqual(response.data.removed?.userId, "one");
  strictEqual(response.data.revision, 1);
  strictEqual(response.data.authorCount, 0);
  strictEqual(response.data.tagCount, 1);
  strictEqual(harness.storage.getCalls, 2);
});
