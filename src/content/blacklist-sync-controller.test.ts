import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  createInitialState,
  type BlacklistState,
  type BlacklistedAuthor,
} from "./blacklist-state.ts";
import { createBlacklistSyncController } from "./blacklist-sync-controller.ts";

const TIMESTAMP = "2026-08-25T12:34:56.789Z";

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

function stateWith(...authors: BlacklistedAuthor[]): BlacklistState {
  return { ...createInitialState(), authors };
}

test("AC-095 performs one initial hydration and applies a self author delta without rereading", async () => {
  let hydrations = 0;
  const applied: BlacklistState[] = [];
  const controller = createBlacklistSyncController({
    async hydrate() {
      hydrations += 1;
      return { state: createInitialState(), revision: 4 };
    },
    applyState(state) {
      applied.push(state);
    },
  });

  await controller.initialize();
  const added = author("self-added");
  await controller.applyAuthorMutation({
    status: "persisted",
    author: added,
    tag: null,
    baseRevision: 4,
    revision: 5,
    authorCount: 1,
    tagCount: 1,
  });
  strictEqual(hydrations, 1);
  deepStrictEqual(applied.at(-1)?.authors, [added]);
  strictEqual(controller.getRevision(), 5);

  await controller.handleRevision(5);
  strictEqual(hydrations, 1);
});

test("AC-095 duplicate author delta reapplies the current state without hydration", async () => {
  const existing = author("duplicate");
  let hydrations = 0;
  let applications = 0;
  const controller = createBlacklistSyncController({
    async hydrate() {
      hydrations += 1;
      return { state: stateWith(existing), revision: 5 };
    },
    applyState() {
      applications += 1;
    },
  });
  await controller.initialize();

  await controller.applyAuthorMutation({
    status: "duplicate",
    author: existing,
    tag: null,
    baseRevision: 5,
    revision: 5,
    authorCount: 1,
    tagCount: 1,
  });

  strictEqual(hydrations, 1);
  strictEqual(applications, 2);
  strictEqual(controller.getRevision(), 5);
});

test("AC-095 cross-context revision hydrates authoritatively while stale and out-of-order signals cannot overwrite", async () => {
  const states = [
    { state: stateWith(author("initial")), revision: 2 },
    { state: stateWith(author("cross-context")), revision: 4 },
  ];
  const applied: string[][] = [];
  const controller = createBlacklistSyncController({
    async hydrate() {
      const next = states.shift();
      if (!next) throw new Error("unexpected hydration");
      return next;
    },
    applyState(state) {
      applied.push(state.authors.map(({ userId }) => userId));
    },
  });

  await controller.initialize();
  await controller.handleRevision(4);
  await controller.handleRevision(3);
  await controller.handleRevision(4);
  deepStrictEqual(applied, [["initial"], ["cross-context"]]);
  strictEqual(controller.getRevision(), 4);
});

test("AC-095 a raced self delta falls back to one authoritative hydration", async () => {
  let hydrations = 0;
  const authoritative = stateWith(author("other-context"), author("self"));
  const applied: BlacklistState[] = [];
  const controller = createBlacklistSyncController({
    async hydrate() {
      hydrations += 1;
      return hydrations === 1
        ? { state: createInitialState(), revision: 1 }
        : { state: authoritative, revision: 3 };
    },
    applyState(state) {
      applied.push(state);
    },
  });
  await controller.initialize();

  await controller.applyAuthorMutation({
    status: "persisted",
    author: author("self"),
    tag: null,
    baseRevision: 2,
    revision: 3,
    authorCount: 2,
    tagCount: 1,
  });
  strictEqual(hydrations, 2);
  deepStrictEqual(applied.at(-1), authoritative);
});

test("AC-095 alias and tag deltas update only local affected records", async () => {
  const reading = { tagId: "reading", name: "Reading" };
  const original = author("aliased", reading.tagId);
  let current: BlacklistState = {
    schemaVersion: 5,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }, reading],
    authors: [original],
  };
  const controller = createBlacklistSyncController({
    async hydrate() {
      return { state: current, revision: 8 };
    },
    applyState(state) {
      current = state;
    },
  });
  await controller.initialize();
  const updated = { ...original, memberHashId: "a".repeat(32) };
  await controller.applyAliasMutation({
    status: "persisted",
    author: updated,
    baseRevision: 8,
    revision: 9,
    authorCount: 1,
    tagCount: 2,
  });
  await controller.applyTagDeletion({
    status: "persisted",
    deletedTagId: reading.tagId,
    baseRevision: 9,
    revision: 10,
    authorCount: 1,
    tagCount: 1,
  });
  deepStrictEqual(current.tags, [{ tagId: DEFAULT_TAG_ID, name: "default" }]);
  deepStrictEqual(current.authors, [{ ...updated, tagId: DEFAULT_TAG_ID }]);
});
