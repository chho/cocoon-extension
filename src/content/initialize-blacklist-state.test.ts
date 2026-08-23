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
  const legacyImageKey = `card${"Image"}`;
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
      [legacyImageKey]: { invalid: true },
    })),
  };
}

test("PLATFORM-001 migrates v1 to v5 in one locked write without legacy image data", async () => {
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
    schemaVersion: 5,
    tags: legacyState().tags,
    authors: [{
      platformId: "zhihu",
      userId: "legacy-user",
      memberHashId: null,
      authorNameAtCapture: "Name legacy-user",
      tagId: "saved",
      blacklistedAt: null,
      blockSource: "direct",
    }],
  });
});

test("migration re-reads under lock so a concurrent legacy update is preserved", async () => {
  let stored: unknown = legacyState(["initial"]);
  const concurrentLegacy = legacyState(["initial", "concurrent"]);
  const writes: BlacklistState[] = [];
  await initializeBlacklistState({
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
  deepStrictEqual(writes[0]?.authors.map((author) => ({
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
  })), [
    { platformId: "zhihu", userId: "initial", memberHashId: null },
    { platformId: "zhihu", userId: "concurrent", memberHashId: null },
  ]);
});

test("initialization does not overwrite a valid v5 state created before lock acquisition", async () => {
  let stored: unknown = undefined;
  const concurrentState: BlacklistState = {
    schemaVersion: 5,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [{
      platformId: "zhihu",
      userId: "concurrent",
      memberHashId: null,
      authorNameAtCapture: "Concurrent",
      tagId: DEFAULT_TAG_ID,
      blacklistedAt: TIMESTAMP,
      blockSource: "direct",
    }],
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

test("migration write failure leaves the legacy value untouched", async () => {
  const legacy = legacyState(["legacy-user"]);
  let stored: unknown = legacy;
  await rejects(initializeBlacklistState({
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState() {
      throw new Error("storage unavailable");
    },
  }), /storage unavailable/);
  strictEqual(stored, legacy);
});
