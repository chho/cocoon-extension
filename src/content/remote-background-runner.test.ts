import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createInitialState } from "./blacklist-state.ts";
import type { CommitTask } from "./drawer-controller.ts";
import { createRemoteBackgroundRunner } from "./remote-background-runner.ts";

const source = { kind: "answer", questionId: "1", contentId: "2" } as const;

function task(): CommitTask<string, string> {
  return {
    target: {
      targetId: "card",
      card: "card",
      button: "button",
      authorNameAtClick: "Author",
      profileUserIdAtClick: null,
      memberHashIdAtClick: null,
      anchorBounds: null,
      voterSource: source,
    },
    selection: {
      tag: createInitialState().tags[0],
      isNewTag: false,
    },
    remoteAuthorization: {
      blockAuthorOnZhihu: true,
      blockContentVoters: true,
    },
  };
}

const committed = {
  status: "persisted",
  state: createInitialState(),
  userId: "stable-author",
  blacklistedAt: "2026-08-14T00:00:00.000Z",
} as const;

test("UI-007/VOTER-014 runs the author remote job and voter local job without progress, toast, or stop UI", async () => {
  const dom = new JSDOM("<!doctype html><body><main>feed</main></body>");
  const before = dom.window.document.body.innerHTML;
  const calls: string[] = [];
  const runner = createRemoteBackgroundRunner<string, string>({
    async blockAuthor() {
      calls.push("author");
      return { status: "success", persistedUpvoter: false };
    },
    async blockVoters() {
      calls.push("voters");
      return {
        phase: "complete",
        fetched: 2,
        success: 1,
        failed: 0,
        skipped: 1,
        unprocessed: 0,
        dataComplete: true,
      };
    },
    reportFailure() {
      throw new Error("Successful background work must not report a failure.");
    },
  });

  const run = runner.run(task(), committed);
  deepStrictEqual(run.dispatch, { authorStarted: true, votersStarted: true });
  strictEqual("stop" in run, false);
  const result = await run.completion;

  deepStrictEqual(calls, ["author", "voters"]);
  deepStrictEqual(result, {
    author: { status: "success", persistedUpvoter: false },
    voters: {
      phase: "complete",
      fetched: 2,
      success: 1,
      failed: 0,
      skipped: 1,
      unprocessed: 0,
      dataComplete: true,
    },
  });
  strictEqual(dom.window.document.body.innerHTML, before);
  strictEqual(dom.window.document.querySelector("[class*=remote-progress]"), null);
});

test("UI-008/VOTER-014 reports scoped local voter failure while preserving internal batch result", async () => {
  const failures: string[] = [];
  const runner = createRemoteBackgroundRunner<string, string>({
    async blockAuthor() {
      return { status: "failed", reason: "authentication" };
    },
    async blockVoters() {
      return {
        phase: "complete",
        fetched: 4,
        success: 1,
        failed: 1,
        skipped: 2,
        unprocessed: 0,
        dataComplete: true,
      };
    },
    reportFailure(scope) {
      failures.push(scope);
    },
  });

  const result = await runner.run(task(), committed).completion;
  deepStrictEqual(failures, ["author", "voters"]);
  deepStrictEqual(result.voters, {
    phase: "complete",
    fetched: 4,
    success: 1,
    failed: 1,
    skipped: 2,
    unprocessed: 0,
    dataComplete: true,
  });
});

test("HOVER-007/AC-056 never dispatches voter work without a content source", async () => {
  const baseTask = task();
  const hoverTask: CommitTask<string, string> = {
    ...baseTask,
    target: {
      ...baseTask.target,
      profileUserIdAtClick: "stable-hover-author",
      memberHashIdAtClick: null,
      voterSource: null,
    },
  };
  let authorCalls = 0;
  let voterCalls = 0;
  const runner = createRemoteBackgroundRunner<string, string>({
    async blockAuthor() {
      authorCalls += 1;
      return { status: "success", persistedUpvoter: false };
    },
    async blockVoters() {
      voterCalls += 1;
      throw new Error("Hover targets must not request voters.");
    },
    reportFailure() {
      throw new Error("The valid author operation must not fail.");
    },
  });

  const run = runner.run(hoverTask, committed);
  deepStrictEqual(run.dispatch, { authorStarted: true, votersStarted: false });
  await run.completion;
  strictEqual(authorCalls, 1);
  strictEqual(voterCalls, 0);
});
