import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState } from "./blacklist-state.ts";
import { createMeasuredCommitController } from "./commit-performance.ts";
import type { CommitTask } from "./drawer-controller.ts";

const TIMESTAMP = "2026-08-24T12:34:56.789Z";

const task: CommitTask<{ readonly id: string }, { readonly id: string }> = {
  target: {
    targetId: "target",
    card: { id: "card" },
    button: { id: "button" },
    authorNameAtClick: "Synthetic author",
    profileUserIdAtClick: "synthetic-user",
    memberHashIdAtClick: null,
    anchorBounds: null,
    voterSource: null,
  },
  selection: {
    tag: { tagId: "default", name: "default" },
    isNewTag: false,
  },
  remoteAuthorization: {
    blockAuthorOnZhihu: false,
    blockContentVoters: false,
  },
};

test("reports one phase summary without author identity data", async () => {
  let elapsedMs = 0;
  const initialState = createInitialState();
  const reports: unknown[] = [];
  const controller = createMeasuredCommitController(
    {
      async resolveAuthorIdentity() {
        elapsedMs += 2;
        return { userId: "synthetic-user", memberHashId: null };
      },
      now: () => new Date(TIMESTAMP),
      async commitAuthor(input) {
        elapsedMs += 18;
        return {
          status: "persisted" as const,
          author: {
            platformId: input.platformId,
            userId: input.userId,
            memberHashId: input.memberHashId,
            authorNameAtCapture: input.authorNameAtCapture,
            tagId: input.tag.tagId,
            blacklistedAt: input.blacklistedAt,
            blockSource: "direct" as const,
          },
          tag: null,
          baseRevision: 0,
          revision: 1,
          authorCount: 1,
          tagCount: initialState.tags.length,
        };
      },
      requestFailureFocus() {},
      reportFailure() {},
    },
    {
      now: () => elapsedMs,
      report(summary) {
        reports.push(summary);
      },
    },
  );

  const result = await controller.commit(task);

  strictEqual(result.status, "persisted");
  deepStrictEqual(reports, [
    {
      status: "persisted",
      totalMs: 20,
      identityMs: 2,
      lockWaitMs: 0,
      readMs: 0,
      writeMs: 18,
      applyMs: 0,
      otherMs: 0,
      authorCount: 1,
      tagCount: 1,
    },
  ]);
});
