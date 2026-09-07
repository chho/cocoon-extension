import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { CocoonTag } from "./blacklist-state.ts";
import { createBackgroundBlacklistClient } from "./background-blacklist-client.ts";

function unexpected(operation: string): never {
  throw new Error(`Unexpected ${operation} call.`);
}

test("BUG-015/BUG-016 client initialization preserves the sync receiver and loads only bounded tags", async () => {
  const requests: Array<{ readonly revision: number; readonly cursor: string | null }> = [];
  let initializations = 0;
  let appliedTags: readonly CocoonTag[] = [];
  const revisions: number[] = [];
  const client = createBackgroundBlacklistClient({
    gateway: {
      async initialize() {
        initializations += 1;
        return { revision: 3, authorCount: 100_000, tagCount: 2 };
      },
      async queryTagsPage(input) {
        requests.push({ revision: input.revision, cursor: input.cursor });
        return input.cursor === null
          ? {
              revision: 3,
              tags: [{ tagId: "default", name: "default" }],
              nextCursor: "next-tags",
            }
          : {
              revision: 3,
              tags: [{ tagId: "reading", name: "Reading" }],
              nextCursor: null,
            };
      },
      async queryIdentityMatches(input) {
        return { revision: input.revision, matches: [] };
      },
      async commitAuthor() {
        return unexpected("commitAuthor");
      },
      async backfillMemberHash() {
        return unexpected("backfillMemberHash");
      },
      async commitUpvoter() {
        return unexpected("commitUpvoter");
      },
      async preflightDirect() {
        return unexpected("preflightDirect");
      },
      async deleteTag() {
        return unexpected("deleteTag");
      },
    },
    applyTags(tags) {
      appliedTags = tags;
    },
    setRevision(revision) {
      revisions.push(revision);
    },
    rememberAuthor() {
      throw new Error("Initialization must not remember an author.");
    },
    reportSyncFailure() {
      throw new Error("Unexpected sync failure.");
    },
  });

  await client.initialize();

  strictEqual(initializations, 1);
  deepStrictEqual(requests, [
    { revision: 3, cursor: null },
    { revision: 3, cursor: "next-tags" },
  ]);
  deepStrictEqual(appliedTags, [
    { tagId: "default", name: "default" },
    { tagId: "reading", name: "Reading" },
  ]);
  deepStrictEqual(revisions, [3]);
});

test("BUG-016 client exposes revision-bound identity matching without full state", async () => {
  const requested = [{ platformId: "zhihu", identifier: "visible" }] as const;
  const client = createBackgroundBlacklistClient({
    gateway: {
      async initialize() {
        return { revision: 4, authorCount: 1, tagCount: 1 };
      },
      async queryTagsPage() {
        return {
          revision: 4,
          tags: [{ tagId: "default", name: "default" }],
          nextCursor: null,
        };
      },
      async queryIdentityMatches(input) {
        return { revision: input.revision, matches: requested };
      },
      async commitAuthor() {
        return unexpected("commitAuthor");
      },
      async backfillMemberHash() {
        return unexpected("backfillMemberHash");
      },
      async commitUpvoter() {
        return unexpected("commitUpvoter");
      },
      async preflightDirect() {
        return unexpected("preflightDirect");
      },
      async deleteTag() {
        return unexpected("deleteTag");
      },
    },
    applyTags() {},
    setRevision() {},
    rememberAuthor() {},
    reportSyncFailure() {},
  });

  deepStrictEqual(await client.queryIdentityMatches({ revision: 4, identities: requested }), {
    revision: 4,
    matches: requested,
  });
});
