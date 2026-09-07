import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TAG_ID, type BlacklistedAuthor, type CocoonTag } from "./blacklist-state.ts";
import {
  createBlacklistSyncController,
  type ContentBlacklistDirectory,
} from "./blacklist-sync-controller.ts";

const TIMESTAMP = "2026-08-25T12:34:56.789Z";
const DEFAULT_TAG = { tagId: DEFAULT_TAG_ID, name: "default" } as const;

function author(userId: string, tagId = DEFAULT_TAG_ID): BlacklistedAuthor {
  return {
    platformId: "zhihu",
    userId,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${userId}`,
    tagId,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct",
  };
}

function directory(
  revision: number,
  tags: readonly CocoonTag[] = [DEFAULT_TAG],
  authorCount = 0,
): ContentBlacklistDirectory {
  return { revision, authorCount, tagCount: tags.length, tags };
}

function createHarness(directories: ContentBlacklistDirectory[]) {
  let loads = 0;
  const appliedTags: Array<readonly CocoonTag[]> = [];
  const revisions: number[] = [];
  const remembered: Array<{ readonly author: BlacklistedAuthor; readonly revision: number }> = [];
  const controller = createBlacklistSyncController({
    async loadDirectory() {
      const next = directories[loads];
      loads += 1;
      if (!next) throw new Error("Unexpected directory load.");
      return next;
    },
    applyTags(tags) {
      appliedTags.push(tags);
    },
    setRevision(revision) {
      revisions.push(revision);
    },
    rememberAuthor(value, revision) {
      remembered.push({ author: value, revision });
    },
  });
  return {
    controller,
    appliedTags,
    revisions,
    remembered,
    get loads() {
      return loads;
    },
  };
}

test("BUG-016 initialization applies only bounded tags and a revision, never authors", async () => {
  const reading = { tagId: "reading", name: "Reading" };
  const harness = createHarness([directory(4, [DEFAULT_TAG, reading], 100_000)]);

  await harness.controller.initialize();

  strictEqual(harness.loads, 1);
  deepStrictEqual(harness.appliedTags, [[DEFAULT_TAG, reading]]);
  deepStrictEqual(harness.revisions, [4]);
  deepStrictEqual(harness.remembered, []);
  strictEqual(harness.controller.getRevision(), 4);
});

test("BUG-016 self author and duplicate deltas update matcher evidence without a directory reload", async () => {
  const harness = createHarness([directory(4)]);
  await harness.controller.initialize();
  const added = author("self-added");

  await harness.controller.applyAuthorMutation({
    status: "persisted",
    author: added,
    tag: null,
    baseRevision: 4,
    revision: 5,
    authorCount: 1,
    tagCount: 1,
  });
  await harness.controller.applyAuthorMutation({
    status: "duplicate",
    author: added,
    tag: null,
    baseRevision: 5,
    revision: 5,
    authorCount: 1,
    tagCount: 1,
  });

  strictEqual(harness.loads, 1);
  deepStrictEqual(harness.revisions, [4, 5]);
  deepStrictEqual(harness.remembered, [
    { author: added, revision: 5 },
    { author: added, revision: 5 },
  ]);
});

test("BUG-016 cross-context revision advances matcher immediately then refreshes only tags", async () => {
  const reading = { tagId: "reading", name: "Reading" };
  const harness = createHarness([directory(2), directory(4, [DEFAULT_TAG, reading], 100_000)]);
  await harness.controller.initialize();

  const refresh = harness.controller.handleRevision(4);
  deepStrictEqual(harness.revisions, [2, 4]);
  await refresh;
  await harness.controller.handleRevision(3);
  await harness.controller.handleRevision(4);

  strictEqual(harness.loads, 2);
  deepStrictEqual(harness.appliedTags, [[DEFAULT_TAG], [DEFAULT_TAG, reading]]);
  strictEqual(harness.controller.getRevision(), 4);
});

test("BUG-016 self commit and its revision notification converge without hydration", async () => {
  const harness = createHarness([directory(1)]);
  await harness.controller.initialize();
  const committed = author("self");

  harness.controller.beginLocalMutation();
  await harness.controller.handleRevision(2);
  await harness.controller.applyAuthorMutation({
    status: "persisted",
    author: committed,
    tag: null,
    baseRevision: 1,
    revision: 2,
    authorCount: 1,
    tagCount: 1,
  });
  await harness.controller.finishLocalMutation();

  strictEqual(harness.loads, 1);
  deepStrictEqual(harness.revisions, [1, 2]);
  deepStrictEqual(harness.remembered, [{ author: committed, revision: 2 }]);
});

test("BUG-016 a newer external revision makes an older self result stale and triggers bounded refresh", async () => {
  const reading = { tagId: "reading", name: "Reading" };
  const harness = createHarness([directory(1), directory(3, [DEFAULT_TAG, reading], 2)]);
  await harness.controller.initialize();

  harness.controller.beginLocalMutation();
  await harness.controller.handleRevision(3);
  await harness.controller.applyAuthorMutation({
    status: "persisted",
    author: author("stale-self"),
    tag: null,
    baseRevision: 1,
    revision: 2,
    authorCount: 1,
    tagCount: 1,
  });
  await harness.controller.finishLocalMutation();

  strictEqual(harness.loads, 2);
  deepStrictEqual(harness.revisions, [1, 3]);
  deepStrictEqual(harness.remembered, []);
  deepStrictEqual(harness.appliedTags.at(-1), [DEFAULT_TAG, reading]);
});

test("BUG-016 alias and tag mutation deltas stay local while advancing revision", async () => {
  const reading = { tagId: "reading", name: "Reading" };
  const harness = createHarness([directory(8, [DEFAULT_TAG, reading], 1)]);
  await harness.controller.initialize();
  const aliased = { ...author("aliased", reading.tagId), memberHashId: "a".repeat(32) };

  await harness.controller.applyAliasMutation({
    status: "persisted",
    author: aliased,
    baseRevision: 8,
    revision: 9,
    authorCount: 1,
    tagCount: 2,
  });
  await harness.controller.applyTagDeletion({
    status: "persisted",
    deletedTagId: reading.tagId,
    migratedCount: 1,
    baseRevision: 9,
    revision: 10,
    authorCount: 1,
    tagCount: 1,
  });

  strictEqual(harness.loads, 1);
  deepStrictEqual(harness.revisions, [8, 9, 10]);
  deepStrictEqual(harness.remembered, [{ author: aliased, revision: 9 }]);
  deepStrictEqual(harness.appliedTags.at(-1), [DEFAULT_TAG]);
});
