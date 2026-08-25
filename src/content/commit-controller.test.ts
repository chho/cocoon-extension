import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  planAuthorCommit,
  type BlacklistState,
  type CommitInput,
} from "./blacklist-state.ts";
import { createCommitController } from "./commit-controller.ts";
import type { CommitTask, TagSelection } from "./drawer-controller.ts";

const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const TIMESTAMP = "2026-08-13T12:34:56.789Z";

interface TestCard {
  readonly id: string;
}
interface TestButton {
  readonly id: string;
}

function createExclusiveLock() {
  let locked = false;
  const waiters: Array<() => void> = [];
  return async function withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    if (locked) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    locked = true;
    try {
      return await operation();
    } finally {
      locked = false;
      waiters.shift()?.();
    }
  };
}

function task(
  id: string,
  selection?: TagSelection,
  identity: { profileUserIdAtClick?: string | null; memberHashIdAtClick?: string | null } = {},
): CommitTask<TestCard, TestButton> {
  const initial = createInitialState();
  return {
    target: {
      targetId: id,
      card: { id },
      button: { id: `button-${id}` },
      authorNameAtClick: `author-${id}`,
      profileUserIdAtClick: identity.profileUserIdAtClick ?? `stable-${id}`,
      memberHashIdAtClick: identity.memberHashIdAtClick ?? null,
      anchorBounds: null,
      voterSource: null,
    },
    selection: selection ?? { tag: initial.tags[0]!, isNewTag: false },
    remoteAuthorization: {
      blockAuthorOnZhihu: false,
      blockContentVoters: false,
    },
  };
}

function createHarness(options: { readonly failUserId?: string } = {}) {
  let storedState: BlacklistState = createInitialState();
  let runtimeState = storedState;
  const focusedButtons: string[] = [];
  const failures: unknown[] = [];
  let writes = 0;
  let applies = 0;
  let clockCalls = 0;

  let revision = 0;
  const withExclusiveLock = createExclusiveLock();
  const controller = createCommitController<TestCard, TestButton>({
    async resolveAuthorIdentity(target) {
      const userId = target.profileUserIdAtClick;
      return userId ? { userId, memberHashId: target.memberHashIdAtClick } : null;
    },
    now() {
      clockCalls += 1;
      return new Date(TIMESTAMP);
    },
    async commitAuthor(input: CommitInput) {
      return withExclusiveLock(async () => {
        const before = storedState;
        const plan = planAuthorCommit(before, input);
        const context = {
          baseRevision: revision,
          revision,
          authorCount: before.authors.length,
          tagCount: before.tags.length,
        };
        if (plan.status === "invalid") {
          return { status: "invalid" as const, author: null, tag: null, ...context };
        }
        const author = plan.state.authors.find(
          (candidate) =>
            candidate.platformId === input.platformId && candidate.userId === input.userId,
        );
        if (!author) throw new Error("targeted commit did not return its author");
        if (plan.status === "duplicate") {
          applies += 1;
          return { status: "duplicate" as const, author, tag: null, ...context };
        }
        writes += 1;
        if (input.userId === options.failUserId) throw new Error("write failed");
        storedState = plan.state;
        runtimeState = plan.state;
        applies += 1;
        revision += 1;
        return {
          status: plan.status === "ready" ? ("persisted" as const) : ("duplicate" as const),
          author,
          tag: plan.status === "ready" && input.isNewTag ? input.tag : null,
          baseRevision: context.baseRevision,
          revision,
          authorCount: storedState.authors.length,
          tagCount: storedState.tags.length,
        };
      });
    },
    requestFailureFocus(button) {
      focusedButtons.push(button.id);
    },
    reportFailure(error) {
      failures.push(error);
    },
  });

  return {
    controller,
    setStoredState(state: BlacklistState) {
      storedState = state;
      runtimeState = state;
    },
    storedState: () => storedState,
    runtimeState: () => runtimeState,
    counts: () => ({ writes, applies, clockCalls }),
    focusedButtons,
    failures,
  };
}

test("CAP-007 concurrent duplicate commits perform one image-free write", async () => {
  const harness = createHarness();
  const duplicateTask = task("duplicate", undefined, {
    memberHashIdAtClick: HASH_A,
  });
  const results = await Promise.all([
    harness.controller.commit(duplicateTask),
    harness.controller.commit(duplicateTask),
  ]);
  deepStrictEqual(
    results.map((result) => result.status),
    ["persisted", "duplicate"],
  );
  deepStrictEqual(harness.counts(), { writes: 1, applies: 2, clockCalls: 2 });
  deepStrictEqual(harness.storedState().authors[0], {
    platformId: "zhihu",
    userId: "stable-duplicate",
    memberHashId: HASH_A,
    authorNameAtCapture: "author-duplicate",
    tagId: "default",
    blacklistedAt: TIMESTAMP,
    blockSource: "direct",
  });
});

test("ERR-001 one failed storage write leaves runtime unchanged and later work continues", async () => {
  const harness = createHarness({ failUserId: "stable-failing" });
  const failed = await harness.controller.commit(task("failing"));
  const succeeded = await harness.controller.commit(task("succeeding"));
  strictEqual(failed.status, "failed");
  strictEqual(succeeded.status, "persisted");
  deepStrictEqual(harness.focusedButtons, ["button-failing"]);
  deepStrictEqual(
    harness.runtimeState().authors.map((value) => value.userId),
    ["stable-succeeding"],
  );
  strictEqual(harness.failures.length, 1);
  deepStrictEqual(harness.counts(), { writes: 2, applies: 1, clockCalls: 2 });
});

test("serialized commits preserve distinct newly created tags", async () => {
  const harness = createHarness();
  const firstSelection = {
    tag: { tagId: "tag-first", name: "First" },
    isNewTag: true,
  } as const;
  const secondSelection = {
    tag: { tagId: "tag-second", name: "Second" },
    isNewTag: true,
  } as const;
  const results = await Promise.all([
    harness.controller.commit(task("first", firstSelection)),
    harness.controller.commit(task("second", secondSelection)),
  ]);
  deepStrictEqual(
    results.map((result) => result.status),
    ["persisted", "persisted"],
  );
  deepStrictEqual(
    harness.storedState().tags.map((tag) => tag.tagId),
    ["default", "tag-first", "tag-second"],
  );
});

test("BUG-008 exact duplicate backfills a proven hash in one atomic write without changing first fields", async () => {
  const harness = createHarness();
  const initial = createInitialState();
  const existing: BlacklistState = {
    ...initial,
    authors: [
      {
        platformId: "zhihu",
        userId: "stable-existing",
        memberHashId: null,
        authorNameAtCapture: "First name",
        tagId: "default",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  harness.setStoredState(existing);
  const result = await harness.controller.commit(
    task("ignored", undefined, {
      profileUserIdAtClick: "stable-existing",
      memberHashIdAtClick: HASH_A,
    }),
  );
  strictEqual(result.status, "duplicate");
  deepStrictEqual(harness.storedState().authors[0], {
    ...existing.authors[0],
    memberHashId: HASH_A,
  });
  deepStrictEqual(harness.counts(), { writes: 1, applies: 1, clockCalls: 1 });
});

test("BUG-008 duplicate alias conflict fails with no write or runtime mutation", async () => {
  const harness = createHarness();
  const initial = createInitialState();
  const existing: BlacklistState = {
    ...initial,
    authors: [
      {
        platformId: "zhihu",
        userId: "stable-existing",
        memberHashId: null,
        authorNameAtCapture: "Existing",
        tagId: "default",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
      {
        platformId: "zhihu",
        userId: "other",
        memberHashId: HASH_B,
        authorNameAtCapture: "Other",
        tagId: "default",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  harness.setStoredState(existing);
  const result = await harness.controller.commit(
    task("ignored", undefined, {
      profileUserIdAtClick: "stable-existing",
      memberHashIdAtClick: HASH_B,
    }),
  );
  strictEqual(result.status, "failed");
  strictEqual(harness.storedState(), existing);
  deepStrictEqual(harness.counts(), { writes: 0, applies: 0, clockCalls: 1 });
});

test("hover and card identities are committed exactly as proven by the identity resolver", async () => {
  const harness = createHarness();
  const result = await harness.controller.commit(
    task("hover", undefined, {
      profileUserIdAtClick: "canonical-hover",
      memberHashIdAtClick: null,
    }),
  );
  strictEqual(result.status, "persisted");
  strictEqual(harness.storedState().authors[0]?.userId, "canonical-hover");
  strictEqual(harness.storedState().authors[0]?.memberHashId, null);
});
