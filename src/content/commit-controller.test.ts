import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  parseBlacklistState,
  type BlacklistState,
} from "./blacklist-state.ts";
import { createCommitController } from "./commit-controller.ts";
import type { CommitTask, TagSelection } from "./drawer-controller.ts";

interface TestCard {
  readonly id: string;
  readonly stableUserId: string;
  readonly captureFails?: boolean;
  readonly hasInjectedCloseButton: boolean;
}

interface TestButton {
  readonly id: string;
}

function createExclusiveLock() {
  let locked = false;
  const waiters: Array<() => void> = [];

  return async function withExclusiveLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (locked) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
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
  overrides: Partial<TestCard> = {},
): CommitTask<TestCard, TestButton> {
  const initial = createInitialState();
  return {
    target: {
      targetId: id,
      card: {
        id,
        stableUserId: `stable-${id}`,
        hasInjectedCloseButton: true,
        ...overrides,
      },
      button: { id: `button-${id}` },
      authorNameAtClick: `author-${id}`,
      voterSource: null,
    },
    selection: selection ?? { tag: initial.tags[0], isNewTag: false },
    remoteAuthorization: {
      blockAuthorOnZhihu: false,
      blockContentVoters: false,
    },
  };
}

function createHarness(
  options: {
    readonly failMinimalWriteForUserId?: string;
    readonly now?: () => Date;
  } = {},
) {
  let storedState: BlacklistState = createInitialState();
  let runtimeState: BlacklistState = createInitialState();
  const events: string[] = [];
  const focusedButtons: string[] = [];
  const failures: unknown[] = [];
  let captures = 0;
  let writes = 0;
  let appliedSideEffects = 0;
  let clockCalls = 0;

  const controller = createCommitController<TestCard, TestButton>({
    withExclusiveLock: createExclusiveLock(),
    now() {
      clockCalls += 1;
      return options.now?.() ?? new Date("2026-08-13T12:34:56.789Z");
    },
    async resolveStableUserId(cardValue) {
      events.push(`resolve:${cardValue.id}`);
      return cardValue.stableUserId;
    },
    async captureCardImage(cardValue) {
      captures += 1;
      events.push(`capture:${cardValue.id}`);
      strictEqual(cardValue.hasInjectedCloseButton, true);
      if (cardValue.captureFails) {
        throw new Error(`capture failed: ${cardValue.id}`);
      }
      return {
        dataUrl: "data:image/webp;base64,AA==",
        width: 2,
        height: 2,
      };
    },
    async readState() {
      return parseBlacklistState(storedState);
    },
    async writeState(nextState) {
      writes += 1;
      const newAuthor = nextState.authors.at(-1);
      events.push(`write:${newAuthor?.userId ?? "none"}`);
      if (
        newAuthor &&
        newAuthor.userId === options.failMinimalWriteForUserId &&
        newAuthor.cardImage === undefined
      ) {
        throw new Error("minimal write failed");
      }
      storedState = nextState;
    },
    applyPersistedState(nextState) {
      runtimeState = nextState;
      appliedSideEffects += 1;
      events.push(`hide:${nextState.authors.at(-1)?.userId ?? "none"}`);
    },
    requestFailureFocus(button) {
      focusedButtons.push(button.id);
    },
    reportMalformedStorage() {
      events.push("malformed");
    },
    reportCaptureFailure() {
      events.push("capture-failure");
    },
    reportImageOmitted() {
      events.push("image-omitted");
    },
    reportFailure(error) {
      failures.push(error);
    },
  });

  return {
    controller,
    events,
    focusedButtons,
    failures,
    counts: () => ({ captures, writes, appliedSideEffects }),
    clockCalls: () => clockCalls,
    storedState: () => storedState,
    runtimeState: () => runtimeState,
  };
}

test("BL-008/CAP-005 concurrent duplicate author tasks capture, write, and apply once", async () => {
  const harness = createHarness();
  const duplicateTask = task("duplicate");
  const [first, second] = await Promise.all([
    harness.controller.commit(duplicateTask),
    harness.controller.commit(duplicateTask),
  ]);

  deepStrictEqual([first.status, second.status], ["persisted", "duplicate"]);
  deepStrictEqual(harness.counts(), {
    captures: 1,
    writes: 1,
    appliedSideEffects: 1,
  });
  strictEqual(harness.storedState().authors.length, 1);
});

test("ERR-001/AC-006 minimal write failure preserves runtime state, restores focus, and later work continues", async () => {
  const harness = createHarness({
    failMinimalWriteForUserId: "stable-failing",
  });
  const failing = task("failing", undefined, { captureFails: true });
  const succeeding = task("succeeding");
  const [failedResult, successfulResult] = await Promise.all([
    harness.controller.commit(failing),
    harness.controller.commit(succeeding),
  ]);

  strictEqual(failedResult.status, "failed");
  if (failedResult.status === "failed") {
    strictEqual(failedResult.focusRestorationRequested, true);
  }
  strictEqual(successfulResult.status, "persisted");
  deepStrictEqual(harness.focusedButtons, ["button-failing"]);
  deepStrictEqual(
    harness.runtimeState().authors.map((author) => author.userId),
    ["stable-succeeding"],
  );
  deepStrictEqual(
    harness.storedState().authors.map((author) => author.userId),
    ["stable-succeeding"],
  );
  strictEqual(harness.failures.length, 1);
});

test("CAP-003/AC-016 capture failure writes a minimal record before blocking", async () => {
  const harness = createHarness();
  const result = await harness.controller.commit(
    task("capture-failure", undefined, { captureFails: true }),
  );

  strictEqual(result.status, "persisted");
  strictEqual(harness.storedState().authors[0]?.cardImage, undefined);
  deepStrictEqual(harness.counts(), {
    captures: 1,
    writes: 1,
    appliedSideEffects: 1,
  });
  strictEqual(
    harness.events.indexOf("capture:capture-failure") <
      harness.events.indexOf("hide:stable-capture-failure"),
    true,
  );
});

test("CAP-003/AC-016 capture plus minimal-write failure does not block", async () => {
  const harness = createHarness({
    failMinimalWriteForUserId: "stable-no-block",
  });
  const result = await harness.controller.commit(
    task("no-block", undefined, { captureFails: true }),
  );

  strictEqual(result.status, "failed");
  deepStrictEqual(harness.runtimeState().authors, []);
  deepStrictEqual(harness.storedState().authors, []);
  strictEqual(harness.counts().appliedSideEffects, 0);
  deepStrictEqual(harness.focusedButtons, ["button-no-block"]);
});

test("read-modify-write commits serialize and preserve distinct authors and tags", async () => {
  const harness = createHarness();
  const firstSelection: TagSelection = {
    tag: { tagId: "tag-first", name: "First" },
    isNewTag: true,
  };
  const secondSelection: TagSelection = {
    tag: { tagId: "tag-second", name: "Second" },
    isNewTag: true,
  };

  const results = await Promise.all([
    harness.controller.commit(task("first", firstSelection)),
    harness.controller.commit(task("second", secondSelection)),
  ]);

  deepStrictEqual(
    results.map((result) => result.status),
    ["persisted", "persisted"],
  );
  deepStrictEqual(
    harness.storedState().authors.map((author) => author.userId),
    ["stable-first", "stable-second"],
  );
  deepStrictEqual(
    harness.storedState().tags.map((tag) => tag.tagId),
    ["default", "tag-first", "tag-second"],
  );
});

test("CAP-006 stores one injected UTC completion timestamp and does not regenerate it for duplicates", async () => {
  const harness = createHarness({
    now: () => new Date("2026-08-13T23:45:01.234Z"),
  });
  const duplicateTask = task("timestamped");

  const first = await harness.controller.commit(duplicateTask);
  const second = await harness.controller.commit(duplicateTask);

  strictEqual(first.status, "persisted");
  strictEqual(second.status, "duplicate");
  strictEqual(
    harness.storedState().authors[0]?.blacklistedAt,
    "2026-08-13T23:45:01.234Z",
  );
  strictEqual(harness.clockCalls(), 1);
});

test("CAP-002/003 ordering captures the exact clicked card with its injected close button before hiding", async () => {
  const harness = createHarness();
  const clickedTask = task("clicked-card");
  await harness.controller.commit(clickedTask);

  const captureIndex = harness.events.indexOf("capture:clicked-card");
  const writeIndex = harness.events.indexOf("write:stable-clicked-card");
  const hideIndex = harness.events.indexOf("hide:stable-clicked-card");
  strictEqual(captureIndex >= 0, true);
  strictEqual(captureIndex < writeIndex, true);
  strictEqual(writeIndex < hideIndex, true);
});
