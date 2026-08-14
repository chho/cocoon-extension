import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  isValidBlacklistTimestamp,
  parseBlacklistState,
  planTagDeletion,
  type BlacklistState,
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
    async withLock<T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<T> {
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
      const tail = release.promise;
      tails.set(name, tail);
      try {
        return { acquired: true, value: await operation() };
      } finally {
        release.resolve();
        if (tails.get(name) === tail) {
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

function createHarness(
  initialState: BlacklistState,
  blockResult: RemoteBlockResult = { status: "success", endpoint: "primary" },
  failures: {
    readonly tryLock?: boolean;
    readonly readState?: boolean;
  } = {},
) {
  const lockManager = createNamedExclusiveLockManager();
  let stored = initialState;
  let runtime = initialState;
  let posts = 0;
  let writes = 0;
  let releaseBlock: (() => void) | null = null;
  let markBlockStarted: (() => void) | null = null;
  let waitForRelease = false;
  let blockStarted = Promise.resolve();
  const coordinator = createRemoteBlockCoordinator({
    async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
      return lockManager.withLock(STORAGE_LOCK_NAME, operation);
    },
    async withCrossContextLock<T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return lockManager.withLock(name, operation);
    },
    async tryWithCrossContextUserLock<T>(
      name: string,
      operation: () => Promise<T>,
    ): Promise<CrossContextTryLockResult<T>> {
      if (failures.tryLock) {
        throw new Error("The user lock API failed.");
      }
      return lockManager.tryWithLock(name, operation);
    },
    async readState() {
      if (failures.readState) {
        throw new Error("The storage read failed.");
      }
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      stored = state;
    },
    applyPersistedState(state) {
      runtime = state;
    },
    now() {
      return new Date(TIMESTAMP);
    },
    async blockUser() {
      posts += 1;
      if (waitForRelease) {
        markBlockStarted?.();
        await new Promise<void>((resolve) => {
          releaseBlock = resolve;
        });
      }
      return blockResult;
    },
    reportMalformedStorage() {},
    reportStorageFailure() {},
  });

  return {
    coordinator,
    state: () => stored,
    runtime: () => runtime,
    counts: () => ({ posts, writes }),
    holdBlock() {
      waitForRelease = true;
      blockStarted = new Promise<void>((resolve) => {
        markBlockStarted = resolve;
      });
    },
    async waitUntilBlockStarts() {
      await blockStarted;
    },
    releaseBlock() {
      releaseBlock?.();
    },
    deleteTag(tagId: string) {
      const plan = planTagDeletion(stored, tagId);
      if (plan.status !== "ready") {
        throw new Error("Expected a deletable tag.");
      }
      stored = plan.state;
      runtime = plan.state;
    },
  };
}

function createSharedHarness(
  initialState: BlacklistState,
  blockUser: (
    userId: string,
    isStopped: () => boolean,
  ) => Promise<RemoteBlockResult>,
) {
  const lockManager = createNamedExclusiveLockManager();
  let stored = initialState;
  let runtime = initialState;
  let writes = 0;

  function createCoordinator() {
    return createRemoteBlockCoordinator({
      async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
        return lockManager.withLock(STORAGE_LOCK_NAME, operation);
      },
      async withCrossContextLock<T>(
        name: string,
        operation: () => Promise<T>,
      ): Promise<T> {
        return lockManager.withLock(name, operation);
      },
      async tryWithCrossContextUserLock<T>(
        name: string,
        operation: () => Promise<T>,
      ): Promise<CrossContextTryLockResult<T>> {
        return lockManager.tryWithLock(name, operation);
      },
      async readState() {
        return parseBlacklistState(stored);
      },
      async writeState(state) {
        writes += 1;
        stored = state;
      },
      applyPersistedState(state) {
        runtime = state;
      },
      now() {
        return new Date(TIMESTAMP);
      },
      blockUser,
      reportMalformedStorage() {},
      reportStorageFailure() {},
    });
  }

  return {
    coordinators: [createCoordinator(), createCoordinator()] as const,
    lockManager,
    state: () => stored,
    runtime: () => runtime,
    writes: () => writes,
    replaceState(state: BlacklistState) {
      stored = state;
      runtime = state;
    },
    async writeStateFromOtherContext(state: BlacklistState): Promise<void> {
      await lockManager.withLock(STORAGE_LOCK_NAME, async () => {
        stored = state;
        runtime = state;
      });
    },
  };
}

function directState(): BlacklistState {
  return {
    ...createInitialState(),
    authors: [
      {
        userId: "direct-user",
        authorNameAtCapture: "Direct",
        tagId: "default",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
}

function userIdsBySlot(countPerSlot: number): readonly string[][] {
  const slots: string[][] = Array.from({ length: 3 }, () => []);
  for (
    let candidate = 0;
    slots.some((users) => users.length < countPerSlot);
    candidate += 1
  ) {
    const userId = `slot-user-${candidate}`;
    const slot = stableRemoteBlockHash32(userId) % 3;
    if (slots[slot].length < countPerSlot) {
      slots[slot].push(userId);
    }
  }
  return slots;
}

test("SOURCE-005 allows remote direct work only for the just-created direct record", async () => {
  const harness = createHarness(directState());
  const success = await harness.coordinator.block({
    source: "direct",
    userId: "direct-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  strictEqual(success.status, "success");
  deepStrictEqual(harness.counts(), { posts: 1, writes: 0 });

  const stale = await createHarness(directState()).coordinator.block({
    source: "direct",
    userId: "direct-user",
    expectedBlacklistedAt: "2027-01-01T00:00:00.000Z",
  });
  deepStrictEqual(stale, { status: "skipped", reason: "existing" });
});

test("SOURCE-002/003 persists only a successful upvoter with the selected tag and no image", async () => {
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "chosen", name: "Chosen" }],
  };
  const harness = createHarness(state);
  const result = await harness.coordinator.block({
    source: "upvoter",
    userId: "voter-user",
    authorName: "Voter",
    tagId: "chosen",
  });

  deepStrictEqual(result, { status: "success", persistedUpvoter: true });
  deepStrictEqual(harness.state().authors, [
    {
      userId: "voter-user",
      authorNameAtCapture: "Voter",
      tagId: "chosen",
      blacklistedAt: TIMESTAMP,
      blockSource: "upvoter",
    },
  ]);
  strictEqual(harness.runtime(), harness.state());
});

test("SOURCE-003 migrates an upvoter to default when its tag is deleted during POST", async () => {
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "chosen", name: "Chosen" }],
  };
  const harness = createHarness(state);
  harness.holdBlock();
  const running = harness.coordinator.block({
    source: "upvoter",
    userId: "voter-user",
    authorName: "Voter",
    tagId: "chosen",
  });

  await harness.waitUntilBlockStarts();
  harness.deleteTag("chosen");
  harness.releaseBlock();

  deepStrictEqual(await running, {
    status: "success",
    persistedUpvoter: true,
  });
  strictEqual(harness.counts().posts, 1);
  strictEqual(harness.state().authors.length, 1);
  const saved = harness.state().authors[0];
  strictEqual(saved?.tagId, "default");
  strictEqual(saved?.blockSource, "upvoter");
  strictEqual(isValidBlacklistTimestamp(saved?.blacklistedAt), true);
});

test("SOURCE-002 does not persist a remotely failed upvoter", async () => {
  const harness = createHarness(createInitialState(), {
    status: "failed",
    reason: "http",
  });
  const result = await harness.coordinator.block({
    source: "upvoter",
    userId: "failed-user",
    authorName: "Failed",
    tagId: "default",
  });

  deepStrictEqual(result, { status: "failed", reason: "http" });
  deepStrictEqual(harness.state().authors, []);
  deepStrictEqual(harness.counts(), { posts: 1, writes: 0 });
});

test("SOURCE-005 skips latest storage users before any POST and never overwrites fields", async () => {
  const existing = directState();
  const harness = createHarness(existing);
  const result = await harness.coordinator.block({
    source: "upvoter",
    userId: "direct-user",
    authorName: "Changed",
    tagId: "default",
  });

  deepStrictEqual(result, { status: "skipped", reason: "existing" });
  deepStrictEqual(harness.counts(), { posts: 0, writes: 0 });
  deepStrictEqual(harness.state(), existing);
});

test("VOTER-010/SOURCE-005 concurrent requests in one coordinator share the in-flight operation", async () => {
  const harness = createHarness(createInitialState());
  harness.holdBlock();
  const first = harness.coordinator.block({
    source: "upvoter",
    userId: "shared-user",
    authorName: "Shared",
    tagId: "default",
  });
  await harness.waitUntilBlockStarts();
  const second = harness.coordinator.block({
    source: "upvoter",
    userId: "shared-user",
    authorName: "Changed",
    tagId: "default",
  });
  harness.releaseBlock();

  deepStrictEqual(
    [(await first).status, (await second).status],
    ["success", "skipped"],
  );
  deepStrictEqual(harness.counts(), { posts: 1, writes: 1 });
  strictEqual(harness.state().authors.length, 1);
});

test("failed users can be retried by a later batch without an attempted cache", async () => {
  for (const reason of [
    "network",
    "http",
    "rate-limit",
    "authentication",
  ] as const) {
    const harness = createHarness(createInitialState(), {
      status: "failed",
      reason,
    });
    const request = {
      source: "upvoter",
      userId: `retry-${reason}`,
      authorName: "Retry",
      tagId: "default",
    } as const;

    deepStrictEqual(await harness.coordinator.block(request), {
      status: "failed",
      reason,
    });
    deepStrictEqual(await harness.coordinator.block(request), {
      status: "failed",
      reason,
    });
    strictEqual(harness.counts().posts, 2);
  }
});

test("lock API failures stay network-classified while locked storage failures stay storage-classified", async () => {
  const request = {
    source: "upvoter",
    userId: "classification-user",
    authorName: "Classification",
    tagId: "default",
  } as const;
  const lockFailure = createHarness(
    createInitialState(),
    { status: "success", endpoint: "primary" },
    { tryLock: true },
  );
  deepStrictEqual(await lockFailure.coordinator.block(request), {
    status: "failed",
    reason: "network",
  });
  strictEqual(lockFailure.counts().posts, 0);

  const storageFailure = createHarness(
    createInitialState(),
    { status: "success", endpoint: "primary" },
    { readState: true },
  );
  deepStrictEqual(await storageFailure.coordinator.block(request), {
    status: "failed",
    reason: "storage",
  });
  strictEqual(storageFailure.counts().posts, 0);
});

test("SOURCE-005 try-locks the same user across coordinator instances and posts once", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  let posts = 0;
  const harness = createSharedHarness(
    createInitialState(),
    async () => {
      posts += 1;
      blockStarted.resolve();
      await releaseBlock.promise;
      return { status: "success", endpoint: "primary" };
    },
  );
  const request = {
    source: "upvoter",
    userId: "cross-context-user",
    authorName: "Shared",
    tagId: "default",
  } as const;

  const first = harness.coordinators[0].block(request);
  await blockStarted.promise;
  const second = harness.coordinators[1].block(request);
  releaseBlock.resolve();
  const results = await Promise.all([first, second]);

  deepStrictEqual(results, [
    { status: "success", persistedUpvoter: true },
    { status: "skipped", reason: "concurrent" },
  ]);
  strictEqual(posts, 1);
  strictEqual(harness.writes(), 1);
  strictEqual(harness.state().authors.length, 1);
  strictEqual(
    harness.lockManager.requestedNames.some((name) =>
      name.includes("cross-context-user")
    ),
    false,
  );
});

test("SOURCE-005 overlapping failed requests post once and a later batch can retry", async () => {
  for (const reason of ["http", "network"] as const) {
    const firstBlockStarted = createSignal();
    const releaseFirstBlock = createSignal();
    let posts = 0;
    const harness = createSharedHarness(createInitialState(), async () => {
      posts += 1;
      if (posts === 1) {
        firstBlockStarted.resolve();
        await releaseFirstBlock.promise;
      }
      return { status: "failed", reason };
    });
    const request = {
      source: "upvoter",
      userId: `overlapping-failure-${reason}`,
      authorName: "Retry",
      tagId: "default",
    } as const;

    const first = harness.coordinators[0].block(request);
    await firstBlockStarted.promise;
    const userLockName = harness.lockManager.requestedNames.find((name) =>
      name.startsWith("cocoon-remote-block-user-")
    );
    if (!userLockName) {
      throw new Error("The cross-context user lock was not requested.");
    }
    const second = harness.coordinators[1].block(request);
    await harness.lockManager.waitForRequestCount(userLockName, 2);
    releaseFirstBlock.resolve();

    deepStrictEqual(await Promise.all([first, second]), [
      { status: "failed", reason },
      { status: "skipped", reason: "concurrent" },
    ]);
    strictEqual(posts, 1);

    deepStrictEqual(await harness.coordinators[1].block(request), {
      status: "failed",
      reason,
    });
    strictEqual(posts, 2);
  }
});

test("SOURCE-005 direct storage commit wins while an upvoter POST holds the user try-lock", async () => {
  const blockStarted = createSignal();
  const releaseBlock = createSignal();
  let posts = 0;
  const initialState: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "direct-tag", name: "Direct tag" },
    ],
  };
  const harness = createSharedHarness(initialState, async () => {
    posts += 1;
    blockStarted.resolve();
    await releaseBlock.promise;
    return { status: "success", endpoint: "primary" };
  });
  const upvoter = harness.coordinators[0].block({
    source: "upvoter",
    userId: "direct-race-user",
    authorName: "Upvoter value",
    tagId: "default",
  });
  await blockStarted.promise;

  const directState: BlacklistState = {
    ...initialState,
    authors: [
      {
        userId: "direct-race-user",
        authorNameAtCapture: "Direct value",
        tagId: "direct-tag",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
        cardImage: {
          dataUrl: "data:image/webp;base64,AAAA",
          width: 10,
          height: 5,
        },
      },
    ],
  };
  await harness.writeStateFromOtherContext(directState);
  const direct = harness.coordinators[1].block({
    source: "direct",
    userId: "direct-race-user",
    expectedBlacklistedAt: TIMESTAMP,
  });
  const userLockName = harness.lockManager.requestedNames.find((name) =>
    name.startsWith("cocoon-remote-block-user-")
  );
  if (!userLockName) {
    throw new Error("The cross-context user lock was not requested.");
  }
  await harness.lockManager.waitForRequestCount(userLockName, 2);
  releaseBlock.resolve();

  deepStrictEqual(await Promise.all([upvoter, direct]), [
    { status: "success", persistedUpvoter: false },
    { status: "skipped", reason: "concurrent" },
  ]);
  strictEqual(posts, 1);
  deepStrictEqual(harness.state(), directState);
  deepStrictEqual(harness.runtime(), directState);
});

test("waiting for a shared POST slot repeats latest storage preflight", async () => {
  const [sameSlot] = userIdsBySlot(2);
  const [occupyingUser, waitingUser] = sameSlot;
  if (!occupyingUser || !waitingUser) {
    throw new Error("Unable to find users in the same lock slot.");
  }
  const firstBlockStarted = createSignal();
  const releaseFirstBlock = createSignal();
  let posts = 0;
  const harness = createSharedHarness(createInitialState(), async (userId) => {
    posts += 1;
    if (userId === occupyingUser) {
      firstBlockStarted.resolve();
      await releaseFirstBlock.promise;
    }
    return { status: "failed", reason: "http" };
  });
  const first = harness.coordinators[0].block({
    source: "upvoter",
    userId: occupyingUser,
    authorName: "Occupying",
    tagId: "default",
  });
  await firstBlockStarted.promise;
  const slotName = harness.lockManager.requestedNames.find((name) =>
    name.startsWith("cocoon-remote-block-slot-")
  );
  if (!slotName) {
    throw new Error("The first POST slot was not requested.");
  }

  const second = harness.coordinators[1].block({
    source: "upvoter",
    userId: waitingUser,
    authorName: "Waiting",
    tagId: "default",
  });
  await harness.lockManager.waitForRequestCount(slotName, 2);
  harness.replaceState({
    ...createInitialState(),
    authors: [
      {
        userId: waitingUser,
        authorNameAtCapture: "Persisted elsewhere",
        tagId: "default",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  });
  releaseFirstBlock.resolve();

  deepStrictEqual(await second, { status: "skipped", reason: "existing" });
  strictEqual((await first).status, "failed");
  strictEqual(posts, 1);
});

test("a stop requested while waiting for a shared slot prevents a new POST", async () => {
  const [sameSlot] = userIdsBySlot(2);
  const [occupyingUser, waitingUser] = sameSlot;
  if (!occupyingUser || !waitingUser) {
    throw new Error("Unable to find users in the same lock slot.");
  }
  const firstBlockStarted = createSignal();
  const releaseFirstBlock = createSignal();
  let posts = 0;
  let stopped = false;
  const harness = createSharedHarness(createInitialState(), async (userId) => {
    posts += 1;
    if (userId === occupyingUser) {
      firstBlockStarted.resolve();
      await releaseFirstBlock.promise;
    }
    return { status: "failed", reason: "http" };
  });
  const first = harness.coordinators[0].block({
    source: "upvoter",
    userId: occupyingUser,
    authorName: "Occupying",
    tagId: "default",
  });
  await firstBlockStarted.promise;
  const slotName = harness.lockManager.requestedNames.find((name) =>
    name.startsWith("cocoon-remote-block-slot-")
  );
  if (!slotName) {
    throw new Error("The first POST slot was not requested.");
  }

  const second = harness.coordinators[1].block(
    {
      source: "upvoter",
      userId: waitingUser,
      authorName: "Waiting",
      tagId: "default",
    },
    () => stopped,
  );
  await harness.lockManager.waitForRequestCount(slotName, 2);
  stopped = true;
  releaseFirstBlock.resolve();

  deepStrictEqual(await second, { status: "stopped" });
  strictEqual((await first).status, "failed");
  strictEqual(posts, 1);
});

test("VOTER-009 caps POSTs across two coordinator instances at three shared slots", async () => {
  const usersBySlot = userIdsBySlot(2);
  const userIds = usersBySlot.flatMap((users) => users);
  const firstThreeStarted = createSignal();
  const fourthStarted = createSignal();
  const allStarted = createSignal();
  const releases: Array<() => void> = [];
  let active = 0;
  let starts = 0;
  let maximumActive = 0;
  const harness = createSharedHarness(createInitialState(), async () => {
    active += 1;
    starts += 1;
    maximumActive = Math.max(maximumActive, active);
    if (starts === 3) {
      firstThreeStarted.resolve();
    }
    if (starts === 4) {
      fourthStarted.resolve();
    }
    if (starts === userIds.length) {
      allStarted.resolve();
    }
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    active -= 1;
    return { status: "failed", reason: "http" };
  });

  const operations = userIds.map((userId, index) =>
    harness.coordinators[index % harness.coordinators.length].block({
      source: "upvoter",
      userId,
      authorName: "Name",
      tagId: "default",
    }),
  );
  await firstThreeStarted.promise;
  strictEqual(maximumActive, 3);
  strictEqual(releases.length, 3);

  releases.shift()?.();
  await fourthStarted.promise;
  strictEqual(maximumActive, 3);

  for (const release of releases.splice(0)) {
    release();
  }
  await allStarted.promise;
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.all(operations);
  strictEqual(maximumActive, 3);
});
