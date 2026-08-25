import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  createInitialState,
  parseBlacklistState,
  planTagDeletion,
  type BlacklistState,
} from "./blacklist-state.ts";
import { createTagDeletionController } from "./tag-deletion-controller.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";
const MEMBER_HASH = "a".repeat(32);

function populatedState(): BlacklistState {
  return {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "remove", name: "Remove" },
      { tagId: "keep", name: "Keep" },
    ],
    authors: [
      {
        platformId: "zhihu",
        userId: "move",
        memberHashId: MEMBER_HASH,
        authorNameAtCapture: "Move",
        tagId: "remove",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
      {
        platformId: "zhihu",
        userId: "keep",
        memberHashId: null,
        authorNameAtCapture: "Keep",
        tagId: "keep",
        blacklistedAt: null,
        blockSource: "direct",
      },
    ],
  };
}

function interaction() {
  let prevented = 0;
  let stopped = 0;
  return {
    value: {
      preventDefault() {
        prevented += 1;
      },
      stopImmediatePropagation() {
        stopped += 1;
      },
    },
    counts: () => ({ prevented, stopped }),
  };
}

function createTargetedDelete(options: {
  readonly readState: () => unknown;
  readonly persistState: (state: BlacklistState) => void;
  readonly applyState: (state: BlacklistState) => void;
  readonly beforeDelete?: () => void;
  readonly failWrite?: boolean;
}) {
  let revision = 0;
  return async (tagId: string) => {
    options.beforeDelete?.();
    const parsed = parseBlacklistState(options.readState());
    if (parsed.status === "malformed") throw new Error("state unreadable");
    const plan = planTagDeletion(parsed.state, tagId);
    const base = {
      baseRevision: revision,
      revision,
      authorCount: parsed.state.authors.length,
      tagCount: parsed.state.tags.length,
    };
    if (plan.status !== "ready") {
      return {
        status: plan.status,
        deletedTagId: null,
        ...base,
      };
    }
    if (options.failWrite) throw new Error("write failed");
    options.persistState(plan.state);
    options.applyState(plan.state);
    revision += 1;
    return {
      status: "persisted" as const,
      deletedTagId: tagId,
      baseRevision: base.baseRevision,
      revision,
      authorCount: plan.state.authors.length,
      tagCount: plan.state.tags.length,
    };
  };
}

test("TAG-014/015 deletion is one latest-state write and preserves author data", async () => {
  let stored = populatedState();
  let runtime = stored;
  const writes: BlacklistState[] = [];
  const event = interaction();
  const controller = createTagDeletionController({
    deleteTag: createTargetedDelete({
      readState: () => stored,
      beforeDelete() {
        stored = {
          ...stored,
          authors: [
            ...stored.authors,
            {
              platformId: "zhihu",
              userId: "concurrent",
              memberHashId: null,
              authorNameAtCapture: "Concurrent",
              tagId: "remove",
              blacklistedAt: TIMESTAMP,
              blockSource: "direct",
            },
          ],
        };
      },
      persistState(state) {
        writes.push(state);
        stored = state;
      },
      applyState(state) {
        runtime = state;
      },
    }),
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const beforeMove = populatedState().authors[0];
  const result = await controller.deleteTag("remove", event.value);

  strictEqual(result.status, "persisted");
  strictEqual(writes.length, 1);
  deepStrictEqual(event.counts(), { prevented: 1, stopped: 1 });
  deepStrictEqual(
    stored.tags.map((tag) => tag.tagId),
    ["default", "keep"],
  );
  deepStrictEqual(stored.authors, [
    { ...beforeMove, tagId: DEFAULT_TAG_ID },
    populatedState().authors[1],
    {
      platformId: "zhihu",
      userId: "concurrent",
      memberHashId: null,
      authorNameAtCapture: "Concurrent",
      tagId: DEFAULT_TAG_ID,
      blacklistedAt: TIMESTAMP,
      blockSource: "direct",
    },
  ]);
  strictEqual(runtime, stored);
});

test("TAG-016 write failure rolls back memory and keeps the drawer event isolated", async () => {
  const stored = populatedState();
  let runtime = stored;
  let reported: unknown;
  const event = interaction();
  const controller = createTagDeletionController({
    deleteTag: createTargetedDelete({
      readState: () => stored,
      persistState() {},
      applyState(state) {
        runtime = state;
      },
      failWrite: true,
    }),
    reportFailure(error) {
      reported = error;
    },
  });

  const result = await controller.deleteTag("remove", event.value);

  strictEqual(result.status, "failed");
  strictEqual(runtime, stored);
  deepStrictEqual(stored, populatedState());
  deepStrictEqual(event.counts(), { prevented: 1, stopped: 1 });
  strictEqual(reported instanceof Error, true);
});

test("default is protected by controller logic without any storage write", async () => {
  const state = populatedState();
  let writes = 0;
  let applies = 0;
  const event = interaction();
  const controller = createTagDeletionController({
    deleteTag: createTargetedDelete({
      readState: () => state,
      persistState() {
        writes += 1;
      },
      applyState() {
        applies += 1;
      },
    }),
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const result = await controller.deleteTag(DEFAULT_TAG_ID, event.value);
  strictEqual(result.status, "protected");
  strictEqual(writes, 0);
  strictEqual(applies, 0);
});

test("deleting from v1 atomically migrates schema v5, platform, source, hash, and null timestamps", async () => {
  let stored: unknown = {
    schemaVersion: 1,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "remove", name: "Remove" },
    ],
    authors: [
      {
        userId: "legacy",
        authorNameAtCapture: "Legacy",
        tagId: "remove",
      },
    ],
  };
  const event = interaction();
  const controller = createTagDeletionController({
    deleteTag: createTargetedDelete({
      readState: () => stored,
      persistState(state) {
        stored = state;
      },
      applyState() {},
    }),
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const result = await controller.deleteTag("remove", event.value);
  strictEqual(result.status, "persisted");
  deepStrictEqual(stored, {
    schemaVersion: 5,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [
      {
        platformId: "zhihu",
        userId: "legacy",
        memberHashId: null,
        authorNameAtCapture: "Legacy",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: null,
        blockSource: "direct",
      },
    ],
  });
});
