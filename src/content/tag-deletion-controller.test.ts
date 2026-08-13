import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  createInitialState,
  parseBlacklistState,
  type BlacklistState,
} from "./blacklist-state.ts";
import { createTagDeletionController } from "./tag-deletion-controller.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";

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
        userId: "move",
        authorNameAtCapture: "Move",
        tagId: "remove",
        blacklistedAt: TIMESTAMP,
        cardImage: {
          dataUrl: "data:image/webp;base64,AA==",
          width: 2,
          height: 2,
        },
      },
      {
        userId: "keep",
        authorNameAtCapture: "Keep",
        tagId: "keep",
        blacklistedAt: null,
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

test("TAG-014/015 deletion is one latest-state write and preserves author data", async () => {
  let stored = populatedState();
  let runtime = stored;
  const writes: BlacklistState[] = [];
  const event = interaction();
  const controller = createTagDeletionController({
    async withExclusiveLock(operation) {
      stored = {
        ...stored,
        authors: [
          ...stored.authors,
          {
            userId: "concurrent",
            authorNameAtCapture: "Concurrent",
            tagId: "remove",
            blacklistedAt: TIMESTAMP,
          },
        ],
      };
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes.push(state);
      stored = state;
    },
    applyPersistedState(state) {
      runtime = state;
    },
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const beforeMove = populatedState().authors[0];
  const result = await controller.deleteTag("remove", event.value);

  strictEqual(result.status, "persisted");
  strictEqual(writes.length, 1);
  deepStrictEqual(event.counts(), { prevented: 1, stopped: 1 });
  deepStrictEqual(stored.tags.map((tag) => tag.tagId), ["default", "keep"]);
  deepStrictEqual(stored.authors, [
    { ...beforeMove, tagId: DEFAULT_TAG_ID },
    populatedState().authors[1],
    {
      userId: "concurrent",
      authorNameAtCapture: "Concurrent",
      tagId: DEFAULT_TAG_ID,
      blacklistedAt: TIMESTAMP,
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
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState() {
      throw new Error("write failed");
    },
    applyPersistedState(state) {
      runtime = state;
    },
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
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(state);
    },
    async writeState() {
      writes += 1;
    },
    applyPersistedState() {
      applies += 1;
    },
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const result = await controller.deleteTag(DEFAULT_TAG_ID, event.value);
  strictEqual(result.status, "protected");
  strictEqual(writes, 0);
  strictEqual(applies, 0);
});

test("deleting from v1 atomically migrates schema and null timestamps", async () => {
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
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      stored = state;
    },
    applyPersistedState() {},
    reportFailure() {
      throw new Error("Unexpected deletion failure.");
    },
  });

  const result = await controller.deleteTag("remove", event.value);
  strictEqual(result.status, "persisted");
  deepStrictEqual(stored, {
    schemaVersion: 2,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [
      {
        userId: "legacy",
        authorNameAtCapture: "Legacy",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: null,
      },
    ],
  });
});
