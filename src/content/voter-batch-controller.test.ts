import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState, type BlacklistState } from "./blacklist-state.ts";
import type {
  CoordinatedBlockResult,
  RemoteBlockCoordinator,
  UserBlockRequest,
} from "./remote-block-coordinator.ts";
import type { VoterFetchResult } from "./zhihu-remote-api.ts";
import { createVoterBatchController, type VoterBatchProgress } from "./voter-batch-controller.ts";

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

function createHarness(
  options: {
    readonly voterResult?: VoterFetchResult;
    readonly currentUserResult?:
      | { readonly status: "success"; readonly userId: string }
      | { readonly status: "failed"; readonly reason: "invalid-response" };
    readonly localBlocked?: readonly string[];
    readonly localAuthors?: BlacklistState["authors"];
    readonly block?: (
      request: UserBlockRequest,
      isStopped: () => boolean,
    ) => Promise<CoordinatedBlockResult>;
  } = {},
) {
  const progress: VoterBatchProgress[] = [];
  const requests: UserBlockRequest[] = [];
  let currentUserFetches = 0;
  let voterFetches = 0;
  const localState = {
    ...createInitialState(),
    authors:
      options.localAuthors ??
      (options.localBlocked ?? []).map((userId) => ({
        platformId: "zhihu",
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
      requests.push(request);
      if (options.block) return options.block(request, isStopped);
      const alreadyBlocked = localState.authors.some(
        (author) => author.platformId === "zhihu" && author.userId === request.userId,
      );
      return alreadyBlocked
        ? { status: "skipped", reason: "existing" }
        : { status: "success", persistedUpvoter: true };
    },
  };
  const controller = createVoterBatchController({
    async fetchCurrentUser() {
      currentUserFetches += 1;
      return (
        options.currentUserResult ?? {
          status: "success",
          userId: "current-user",
        }
      );
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
    coordinator,
    reportProgress(value) {
      progress.push(value);
    },
  });

  return {
    controller,
    progress,
    requests,
    counts: () => ({ currentUserFetches, voterFetches }),
  };
}

const source = { kind: "answer", questionId: "1", contentId: "2" } as const;

async function runBatch(
  harness: ReturnType<typeof createHarness>,
  isStopped: () => boolean = () => false,
): Promise<VoterBatchProgress> {
  return harness.controller.run({
    source,
    tagId: "default",
    directAuthorUserId: "direct-author",
    isStopped,
  });
}

test("VOTER-014 runs without CSRF authorization or a Zhihu blocked-user relationship GET", async () => {
  const harness = createHarness({
    voterResult: voters(["already-blocked-at-zhihu"]),
  });

  const result = await runBatch(harness);

  deepStrictEqual(harness.counts(), { currentUserFetches: 1, voterFetches: 1 });
  deepStrictEqual(harness.requests, [
    {
      source: "upvoter",
      userId: "already-blocked-at-zhihu",
      authorName: "Name already-blocked-at-zhihu",
      tagId: "default",
    },
  ]);
  strictEqual(result.success, 1);
  strictEqual(
    harness.progress.some((entry) => entry.phase === "persisting"),
    true,
  );
});

test("VOTER-014 skips current user, direct author, and local records while persisting eligible users", async () => {
  const harness = createHarness({
    voterResult: voters(["current-user", "direct-author", "local", "eligible"], {
      fetched: 6,
      invalid: 1,
      duplicates: 1,
    }),
    localBlocked: ["local"],
  });

  const result = await runBatch(harness);

  deepStrictEqual(
    harness.requests.map((request) => request.userId),
    ["local", "eligible"],
  );
  deepStrictEqual(result, {
    phase: "complete",
    fetched: 4,
    success: 1,
    failed: 0,
    skipped: 5,
    unprocessed: 0,
    dataComplete: true,
  });
});

test("PLATFORM-001 non-Zhihu records do not enter Zhihu voter dedupe sets", async () => {
  const harness = createHarness({
    voterResult: voters(["shared", "zhihu-blocked"]),
    localAuthors: [
      {
        platformId: "youtube",
        userId: "shared",
        memberHashId: null,
        authorNameAtCapture: "YouTube shared",
        tagId: "default",
        blacklistedAt: "2026-08-13T12:34:56.789Z",
        blockSource: "direct",
      },
      {
        platformId: "zhihu",
        userId: "zhihu-blocked",
        memberHashId: null,
        authorNameAtCapture: "Zhihu blocked",
        tagId: "default",
        blacklistedAt: "2026-08-13T12:34:56.789Z",
        blockSource: "direct",
      },
    ],
  });

  const result = await runBatch(harness);

  deepStrictEqual(
    harness.requests.map(({ userId }) => userId),
    ["shared", "zhihu-blocked"],
  );
  strictEqual(result.success, 1);
  strictEqual(result.skipped, 1);
});

test("VOTER-014 counts a coordinator race as skipped instead of successful", async () => {
  const harness = createHarness({
    voterResult: voters(["race-user", "new-user"]),
    async block(request) {
      return request.userId === "race-user"
        ? { status: "skipped", reason: "existing" }
        : { status: "success", persistedUpvoter: true };
    },
  });

  const result = await runBatch(harness);

  strictEqual(result.success, 1);
  strictEqual(result.skipped, 1);
  strictEqual(result.failed, 0);
});

test("VOTER-014 storage failure is counted failed and other local writes continue", async () => {
  const calls: string[] = [];
  const harness = createHarness({
    voterResult: voters(["one", "two", "three", "four"]),
    async block(request) {
      calls.push(request.userId);
      return request.userId === "two"
        ? { status: "failed", reason: "storage" }
        : { status: "success", persistedUpvoter: true };
    },
  });

  const result = await runBatch(harness);

  strictEqual(calls.length, 4);
  strictEqual(result.phase, "complete");
  strictEqual(result.success, 3);
  strictEqual(result.failed, 1);
  strictEqual(result.unprocessed, 0);
});

test("VOTER-014 fails closed before the voter list when current user cannot be confirmed", async () => {
  const harness = createHarness({
    currentUserResult: { status: "failed", reason: "invalid-response" },
    voterResult: voters(["eligible"]),
  });

  const result = await runBatch(harness);

  strictEqual(result.phase, "failed");
  deepStrictEqual(harness.counts(), { currentUserFetches: 1, voterFetches: 0 });
  strictEqual(harness.requests.length, 0);
});

test("VOTER-014 keeps local persistence worker concurrency at three", async () => {
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

  const running = runBatch(harness);
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

test("VOTER-014 lifecycle stop prevents new scheduling and reports unprocessed users", async () => {
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

  const result = await runBatch(harness, () => stopped);

  strictEqual(result.phase, "stopped");
  strictEqual(calls <= 3, true);
  strictEqual(result.unprocessed, result.fetched - result.success);
});

test("VOTER-014 retains partial voter-list completeness in final internal progress", async () => {
  const harness = createHarness({
    voterResult: voters(["one"], { complete: false, requestFailures: 1 }),
  });

  const result = await runBatch(harness);

  strictEqual(result.phase, "complete");
  strictEqual(result.dataComplete, false);
  strictEqual(harness.progress.at(-1)?.dataComplete, false);
});
