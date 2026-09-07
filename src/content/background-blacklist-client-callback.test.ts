import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createBlacklistRevisionSignal } from "../core/blacklist-revision-contract.ts";
import { createBackgroundBlacklistClient } from "./background-blacklist-client.ts";
import type { BlacklistedAuthor, CocoonTag, CommitInput } from "./blacklist-state.ts";

const DEFAULT_TAG = { tagId: "default", name: "default" };
const CUSTOM_TAG = { tagId: "reading", name: "Reading" };
const AUTHOR: BlacklistedAuthor = {
  platformId: "zhihu",
  userId: "synthetic-callback-author",
  memberHashId: null,
  authorNameAtCapture: "Synthetic Author",
  tagId: CUSTOM_TAG.tagId,
  blacklistedAt: "2026-09-07T00:00:00.000Z",
  blockSource: "direct",
};
const INPUT: CommitInput = {
  platformId: AUTHOR.platformId,
  userId: AUTHOR.userId,
  memberHashId: null,
  authorNameAtCapture: AUTHOR.authorNameAtCapture,
  tag: CUSTOM_TAG,
  isNewTag: false,
  blacklistedAt: "2026-09-07T00:00:00.000Z",
};
const UPVOTER_INPUT = {
  platformId: INPUT.platformId,
  userId: INPUT.userId,
  authorNameAtCapture: INPUT.authorNameAtCapture,
  tagId: CUSTOM_TAG.tagId,
  blacklistedAt: INPUT.blacklistedAt,
};

function createHarness() {
  const calls: unknown[] = [];
  const revisions: number[] = [];
  const remembered: unknown[] = [];
  const appliedTags: Array<readonly CocoonTag[]> = [];
  const state = {
    revision: 1,
    tags: [DEFAULT_TAG, CUSTOM_TAG],
    beforeWrite: async () => {},
  };
  async function write(input: unknown) {
    calls.push(input);
    await state.beforeWrite();
    const baseRevision = state.revision;
    state.revision += 1;
    return { baseRevision, revision: state.revision, authorCount: 1, tagCount: state.tags.length };
  }
  const client = createBackgroundBlacklistClient({
    gateway: {
      async initialize() {
        return { revision: state.revision, authorCount: 1, tagCount: state.tags.length };
      },
      async queryTagsPage() {
        return { revision: state.revision, tags: state.tags, nextCursor: null };
      },
      async queryIdentityMatches() {
        throw new Error("Unexpected identity query");
      },
      async commitAuthor(input) {
        return { ...(await write(input)), status: "persisted", author: AUTHOR, tag: null };
      },
      async commitUpvoter(input) {
        return {
          ...(await write(input)),
          status: "persisted",
          author: { ...AUTHOR, blockSource: "upvoter" },
          tag: null,
        };
      },
      async deleteTag(tagId) {
        const context = await write(tagId);
        state.tags = [DEFAULT_TAG];
        return {
          ...context,
          tagCount: 1,
          status: "persisted",
          deletedTagId: tagId,
          migratedCount: 1,
        };
      },
      async backfillMemberHash() {
        throw new Error("Unexpected alias mutation");
      },
      async preflightDirect() {
        throw new Error("Unexpected remote preflight");
      },
    },
    applyTags(tags) {
      appliedTags.push(tags);
    },
    setRevision(revision) {
      revisions.push(revision);
    },
    rememberAuthor(author, revision) {
      remembered.push({ author, revision });
    },
    reportSyncFailure() {
      throw new Error("Unexpected sync failure");
    },
  });
  // Production runtime passes these methods to other controller dependency objects unchanged.
  const callbacks = {
    commitAuthor: client.commitAuthor,
    commitUpvoter: client.commitUpvoter,
    deleteTag: client.deleteTag,
  };
  return { client, callbacks, calls, revisions, remembered, appliedTags, state };
}

const SCENARIOS = [
  { operation: "commitAuthor", input: INPUT, source: "direct" },
  { operation: "commitUpvoter", input: UPVOTER_INPUT, source: "upvoter" },
  { operation: "deleteTag", input: CUSTOM_TAG.tagId, source: null },
] as const;

function invoke(
  harness: ReturnType<typeof createHarness>,
  operation: (typeof SCENARIOS)[number]["operation"],
) {
  switch (operation) {
    case "commitAuthor":
      return harness.callbacks.commitAuthor(INPUT);
    case "commitUpvoter":
      return harness.callbacks.commitUpvoter(UPVOTER_INPUT);
    case "deleteTag":
      return harness.callbacks.deleteTag(CUSTOM_TAG.tagId);
  }
}

for (const scenario of SCENARIOS) {
  test(`BUG-017/AC-100 ${scenario.operation} callback preserves client and applies one delta`, async () => {
    const harness = createHarness();
    await harness.client.initialize();
    const result = await invoke(harness, scenario.operation);
    strictEqual(result.status, "persisted");
    deepStrictEqual(harness.calls, [scenario.input]);
    deepStrictEqual(harness.revisions, [1, 2]);
    deepStrictEqual(
      harness.remembered,
      scenario.source === null
        ? []
        : [{ author: { ...AUTHOR, blockSource: scenario.source }, revision: 2 }],
    );
    deepStrictEqual(harness.appliedTags, [
      [DEFAULT_TAG, CUSTOM_TAG],
      scenario.source === null ? [DEFAULT_TAG] : [DEFAULT_TAG, CUSTOM_TAG],
    ]);
  });

  test(`BUG-017/AC-100 failed ${scenario.operation} callback releases pending sync and can retry`, async () => {
    const harness = createHarness();
    await harness.client.initialize();
    const failure = new Error("Synthetic storage failure");
    harness.state.beforeWrite = async () => {
      harness.state.revision = 2;
      await harness.client.handleRevisionValue(createBlacklistRevisionSignal(2));
      throw failure;
    };
    await rejects(
      async () => invoke(harness, scenario.operation),
      (error) => error === failure,
    );
    deepStrictEqual(harness.remembered, []);
    // A revision arriving during the failed write must still refresh the tag directory.
    deepStrictEqual(harness.appliedTags, [
      [DEFAULT_TAG, CUSTOM_TAG],
      [DEFAULT_TAG, CUSTOM_TAG],
    ]);
    deepStrictEqual(harness.revisions, [1, 2]);
    harness.state.beforeWrite = async () => {};
    const retried = await invoke(harness, scenario.operation);
    strictEqual(retried.status, "persisted");
    deepStrictEqual(harness.calls, [scenario.input, scenario.input]);
    deepStrictEqual(harness.revisions, [1, 2, 3]);
  });
}
