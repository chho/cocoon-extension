import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createDefaultRemotePreferences,
  initializeRemotePreferences,
  parseRemotePreferences,
  updateRemotePreference,
  type RemotePreferences,
} from "./remote-preferences.ts";

test("PREF-001/002 defaults both independently versioned options to off", () => {
  const parsed = parseRemotePreferences(undefined);
  strictEqual(parsed.status, "missing");
  deepStrictEqual(parsed.preferences, {
    schemaVersion: 1,
    blockAuthorOnZhihu: false,
    blockContentVoters: false,
  });
});

test("PREF-002 rejects damaged or partially typed settings safely", () => {
  for (const value of [
    null,
    {},
    { schemaVersion: 2, blockAuthorOnZhihu: false, blockContentVoters: false },
    { schemaVersion: 1, blockAuthorOnZhihu: true },
    { schemaVersion: 1, blockAuthorOnZhihu: "true", blockContentVoters: false },
  ]) {
    const parsed = parseRemotePreferences(value);
    strictEqual(parsed.status, "malformed");
    deepStrictEqual(parsed.preferences, createDefaultRemotePreferences());
  }
});

test("PREF-001/003 updates either option without changing the other", async () => {
  let stored: unknown = {
    schemaVersion: 1,
    blockAuthorOnZhihu: false,
    blockContentVoters: true,
  };
  const dependencies = {
    async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },
    async read() {
      return parseRemotePreferences(stored);
    },
    async write(preferences: RemotePreferences) {
      stored = preferences;
    },
  };

  const next = await updateRemotePreference(
    dependencies,
    "blockAuthorOnZhihu",
    true,
  );
  deepStrictEqual(next, {
    schemaVersion: 1,
    blockAuthorOnZhihu: true,
    blockContentVoters: true,
  });
});

test("PREF-003 write failure leaves the persisted preference unchanged", async () => {
  const persisted = createDefaultRemotePreferences();
  await rejects(
    updateRemotePreference(
      {
        async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
          return operation();
        },
        async read() {
          return parseRemotePreferences(persisted);
        },
        async write() {
          throw new Error("storage unavailable");
        },
      },
      "blockContentVoters",
      true,
    ),
    /storage unavailable/,
  );
  deepStrictEqual(persisted, createDefaultRemotePreferences());
});

test("PREF-002 initializes a missing object once under the storage lock", async () => {
  let stored: unknown;
  let writes = 0;
  const result = await initializeRemotePreferences({
    async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },
    async read() {
      return parseRemotePreferences(stored);
    },
    async write(preferences) {
      writes += 1;
      stored = preferences;
    },
  });

  strictEqual(result.status, "valid");
  strictEqual(writes, 1);
  deepStrictEqual(result.preferences, createDefaultRemotePreferences());
});
