import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { AuthorMutationResult } from "../background/blacklist-repository-types.ts";
import {
  createInitialState,
  isValidBlacklistTimestamp,
  planTagDeletion,
  planUpvoterCommit,
  type BlacklistState,
  type UpvoterCommitInput,
} from "./blacklist-state.ts";
import {
  createRemoteBlockCoordinator,
  stableRemoteBlockHash32,
  type CrossContextTryLockResult,
} from "./remote-block-coordinator.ts";
import type { RemoteBlockResult } from "./zhihu-remote-api.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";
const STORAGE_LOCK_NAME = "test-blacklist-storage";

function createSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createNamedExclusiveLockManager() {
  const tails = new Map<string, Promise<void>>();
  const requestedNames: string[] = [];
  const requestWaiters: Array<{
    readonly name: string;
    readonly count: number;
    readonly resolve: () => void;
  }> = [];

  function requestCount(name: string): number {
    return requestedNames.filter((requested) => requested === name).length;
  }

  function notifyRequestWaiters(): void {
    for (let index = requestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = requestWaiters[index];
      if (requestCount(waiter.name) >= waiter.count) {
        requestWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  return {
    requestedNames,
    async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
      requestedNames.push(name);
      notifyRequestWaiters();
      const previous = tails.get(name) ?? Promise.resolve();
      const release = createSignal();
      const tail = (async () => {
        await previous;
        await release.promise;
      })();
      tails.set(name, tail);
      await previous;
      try {
        return await operation();
      } finally {
        release.resolve();
        if (tails.get(name) === tail) {
          tails.delete(name);
        }
      }
    },
    async tryWithLock<T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<CrossContextTryLockResult<T>> {
      requestedNames.push(name);
      notifyRequestWaiters();
      if (tails.has(name)) {
        return { acquired: false };
      }

      const release = createSignal();
      tails.set(name, release.promise);
      try {
        return { acquired: true, value: await operation() };
      } finally {
        release.resolve();
        if (tails.get(name) === release.promise) {
          tails.delete(name);
        }
      }
    },
    async waitForRequestCount(name: string, count: number): Promise<void> {
      if (requestCount(name) >= count) {
        return;
      }
      await new Promise<void>((resolve) => {
        requestWaiters.push({ name, count, resolve });
      });
    },
  };
}

function directAuthor(userId: string, tagId = "default") {
  return {
    platformId: "zhihu",
    userId,
    memberHashId: null,
    authorNameAtCapture: `Direct ${userId}`,
    tagId,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct" as const,
  };
}

interface HarnessOptions {
  readonly blockResult?: RemoteBlockResult;
  readonly blockUser?: (userId: string, isStopped: () => boolean) => Promise<RemoteBlockResult>;
  readonly failRead?: boolean;
  readonly failSlotLock?: boolean;
  readonly failStorageLock?: boolean;
  readonly failTryLock?: boolean;
  readonly failWrite?: boolean;
  readonly failWriteAttempts?: number;
  readonly holdFirstRead?: boolean;
  readonly holdWrite?: boolean;
}

class TargetedStorageHarness {
  stored: BlacklistState;
  runtime: BlacklistState;
  posts = 0;
  reads = 0;
  writes = 0;
  applies = 0;
  storageFailures = 0;
  readonly readStarted = createSignal();
  readonly releaseRead = createSignal();
  readonly writeStarted = createSignal();
  readonly releaseWrite = createSignal();
  readonly options: HarnessOptions;
  readonly lockManager: ReturnType<typeof createNamedExclusiveLockManager>;

  constructor(
    initialState: BlacklistState,
    options: HarnessOptions,
    lockManager: ReturnType<typeof createNamedExclusiveLockManager>,
  ) {
    this.stored = initialState;
    this.runtime = initialState;
    this.options = options;
    this.lockManager = lockManager;
  }

  private async beginRead(): Promise<void> {
    this.reads += 1;
    if (this.options.holdFirstRead && this.reads === 1) {
      this.readStarted.resolve();
      await this.releaseRead.promise;
    }
    if (this.options.failRead) throw new Error("The storage read failed.");
  }

  private async write(state: BlacklistState): Promise<void> {
    this.writes += 1;
    if (this.options.holdWrite) {
      this.writeStarted.resolve();
      await this.releaseWrite.promise;
    }
    if (this.options.failWrite || this.writes <= (this.options.failWriteAttempts ?? 0)) {
      throw new Error("storage unavailable");
    }
    this.stored = state;
    this.applies += 1;
    this.runtime = state;
  }

  async preflightDirect(userId: string, expectedBlacklistedAt: string) {
    if (this.options.failStorageLock) throw new Error("The storage lock API failed.");
    return this.lockManager.withLock(STORAGE_LOCK_NAME, async () => {
      await this.beginRead();
      const existing = this.stored.authors.some(
        (author) =>
          author.platformId === "zhihu" &&
          author.userId === userId &&
          author.blockSource === "direct" &&
          author.blacklistedAt === expectedBlacklistedAt,
      );
      return { status: existing ? ("ready" as const) : ("existing" as const) };
    });
  }

  async commitUpvoter(input: UpvoterCommitInput) {
    if (this.options.failStorageLock) throw new Error("The storage lock API failed.");
    return this.lockManager.withLock(STORAGE_LOCK_NAME, async () => {
      await this.beginRead();
      const selectedTagId = this.stored.tags.some((tag) => tag.tagId === input.tagId)
        ? input.tagId
        : "default";
      const plan = planUpvoterCommit(this.stored, { ...input, tagId: selectedTagId });
      if (plan.status !== "ready") {
        const status = plan.status === "duplicate" ? "duplicate" : "invalid";
        return this.unchangedResult(status, input);
      }
      const baseRevision = this.writes;
      await this.write(plan.state);
      return {
        status: "persisted" as const,
        author: plan.state.authors.at(-1)!,
        tag: null,
        baseRevision,
        revision: this.writes,
        authorCount: plan.state.authors.length,
        tagCount: plan.state.tags.length,
      };
    });
  }

  private unchangedResult(
    status: "invalid" | "duplicate",
    input: UpvoterCommitInput,
  ): AuthorMutationResult {
    const details = {
      tag: null,
      baseRevision: this.writes,
      revision: this.writes,
      authorCount: this.stored.authors.length,
      tagCount: this.stored.tags.length,
    } as const;
    if (status === "invalid") return { status, author: null, ...details };
    const author = this.stored.authors.find(
      (candidate) =>
        candidate.platformId === input.platformId &&
        (candidate.userId === input.userId || candidate.memberHashId === input.userId),
    );
    if (!author) throw new Error("Expected the duplicate author to exist.");
    return { status, author, ...details };
  }
}

function createHarness(initialState: BlacklistState, options: HarnessOptions = {}) {
  const lockManager = createNamedExclusiveLockManager();
  const storage = new TargetedStorageHarness(initialState, options, lockManager);
  const dependencies = {
    async withCrossContextLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
      if (options.failSlotLock) throw new Error("The remote slot lock API failed.");
      return lockManager.withLock(name, operation);
    },
    async tryWithCrossContextUserLock<T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<CrossContextTryLockResult<T>> {
      if (options.failTryLock) throw new Error("The user lock API failed.");
      return lockManager.tryWithLock(name, operation);
    },
    preflightDirect: storage.preflightDirect.bind(storage),
    commitUpvoter: storage.commitUpvoter.bind(storage),
    now: () => new Date(TIMESTAMP),
    async blockUser(userId: string, isStopped: () => boolean) {
      storage.posts += 1;
      return (
        options.blockUser?.(userId, isStopped) ??
        options.blockResult ?? {
          status: "success" as const,
          endpoint: "primary" as const,
        }
      );
    },
    reportStorageFailure() {
      storage.storageFailures += 1;
    },
  };
  const coordinator = createRemoteBlockCoordinator(dependencies);
  return {
    coordinator,
    createCoordinator: () => createRemoteBlockCoordinator(dependencies),
    lockManager,
    state: () => storage.stored,
    runtime: () => storage.runtime,
    counts: () => ({
      posts: storage.posts,
      writes: storage.writes,
      applies: storage.applies,
      storageFailures: storage.storageFailures,
    }),
    readStarted: storage.readStarted.promise,
    releaseRead: storage.releaseRead.resolve,
    writeStarted: storage.writeStarted.promise,
    releaseWrite: storage.releaseWrite.resolve,
    replaceState(state: BlacklistState) {
      storage.stored = state;
      storage.runtime = state;
    },
  };
}

function upvoterRequest(userId = "voter-user") {
  return {
    source: "upvoter" as const,
    platformId: "zhihu",
    userId,
    authorName: `Voter ${userId}`,
    tagId: "default",
  };
}

function userIdsBySlot(countPerSlot: number): readonly string[][] {
  const slots: string[][] = Array.from({ length: 3 }, () => []);
  for (let candidate = 0; slots.some((users) => users.length < countPerSlot); candidate += 1) {
    const userId = `slot-user-${candidate}`;
    const slot = stableRemoteBlockHash32(userId) % 3;
    if (slots[slot].length < countPerSlot) {
      slots[slot].push(userId);
    }
  }
  return slots;
}

test("VOTER-014 upvoter persistence performs zero blockUser calls and writes a v5 Zhihu record", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "chosen", name: "Chosen" }],
  };
  const harness = createHarness(initial);

  const result = await harness.coordinator.block({
    ...upvoterRequest(),
    tagId: "chosen",
  });

  deepStrictEqual(result, { status: "success", persistedUpvoter: true });
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 1,
    applies: 1,
    storageFailures: 0,
  });
  deepStrictEqual(harness.state().authors, [
    {
      platformId: "zhihu",
      userId: "voter-user",
      memberHashId: null,
      authorNameAtCapture: "Voter voter-user",
      tagId: "chosen",
      blacklistedAt: TIMESTAMP,
      blockSource: "upvoter",
    },
  ]);
  strictEqual(harness.state().schemaVersion, 5);
  strictEqual(isValidBlacklistTimestamp(harness.state().authors[0]?.blacklistedAt), true);
  strictEqual(harness.runtime(), harness.state());
  strictEqual(
    harness.lockManager.requestedNames.some(
      (name) =>
        name.startsWith("cocoon-remote-block-slot-") ||
        name.startsWith("cocoon-remote-block-user-"),
    ),
    false,
  );
});

test("REMOTE-002 direct requests retain the remote POST path without local writes", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("direct-user")],
  };
  const harness = createHarness(initial);

  const result = await harness.coordinator.block({
    source: "direct",
    userId: "direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  });

  deepStrictEqual(result, { status: "success", persistedUpvoter: false });
  deepStrictEqual(harness.counts(), {
    posts: 1,
    writes: 0,
    applies: 0,
    storageFailures: 0,
  });
  strictEqual(
    harness.lockManager.requestedNames.some((name) => name.startsWith("cocoon-remote-block-slot-")),
    true,
  );
});

test("PLATFORM-001 a non-Zhihu record never authorizes a Zhihu remote POST", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [
      {
        ...directAuthor("shared-user"),
        platformId: "youtube",
      },
    ],
  };
  const harness = createHarness(initial);

  const result = await harness.coordinator.block({
    source: "direct",
    userId: "shared-user",
    expectedBlacklistedAt: TIMESTAMP,
  });

  deepStrictEqual(result, { status: "skipped", reason: "existing" });
  strictEqual(harness.counts().posts, 0);
  strictEqual(harness.counts().writes, 0);
  deepStrictEqual(harness.state(), initial);
});

test("PLATFORM-001 a cross-platform same ID does not suppress a new Zhihu upvoter record", async () => {
  const youtube = {
    ...directAuthor("shared-user"),
    platformId: "youtube",
  };
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [youtube],
  };
  const harness = createHarness(initial);

  const result = await harness.coordinator.block(upvoterRequest("shared-user"));

  deepStrictEqual(result, { status: "success", persistedUpvoter: true });
  deepStrictEqual(
    harness.state().authors.map(({ platformId, userId }) => ({
      platformId,
      userId,
    })),
    [
      { platformId: "youtube", userId: "shared-user" },
      { platformId: "zhihu", userId: "shared-user" },
    ],
  );
  strictEqual(harness.counts().posts, 0);
  strictEqual(harness.counts().writes, 1);
});

test("VOTER-014 falls back to default when the selected tag was deleted after scheduling", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "chosen", name: "Chosen" }],
  };
  const harness = createHarness(initial);
  const holderReady = createSignal();
  const releaseHolder = createSignal();
  const holder = harness.lockManager.withLock(STORAGE_LOCK_NAME, async () => {
    holderReady.resolve();
    await releaseHolder.promise;
    const deletion = planTagDeletion(harness.state(), "chosen");
    if (deletion.status !== "ready") {
      throw new Error("Expected selected tag deletion to succeed.");
    }
    harness.replaceState(deletion.state);
  });
  await holderReady.promise;

  const running = harness.coordinator.block({
    ...upvoterRequest(),
    tagId: "chosen",
  });
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  releaseHolder.resolve();
  await holder;

  deepStrictEqual(await running, {
    status: "success",
    persistedUpvoter: true,
  });
  strictEqual(harness.state().authors[0]?.tagId, "default");
  strictEqual(harness.counts().posts, 0);
});

test("SOURCE-005 latest-state userId/memberHash duplicate skips without overwriting a direct record", async () => {
  const direct = {
    ...directAuthor("canonical-user"),
    memberHashId: "a".repeat(32),
  };
  const existing: BlacklistState = {
    ...createInitialState(),
    authors: [direct],
  };
  const harness = createHarness(existing);

  const result = await harness.coordinator.block({
    ...upvoterRequest(direct.memberHashId),
    authorName: "Changed name",
  });

  deepStrictEqual(result, { status: "skipped", reason: "existing" });
  deepStrictEqual(harness.state(), existing);
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 0,
    applies: 0,
    storageFailures: 0,
  });
});

test("VOTER-014 a direct commit winning the storage race is reported skipped", async () => {
  const harness = createHarness(createInitialState());
  const holderReady = createSignal();
  const releaseHolder = createSignal();
  const directState: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("race-user")],
  };
  const holder = harness.lockManager.withLock(STORAGE_LOCK_NAME, async () => {
    holderReady.resolve();
    await releaseHolder.promise;
    harness.replaceState(directState);
  });
  await holderReady.promise;

  const running = harness.coordinator.block(upvoterRequest("race-user"));
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  releaseHolder.resolve();
  await holder;

  deepStrictEqual(await running, { status: "skipped", reason: "existing" });
  deepStrictEqual(harness.state(), directState);
  strictEqual(harness.counts().writes, 0);
  strictEqual(harness.counts().posts, 0);
});

test("VOTER-014 same-context upvoter lock waiting cannot suppress an authorized direct POST", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("same-race-user")],
  };
  const harness = createHarness(initial, { holdFirstRead: true });

  const upvoter = harness.coordinator.block(upvoterRequest("same-race-user"));
  await harness.readStarted;
  const direct = harness.coordinator.block({
    source: "direct",
    userId: "same-race-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  harness.releaseRead();

  deepStrictEqual(await Promise.all([upvoter, direct]), [
    { status: "skipped", reason: "existing" },
    { status: "success", persistedUpvoter: false },
  ]);
  deepStrictEqual(harness.state(), initial);
  deepStrictEqual(harness.runtime(), initial);
  deepStrictEqual(harness.counts(), {
    posts: 1,
    writes: 0,
    applies: 0,
    storageFailures: 0,
  });
});

test("VOTER-014 cross-context upvoter lock waiting cannot suppress an authorized direct POST", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("cross-race-user")],
  };
  const harness = createHarness(initial, { holdFirstRead: true });
  const otherCoordinator = harness.createCoordinator();

  const upvoter = harness.coordinator.block(upvoterRequest("cross-race-user"));
  await harness.readStarted;
  const direct = otherCoordinator.block({
    source: "direct",
    userId: "cross-race-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  harness.releaseRead();

  deepStrictEqual(await Promise.all([upvoter, direct]), [
    { status: "skipped", reason: "existing" },
    { status: "success", persistedUpvoter: false },
  ]);
  deepStrictEqual(harness.state(), initial);
  deepStrictEqual(harness.runtime(), initial);
  deepStrictEqual(harness.counts(), {
    posts: 1,
    writes: 0,
    applies: 0,
    storageFailures: 0,
  });
});

test("VOTER-014 same-context direct POST overlap still lets the upvoter reach its storage re-read", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("same-overlap-user")],
  };
  const harness = createHarness(initial, {
    async blockUser() {
      blockStarted.resolve();
      await releaseBlock.promise;
      return { status: "success", endpoint: "primary" };
    },
  });

  const direct = harness.coordinator.block({
    source: "direct",
    userId: "same-overlap-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  await blockStarted.promise;
  const upvoter = harness.coordinator.block(upvoterRequest("same-overlap-user"));
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([direct, upvoter]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "existing" },
  ]);
  deepStrictEqual(harness.state(), initial);
  deepStrictEqual(harness.runtime(), initial);
  strictEqual(harness.counts().posts, 1);
  strictEqual(harness.counts().writes, 0);
});

test("VOTER-014 cross-context direct POST overlap still lets the upvoter reach its storage re-read", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("cross-overlap-user")],
  };
  const harness = createHarness(initial, {
    async blockUser() {
      blockStarted.resolve();
      await releaseBlock.promise;
      return { status: "success", endpoint: "primary" };
    },
  });
  const otherCoordinator = harness.createCoordinator();

  const direct = harness.coordinator.block({
    source: "direct",
    userId: "cross-overlap-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  await blockStarted.promise;
  const upvoter = otherCoordinator.block(upvoterRequest("cross-overlap-user"));
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([direct, upvoter]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "existing" },
  ]);
  deepStrictEqual(harness.state(), initial);
  deepStrictEqual(harness.runtime(), initial);
  strictEqual(harness.counts().posts, 1);
  strictEqual(harness.counts().writes, 0);
});

test("SOURCE-005 same-context upvoters serialize to one write and one existing skip", async () => {
  const harness = createHarness(createInitialState(), { holdWrite: true });
  const first = harness.coordinator.block(upvoterRequest("shared-user"));
  await harness.writeStarted;
  const second = harness.coordinator.block(upvoterRequest("shared-user"));
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  harness.releaseWrite();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: true },
    { status: "skipped", reason: "existing" },
  ]);
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 1,
    applies: 1,
    storageFailures: 0,
  });
});

test("SOURCE-005 cross-context upvoters serialize through the global storage lock", async () => {
  const harness = createHarness(createInitialState(), { holdWrite: true });
  const otherCoordinator = harness.createCoordinator();
  const first = harness.coordinator.block(upvoterRequest("cross-context-user"));
  await harness.writeStarted;
  const second = otherCoordinator.block(upvoterRequest("cross-context-user"));
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  harness.releaseWrite();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: true },
    { status: "skipped", reason: "existing" },
  ]);
  strictEqual(harness.counts().writes, 1);
  strictEqual(harness.counts().posts, 0);
  strictEqual(
    harness.lockManager.requestedNames.some((name) => name.startsWith("cocoon-remote-block-user-")),
    false,
  );
});

test("SOURCE-005 a waiting upvoter persists after the first concurrent write fails", async () => {
  const harness = createHarness(createInitialState(), {
    failWriteAttempts: 1,
    holdWrite: true,
  });
  const first = harness.coordinator.block(upvoterRequest("retry-user"));
  await harness.writeStarted;
  const second = harness.coordinator.block(upvoterRequest("retry-user"));
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  harness.releaseWrite();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "failed", reason: "storage" },
    { status: "success", persistedUpvoter: true },
  ]);
  strictEqual(harness.state().authors[0]?.userId, "retry-user");
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 2,
    applies: 1,
    storageFailures: 1,
  });
});

test("ERR-001 upvoter storage failure does not apply runtime state or report success", async () => {
  const initial = createInitialState();
  const harness = createHarness(initial, { failWrite: true });

  const result = await harness.coordinator.block(upvoterRequest("failed-user"));

  deepStrictEqual(result, { status: "failed", reason: "storage" });
  deepStrictEqual(harness.state(), initial);
  deepStrictEqual(harness.runtime(), initial);
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 1,
    applies: 0,
    storageFailures: 1,
  });
});

test("VOTER-014 lifecycle stop before persistence performs no POST, write, or runtime apply", async () => {
  const harness = createHarness(createInitialState());

  const result = await harness.coordinator.block(upvoterRequest("stopped-user"), () => true);

  deepStrictEqual(result, { status: "stopped" });
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 0,
    applies: 0,
    storageFailures: 0,
  });
});

test("VOTER-014 an already dispatched atomic upvoter transaction completes after lifecycle stop", async () => {
  const initial = createInitialState();
  const harness = createHarness(initial);
  const holderReady = createSignal();
  const releaseHolder = createSignal();
  const holder = harness.lockManager.withLock(STORAGE_LOCK_NAME, async () => {
    holderReady.resolve();
    await releaseHolder.promise;
  });
  await holderReady.promise;
  let stopped = false;

  const running = harness.coordinator.block(upvoterRequest("stopped-lock-waiter"), () => stopped);
  await harness.lockManager.waitForRequestCount(STORAGE_LOCK_NAME, 2);
  stopped = true;
  releaseHolder.resolve();
  await holder;

  deepStrictEqual(await running, { status: "success", persistedUpvoter: true });
  strictEqual(harness.state().authors[0]?.userId, "stopped-lock-waiter");
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 1,
    applies: 1,
    storageFailures: 0,
  });
});

test("VOTER-014 an atomic transaction is not rolled back after its authoritative read", async () => {
  const initial = createInitialState();
  const harness = createHarness(initial, { holdFirstRead: true });
  let stopped = false;

  const running = harness.coordinator.block(upvoterRequest("stopped-before-write"), () => stopped);
  await harness.readStarted;
  stopped = true;
  harness.releaseRead();

  deepStrictEqual(await running, { status: "success", persistedUpvoter: true });
  strictEqual(harness.state().authors[0]?.userId, "stopped-before-write");
  deepStrictEqual(harness.runtime(), harness.state());
  deepStrictEqual(harness.counts(), {
    posts: 0,
    writes: 1,
    applies: 1,
    storageFailures: 0,
  });
});

test("ERR-001 upvoter storage lock and read exceptions stay storage-classified", async () => {
  for (const options of [{ failStorageLock: true }, { failRead: true }] as const) {
    const harness = createHarness(createInitialState(), options);

    deepStrictEqual(await harness.coordinator.block(upvoterRequest("storage-error-user")), {
      status: "failed",
      reason: "storage",
    });
    deepStrictEqual(harness.counts(), {
      posts: 0,
      writes: 0,
      applies: 0,
      storageFailures: 1,
    });
  }
});

test("REMOTE-005 direct remote failures remain failures without changing local state", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("direct-user")],
  };
  const harness = createHarness(initial, {
    blockResult: { status: "failed", reason: "http" },
  });

  const result = await harness.coordinator.block({
    source: "direct",
    userId: "direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  });

  deepStrictEqual(result, { status: "failed", reason: "http" });
  strictEqual(harness.counts().posts, 1);
  strictEqual(harness.counts().writes, 0);
});

test("SOURCE-005 stale expectedBlacklistedAt blocks a direct POST", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("stale-direct-user")],
  };
  const harness = createHarness(initial);

  deepStrictEqual(
    await harness.coordinator.block({
      source: "direct",
      userId: "stale-direct-user",
      expectedBlacklistedAt: "2027-01-01T00:00:00.000Z",
    }),
    { status: "skipped", reason: "existing" },
  );
  strictEqual(harness.counts().posts, 0);
  deepStrictEqual(harness.state(), initial);
});

test("SOURCE-005 same-context direct requests retain in-flight deduplication", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("same-direct-user")],
  };
  const harness = createHarness(initial, {
    async blockUser() {
      blockStarted.resolve();
      await releaseBlock.promise;
      return { status: "success", endpoint: "primary" };
    },
  });
  const request = {
    source: "direct" as const,
    userId: "same-direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  };

  const first = harness.coordinator.block(request);
  await blockStarted.promise;
  const second = harness.coordinator.block(request);
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "concurrent" },
  ]);
  strictEqual(harness.counts().posts, 1);
});

test("SOURCE-005 cross-context direct requests retain the hashed user try-lock", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("cross-direct-user")],
  };
  const harness = createHarness(initial, {
    async blockUser() {
      blockStarted.resolve();
      await releaseBlock.promise;
      return { status: "success", endpoint: "primary" };
    },
  });
  const otherCoordinator = harness.createCoordinator();
  const request = {
    source: "direct" as const,
    userId: "cross-direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  };

  const first = harness.coordinator.block(request);
  await blockStarted.promise;
  const second = otherCoordinator.block(request);
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "concurrent" },
  ]);
  strictEqual(harness.counts().posts, 1);
  const userLockNames = harness.lockManager.requestedNames.filter((name) =>
    name.startsWith("cocoon-remote-block-user-"),
  );
  strictEqual(userLockNames.length, 2);
  strictEqual(
    userLockNames.some((name) => name.includes("cross-direct-user")),
    false,
  );
});

test("SOURCE-005 direct preflight is rechecked after waiting for a shared POST slot", async () => {
  const [sameSlot] = userIdsBySlot(2);
  const [occupyingUser, waitingUser] = sameSlot;
  if (!occupyingUser || !waitingUser) {
    throw new Error("Unable to find users in the same lock slot.");
  }
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor(occupyingUser), directAuthor(waitingUser)],
  };
  const harness = createHarness(initial, {
    async blockUser(userId) {
      if (userId === occupyingUser) {
        blockStarted.resolve();
        await releaseBlock.promise;
      }
      return { status: "success", endpoint: "primary" };
    },
  });
  const otherCoordinator = harness.createCoordinator();
  const first = harness.coordinator.block({
    source: "direct",
    userId: occupyingUser,
    expectedBlacklistedAt: TIMESTAMP,
  });
  await blockStarted.promise;
  const slotName = harness.lockManager.requestedNames.find((name) =>
    name.startsWith("cocoon-remote-block-slot-"),
  );
  if (!slotName) {
    throw new Error("The first direct POST slot was not requested.");
  }

  const second = otherCoordinator.block({
    source: "direct",
    userId: waitingUser,
    expectedBlacklistedAt: TIMESTAMP,
  });
  await harness.lockManager.waitForRequestCount(slotName, 2);
  harness.replaceState({
    ...initial,
    authors: [
      directAuthor(occupyingUser),
      {
        ...directAuthor(waitingUser),
        blacklistedAt: "2027-01-01T00:00:00.000Z",
      },
    ],
  });
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "existing" },
  ]);
  strictEqual(harness.counts().posts, 1);
});

test("SOURCE-005 lifecycle stop while waiting for a direct POST slot prevents the POST", async () => {
  const [sameSlot] = userIdsBySlot(2);
  const [occupyingUser, waitingUser] = sameSlot;
  if (!occupyingUser || !waitingUser) {
    throw new Error("Unable to find users in the same lock slot.");
  }
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor(occupyingUser), directAuthor(waitingUser)],
  };
  const harness = createHarness(initial, {
    async blockUser(userId) {
      if (userId === occupyingUser) {
        blockStarted.resolve();
        await releaseBlock.promise;
      }
      return { status: "success", endpoint: "primary" };
    },
  });
  const otherCoordinator = harness.createCoordinator();
  let stopped = false;
  const first = harness.coordinator.block({
    source: "direct",
    userId: occupyingUser,
    expectedBlacklistedAt: TIMESTAMP,
  });
  await blockStarted.promise;
  const slotName = harness.lockManager.requestedNames.find((name) =>
    name.startsWith("cocoon-remote-block-slot-"),
  );
  if (!slotName) {
    throw new Error("The first direct POST slot was not requested.");
  }

  const second = otherCoordinator.block(
    {
      source: "direct",
      userId: waitingUser,
      expectedBlacklistedAt: TIMESTAMP,
    },
    () => stopped,
  );
  await harness.lockManager.waitForRequestCount(slotName, 2);
  stopped = true;
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([first, second]), [
    { status: "success", persistedUpvoter: false },
    { status: "stopped" },
  ]);
  strictEqual(harness.counts().posts, 1);
});

test("ERR-001 direct lock and slot failures remain network-classified while storage failures remain storage-classified", async () => {
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("classified-direct-user")],
  };
  const request = {
    source: "direct" as const,
    userId: "classified-direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  };
  const scenarios = [
    {
      options: { failTryLock: true },
      expected: { status: "failed", reason: "network" },
      storageFailures: 0,
    },
    {
      options: { failSlotLock: true },
      expected: { status: "failed", reason: "network" },
      storageFailures: 0,
    },
    {
      options: { failStorageLock: true },
      expected: { status: "failed", reason: "storage" },
      storageFailures: 1,
    },
    {
      options: { failRead: true },
      expected: { status: "failed", reason: "storage" },
      storageFailures: 1,
    },
  ] as const;

  for (const scenario of scenarios) {
    const harness = createHarness(initial, scenario.options);
    deepStrictEqual(await harness.coordinator.block(request), scenario.expected);
    strictEqual(harness.counts().storageFailures, scenario.storageFailures);
    strictEqual(harness.counts().posts, 0);
  }
});

test("SOURCE-005 a failed direct operation clears in-flight coordination so retry works", async () => {
  let attempts = 0;
  const initial: BlacklistState = {
    ...createInitialState(),
    authors: [directAuthor("retry-direct-user")],
  };
  const harness = createHarness(initial, {
    async blockUser() {
      attempts += 1;
      return attempts === 1
        ? { status: "failed", reason: "http" }
        : { status: "success", endpoint: "primary" };
    },
  });
  const request = {
    source: "direct" as const,
    userId: "retry-direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  };

  deepStrictEqual(await harness.coordinator.block(request), {
    status: "failed",
    reason: "http",
  });
  deepStrictEqual(await harness.coordinator.block(request), {
    status: "success",
    persistedUpvoter: false,
  });
  strictEqual(harness.counts().posts, 2);
});

test("REMOTE-005 direct requests retain three shared remote POST slots", async () => {
  const userIds = userIdsBySlot(2).flatMap((users) => users);
  const state: BlacklistState = {
    ...createInitialState(),
    authors: userIds.map((userId) => directAuthor(userId)),
  };
  const lockManager = createNamedExclusiveLockManager();
  const firstThreeStarted = createSignal();
  const fourthStarted = createSignal();
  const allStarted = createSignal();
  const releases: Array<() => void> = [];
  let active = 0;
  let starts = 0;
  let maximumActive = 0;

  function createCoordinator() {
    return createRemoteBlockCoordinator({
      async withCrossContextLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
        return lockManager.withLock(name, operation);
      },
      async tryWithCrossContextUserLock<T>(
        name: string,
        operation: () => Promise<T>,
      ): Promise<CrossContextTryLockResult<T>> {
        return lockManager.tryWithLock(name, operation);
      },
      async preflightDirect(userId, expectedBlacklistedAt) {
        const existing = state.authors.some(
          (author) =>
            author.platformId === "zhihu" &&
            author.userId === userId &&
            author.blockSource === "direct" &&
            author.blacklistedAt === expectedBlacklistedAt,
        );
        return { status: existing ? "ready" : "existing" };
      },
      async commitUpvoter() {
        throw new Error("Direct requests must not persist upvoters.");
      },
      now() {
        return new Date(TIMESTAMP);
      },
      async blockUser() {
        active += 1;
        starts += 1;
        maximumActive = Math.max(maximumActive, active);
        if (starts === 3) firstThreeStarted.resolve();
        if (starts === 4) fourthStarted.resolve();
        if (starts === userIds.length) allStarted.resolve();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
        return { status: "success", endpoint: "primary" };
      },
      reportStorageFailure() {},
    });
  }

  const coordinators = [createCoordinator(), createCoordinator()] as const;
  const operations = userIds.map((userId, index) =>
    coordinators[index % coordinators.length].block({
      source: "direct",
      userId,
      expectedBlacklistedAt: TIMESTAMP,
    }),
  );
  await firstThreeStarted.promise;
  strictEqual(maximumActive, 3);
  strictEqual(releases.length, 3);

  releases.shift()?.();
  await fourthStarted.promise;
  strictEqual(maximumActive, 3);
  for (const release of releases.splice(0)) release();
  await allStarted.promise;
  for (const release of releases.splice(0)) release();
  await Promise.all(operations);

  strictEqual(maximumActive, 3);
});
