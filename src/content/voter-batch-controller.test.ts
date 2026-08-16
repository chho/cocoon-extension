import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState, parseBlacklistState } from "./blacklist-state.ts";
import type {
  CoordinatedBlockResult,
  RemoteBlockCoordinator,
  UserBlockRequest,
} from "./remote-block-coordinator.ts";
import type { VoterFetchResult } from "./zhihu-remote-api.ts";
import {
  createVoterBatchController,
  type VoterBatchProgress,
} from "./voter-batch-controller.ts";

function voters(
  ids: readonly string[],
  overrides: Partial<VoterFetchResult> = {},
): VoterFetchResult {
  return {
    users: ids.map((userId) => ({ userId, authorName: `Name ${userId}` })),
    fetched: ids.length,
    invalid: 0,
    duplicates: 0,
    complete: true,
    fatalReason: null,
    requestFailures: 0,
    ...overrides,
  };
}

function createHarness(options: {
  readonly voterResult?: VoterFetchResult;
  readonly currentUserResult?: { readonly status: "success"; readonly userId: string } | { readonly status: "failed"; readonly reason: "invalid-response" };
  readonly remoteBlocked?: readonly string[];
  readonly localBlocked?: readonly string[];
  readonly hasAuthorization?: boolean;
  readonly block?: (
    request: UserBlockRequest,
    isStopped: () => boolean,
  ) => Promise<CoordinatedBlockResult>;
} = {}) {
  const progress: VoterBatchProgress[] = [];
  let voterFetches = 0;
  let relationFetches = 0;
  const localState = {
    ...createInitialState(),
    authors: (options.localBlocked ?? []).map((userId) => ({
      userId,
      memberHashId: null,
      authorNameAtCapture: `Existing ${userId}`,
      tagId: "default",
      blacklistedAt: "2026-08-13T12:34:56.789Z",
      blockSource: "direct" as const,
    })),
  };
  const coordinator: RemoteBlockCoordinator = {
    async block(request, isStopped = () => false) {
      return options.block?.(request, isStopped) ?? {
        status: "success",
        persistedUpvoter: true,
      };
    },
  };
  const controller = createVoterBatchController({
    hasBlockAuthorization() {
      return options.hasAuthorization ?? true;
    },
    async fetchCurrentUser() {
      return options.currentUserResult ?? {
        status: "success",
        userId: "current-user",
      };
    },
    async fetchBlockedUsers() {
      relationFetches += 1;
      return {
        userIds: new Set(options.remoteBlocked ?? []),
        complete: true,
        fatalReason: null,
      };
    },
    async fetchVoters(_source, _isStopped, onProgress) {
      voterFetches += 1;
      const result = options.voterResult ?? voters([]);
      onProgress({
        fetched: result.fetched,
        unique: result.users.length,
        complete: result.complete,
      });
      return result;
    },
    async readState() {
      return parseBlacklistState(localState);
    },
    coordinator,
    reportMalformedStorage() {},
    reportProgress(value) {
      progress.push(value);
    },
  });

  return {
    controller,
    progress,
    counts: () => ({ voterFetches, relationFetches }),
  };
}

const source = { kind: "answer", questionId: "1", contentId: "2" } as const;

test("VOTER-013 missing CSRF automatically fails before relation, voter-list, or POST work", async () => {
  let blocks = 0;
  const harness = createHarness({
    hasAuthorization: false,
    voterResult: voters(["one"]),
    async block() {
      blocks += 1;
      return { status: "success", persistedUpvoter: true };
    },
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  strictEqual(result.phase, "failed");
  deepStrictEqual(harness.counts(), { voterFetches: 0, relationFetches: 0 });
  strictEqual(blocks, 0);
});

test("VOTER-005/SOURCE-005 filters current, direct, remote, and local users before POST", async () => {
  const blocked: string[] = [];
  const harness = createHarness({
    voterResult: voters(
      ["current-user", "direct-author", "remote", "local", "eligible"],
      { fetched: 7, invalid: 1, duplicates: 1 },
    ),
    remoteBlocked: ["remote"],
    localBlocked: ["local"],
    async block(request) {
      blocked.push(request.userId);
      return { status: "success", persistedUpvoter: true };
    },
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "direct-author",
    isStopped: () => false,
  });

  deepStrictEqual(blocked, ["eligible"]);
  deepStrictEqual(result, {
    phase: "complete",
    fetched: 5,
    success: 1,
    failed: 0,
    skipped: 6,
    unprocessed: 0,
    dataComplete: true,
  });
});

test("VOTER-012 internal progress uses unique valid voters while skipped keeps invalid and duplicates", async () => {
  const harness = createHarness({
    voterResult: voters(["one", "two", "three"], {
      fetched: 5,
      invalid: 1,
      duplicates: 1,
    }),
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  deepStrictEqual(result, {
    phase: "complete",
    fetched: 3,
    success: 3,
    failed: 0,
    skipped: 2,
    unprocessed: 0,
    dataComplete: true,
  });
  strictEqual(
    harness.progress.some(
      (progress) => progress.phase === "fetching" && progress.fetched === 3,
    ),
    true,
  );
  strictEqual(
    harness.progress.some((progress) => progress.fetched === 5),
    false,
  );
});

test("VOTER-005 fails closed before list fetching when current user cannot be confirmed", async () => {
  const harness = createHarness({
    currentUserResult: { status: "failed", reason: "invalid-response" },
    voterResult: voters(["eligible"]),
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  strictEqual(result.phase, "failed");
  deepStrictEqual(harness.counts(), { voterFetches: 0, relationFetches: 0 });
});

test("VOTER-013 ordinary per-user failures do not interrupt remaining users", async () => {
  const calls: string[] = [];
  const harness = createHarness({
    voterResult: voters(["one", "two", "three", "four"]),
    async block(request) {
      calls.push(request.userId);
      return request.userId === "two"
        ? { status: "failed", reason: "http" }
        : { status: "success", persistedUpvoter: true };
    },
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  strictEqual(calls.length, 4);
  strictEqual(result.phase, "complete");
  strictEqual(result.success, 3);
  strictEqual(result.failed, 1);
  strictEqual(result.unprocessed, 0);
});

test("VOTER-009/013 keeps POST concurrency at three", async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const harness = createHarness({
    voterResult: voters(["1", "2", "3", "4", "5", "6"]),
    async block() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
      return { status: "success", persistedUpvoter: true };
    },
  });
  const running = harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });
  while (releases.length < 3) {
    await Promise.resolve();
  }
  strictEqual(maxActive, 3);
  while (releases.length > 0) {
    releases.shift()?.();
    await Promise.resolve();
  }
  const result = await running;
  strictEqual(result.success, 6);
  strictEqual(maxActive, 3);
});

test("VOTER-012/013 authentication failure stops new work and preserves internal counts", async () => {
  let calls = 0;
  const harness = createHarness({
    voterResult: voters(Array.from({ length: 10 }, (_, index) => `user-${index}`)),
    async block() {
      calls += 1;
      return calls === 1
        ? { status: "failed", reason: "authentication" }
        : { status: "success", persistedUpvoter: true };
    },
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  strictEqual(result.phase, "failed");
  strictEqual(calls <= 3, true);
  strictEqual(result.failed, 1);
  strictEqual(
    result.success + result.failed + result.skipped + result.unprocessed,
    result.fetched,
  );
});

test("VOTER-013 lifecycle stop prevents new scheduling and reports unprocessed users", async () => {
  let stopped = false;
  let calls = 0;
  const harness = createHarness({
    voterResult: voters(["one", "two", "three", "four", "five"]),
    async block() {
      calls += 1;
      stopped = true;
      return { status: "success", persistedUpvoter: true };
    },
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => stopped,
  });

  strictEqual(result.phase, "stopped");
  strictEqual(calls <= 3, true);
  strictEqual(result.unprocessed, result.fetched - result.success);
});

test("VOTER-012 carries partial completeness into the final internal progress", async () => {
  const harness = createHarness({
    voterResult: voters(["one"], { complete: false, requestFailures: 1 }),
  });
  const result = await harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "author",
    isStopped: () => false,
  });

  strictEqual(result.phase, "complete");
  strictEqual(result.dataComplete, false);
  strictEqual(harness.progress.at(-1)?.dataComplete, false);
});
