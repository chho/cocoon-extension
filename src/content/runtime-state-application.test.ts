import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createInitialState, planAuthorCommit, type BlacklistState } from "./blacklist-state.ts";
import {
  COMMENT_HIDDEN_CLASS,
  createCommentFilterController,
} from "./comment-filter-controller.ts";
import { createCommitController } from "./commit-controller.ts";
import type { CommitTask } from "./drawer-controller.ts";
import { applyBlacklistRuntimeState } from "./runtime-state-application.ts";

function createFrames() {
  const frames: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      frames.push(callback);
    },
    flush() {
      while (frames.length > 0) {
        frames.shift()?.();
      }
    },
  };
}

function createScheduledCommentFilter() {
  const frames = createFrames();
  return {
    frames,
    commentFilter: createCommentFilterController({ schedule: frames.schedule }),
  };
}

test("BUG-003/AC-066 hover commit applies state through a full connected-comment refresh", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="Comments-container">
      <div data-id="existing-comment" id="existing-comment">
        <a href="/people/comment-author">Comment author</a>
      </div>
    </div>
    <div id="hover-card"></div>
    <button id="hover-button" type="button">屏蔽</button>
  </body>`);
  const { frames, commentFilter } = createScheduledCommentFilter();
  const comment = dom.window.document.querySelector<HTMLElement>("#existing-comment");
  const hoverCard = dom.window.document.querySelector<HTMLElement>("#hover-card");
  const hoverButton = dom.window.document.querySelector<HTMLButtonElement>("#hover-button");
  if (!comment || !hoverCard || !hoverButton) {
    throw new Error("Missing runtime application fixture.");
  }

  let storedState: BlacklistState = createInitialState();
  let runtimeState: BlacklistState = createInitialState();
  let renderCount = 0;
  const cardFilterUpdates: ReadonlySet<string>[] = [];
  const commitController = createCommitController<HTMLElement, HTMLButtonElement>({
    async resolveAuthorIdentity(target) {
      return {
        platformId: "zhihu",
        userId: target.profileUserIdAtClick ?? "",
        memberHashId: target.memberHashIdAtClick,
      };
    },
    now: () => new Date("2026-08-14T12:00:00.000Z"),
    async commitAuthor(input) {
      const previous = storedState;
      const plan = planAuthorCommit(previous, input);
      if (plan.status !== "ready") {
        throw new Error("Expected a new author plan.");
      }
      storedState = plan.state;
      applyBlacklistRuntimeState(plan.state, dom.window.document.body, {
        setCurrentState(nextState) {
          runtimeState = nextState;
        },
        renderTagChoices() {
          strictEqual(runtimeState, plan.state);
          renderCount += 1;
        },
        cardFilter: {
          loadStableUserIds(userIds) {
            cardFilterUpdates.push(new Set(userIds));
          },
        },
        commentFilter,
      });
      return {
        status: "persisted",
        author: plan.state.authors.at(-1)!,
        tag: null,
        baseRevision: 0,
        revision: 1,
        authorCount: plan.state.authors.length,
        tagCount: plan.state.tags.length,
      };
    },
    requestFailureFocus() {},
    reportFailure(error) {
      throw error;
    },
  });
  const task: CommitTask<HTMLElement, HTMLButtonElement> = {
    target: {
      targetId: "hover-target",
      card: hoverCard,
      button: hoverButton,
      authorNameAtClick: "Comment author",
      profileUserIdAtClick: "comment-author",
      memberHashIdAtClick: null,
      anchorBounds: null,
      voterSource: null,
    },
    selection: {
      tag: storedState.tags[0],
      isNewTag: false,
    },
    remoteAuthorization: {
      blockAuthorOnZhihu: false,
      blockContentVoters: false,
    },
  };

  const result = await commitController.commit(task);

  strictEqual(result.status, "persisted");
  strictEqual(renderCount, 1);
  strictEqual(runtimeState.authors[0]?.userId, "comment-author");
  deepStrictEqual([...(cardFilterUpdates[0] ?? [])], ["comment-author"]);
  strictEqual(comment.classList.contains(COMMENT_HIDDEN_CLASS), false);

  frames.flush();
  strictEqual(comment.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(comment.isConnected, true);
});

test("PLATFORM-001 applies only Zhihu stable IDs and aliases to both card and comment filters", () => {
  const hash = "a".repeat(32);
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [
      {
        platformId: "youtube",
        userId: "shared",
        memberHashId: null,
        authorNameAtCapture: "YouTube",
        tagId: "default",
        blacklistedAt: "2026-08-14T12:00:00.000Z",
        blockSource: "direct",
      },
      {
        platformId: "unknown-site",
        userId: hash,
        memberHashId: null,
        authorNameAtCapture: "Unknown",
        tagId: "default",
        blacklistedAt: "2026-08-14T12:00:00.000Z",
        blockSource: "direct",
      },
      {
        platformId: "zhihu",
        userId: "shared",
        memberHashId: hash,
        authorNameAtCapture: "Zhihu",
        tagId: "default",
        blacklistedAt: "2026-08-14T12:00:00.000Z",
        blockSource: "direct",
      },
    ],
  };
  const cardSets: ReadonlySet<string>[] = [];
  const commentSets: ReadonlySet<string>[] = [];
  const root = {} as Node;

  applyBlacklistRuntimeState(state, root, {
    setCurrentState() {},
    renderTagChoices() {},
    cardFilter: {
      loadStableUserIds(ids) {
        cardSets.push(new Set(ids));
      },
    },
    commentFilter: {
      refreshStableUserIds(ids, receivedRoot) {
        strictEqual(receivedRoot, root);
        commentSets.push(new Set(ids));
      },
    },
  });

  deepStrictEqual([...(cardSets[0] ?? [])], ["shared", hash]);
  deepStrictEqual([...(commentSets[0] ?? [])], ["shared", hash]);
});

test("BUG-004/AC-068 duplicate hover commit reapplies persisted IDs and refreshes current, retained, and replacement comments without side effects", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="Comments-container" id="comments">
      <div data-id="current-comment" id="current-comment">
        <a href="/people/trigger-author-a">Sanitized Author</a>
      </div>
    </div>
    <div id="hover-card"></div>
    <button id="hover-button" type="button">屏蔽</button>
  </body>`);
  const { frames, commentFilter } = createScheduledCommentFilter();
  const initialState = createInitialState();
  const storedState: BlacklistState = {
    ...initialState,
    authors: [
      {
        platformId: "zhihu",
        userId: "trigger-author-a",
        memberHashId: null,
        authorNameAtCapture: "Original Sanitized Name",
        tagId: initialState.tags[0]!.tagId,
        blacklistedAt: "2026-08-14T11:00:00.000Z",
        blockSource: "direct",
      },
    ],
  };
  const persistedSnapshot = structuredClone(storedState);
  const currentComment = dom.window.document.querySelector<HTMLElement>("#current-comment");
  const comments = dom.window.document.querySelector<HTMLElement>("#comments");
  const hoverCard = dom.window.document.querySelector<HTMLElement>("#hover-card");
  const hoverButton = dom.window.document.querySelector<HTMLButtonElement>("#hover-button");
  if (!currentComment || !comments || !hoverCard || !hoverButton) {
    throw new Error("Missing duplicate runtime fixture.");
  }

  const writes = 0;
  let clockCalls = 0;
  let appliedStates = 0;
  const commitController = createCommitController<HTMLElement, HTMLButtonElement>({
    async resolveAuthorIdentity(target) {
      return {
        platformId: "zhihu",
        userId: target.profileUserIdAtClick ?? "",
        memberHashId: target.memberHashIdAtClick,
      };
    },
    now() {
      clockCalls += 1;
      return new Date("2026-08-14T12:00:00.000Z");
    },
    async commitAuthor(input) {
      const plan = planAuthorCommit(storedState, input);
      if (plan.status !== "duplicate") {
        throw new Error("Expected a duplicate author plan.");
      }
      appliedStates += 1;
      applyBlacklistRuntimeState(plan.state, dom.window.document.body, {
        setCurrentState() {},
        renderTagChoices() {},
        cardFilter: {
          loadStableUserIds() {},
        },
        commentFilter,
      });
      return {
        status: "duplicate",
        author: storedState.authors[0]!,
        tag: null,
        baseRevision: 1,
        revision: 1,
        authorCount: storedState.authors.length,
        tagCount: storedState.tags.length,
      };
    },
    requestFailureFocus() {},
    reportFailure(error) {
      throw error;
    },
  });
  const task: CommitTask<HTMLElement, HTMLButtonElement> = {
    target: {
      targetId: "duplicate-hover-target",
      card: hoverCard,
      button: hoverButton,
      authorNameAtClick: "Different Sanitized Name",
      profileUserIdAtClick: "trigger-author-a",
      memberHashIdAtClick: null,
      anchorBounds: null,
      voterSource: null,
    },
    selection: {
      tag: storedState.tags[0]!,
      isNewTag: false,
    },
    remoteAuthorization: {
      blockAuthorOnZhihu: true,
      blockContentVoters: false,
    },
  };

  const result = await commitController.commit(task);

  strictEqual(result.status, "duplicate");
  strictEqual(writes, 0);
  strictEqual(clockCalls, 1);
  strictEqual(appliedStates, 1);
  deepStrictEqual(storedState, persistedSnapshot);
  strictEqual(currentComment.classList.contains(COMMENT_HIDDEN_CLASS), false);

  frames.flush();
  strictEqual(currentComment.classList.contains(COMMENT_HIDDEN_CLASS), true);
  comments.hidden = true;
  comments.hidden = false;
  strictEqual(currentComment.classList.contains(COMMENT_HIDDEN_CLASS), true);

  const replacement = dom.window.document.createElement("div");
  replacement.dataset.id = "replacement-comment";
  replacement.innerHTML = '<a href="/people/trigger-author-a">Replacement</a>';
  currentComment.replaceWith(replacement);
  commentFilter.scan(replacement);
  frames.flush();
  strictEqual(replacement.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(replacement.isConnected, true);
});
