import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  parseBlacklistState,
  type BlacklistState,
} from "./blacklist-state.ts";
import { initializeBlacklistState } from "./initialize-blacklist-state.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";

function legacyState(authorIds: readonly string[] = []) {
  return {
    schemaVersion: 1,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "saved", name: "Saved" },
    ],
    authors: authorIds.map((userId) => ({
      userId,
      authorNameAtCapture: `Name ${userId}`,
      tagId: "saved",
      cardImage: {
        dataUrl: "data:image/webp;base64,AA==",
        width: 2,
        height: 2,
      },
    })),
  };
}

test("SOURCE-004 migrates v1 to v3 in one locked write without losing fields", async () => {
  let stored: unknown = legacyState(["legacy-user"]);
  const writes: BlacklistState[] = [];
  const result = await initializeBlacklistState({
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes.push(state);
      stored = state;
    },
  });

  strictEqual(result.status, "valid");
  strictEqual(writes.length, 1);
  deepStrictEqual(writes[0], {
    schemaVersion: 3,
    tags: legacyState().tags,
    authors: [
      {
        ...legacyState(["legacy-user"]).authors[0],
        blacklistedAt: null,
        blockSource: "direct",
      },
    ],
  });
});

test("MIG-001 re-reads under the lock so a concurrent v1 update is preserved", async () => {
  let stored: unknown = legacyState(["initial"]);
  const concurrentLegacy = legacyState(["initial", "concurrent"]);
  const writes: BlacklistState[] = [];
  const result = await initializeBlacklistState({
    async withExclusiveLock(operation) {
      stored = concurrentLegacy;
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes.push(state);
      stored = state;
    },
  });

  strictEqual(result.status, "valid");
  deepStrictEqual(
    writes[0]?.authors.map((author) => ({
      userId: author.userId,
      blacklistedAt: author.blacklistedAt,
      blockSource: author.blockSource,
    })),
    [
      { userId: "initial", blacklistedAt: null, blockSource: "direct" },
      { userId: "concurrent", blacklistedAt: null, blockSource: "direct" },
    ],
  );
});

test("initialization does not overwrite a valid v3 state created before lock acquisition", async () => {
  let stored: unknown = undefined;
  const concurrentState: BlacklistState = {
    schemaVersion: 3,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [
      {
        userId: "concurrent",
        authorNameAtCapture: "Concurrent",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  let writes = 0;
  const result = await initializeBlacklistState({
    async withExclusiveLock(operation) {
      stored = concurrentState;
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      stored = state;
    },
  });

  strictEqual(writes, 0);
  strictEqual(result.status, "valid");
  deepStrictEqual(result.state, concurrentState);
});

test("migration write failure leaves the legacy storage value untouched", async () => {
  const legacy = legacyState(["legacy-user"]);
  let stored: unknown = legacy;
  await rejects(
    initializeBlacklistState({
      async withExclusiveLock(operation) {
        return operation();
      },
      async readState() {
        return parseBlacklistState(stored);
      },
      async writeState() {
        throw new Error("storage unavailable");
      },
    }),
    /storage unavailable/,
  );
  strictEqual(stored, legacy);
});
