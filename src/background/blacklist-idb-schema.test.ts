import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { indexedDB, IDBObjectStore } from "fake-indexeddb";
import { createInitialState, type BlacklistedAuthor } from "../content/blacklist-state.ts";
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  createMetadata,
  createStoredAuthor,
  openBlacklistDatabase,
  requestResult,
  transactionDone,
} from "./blacklist-idb-schema.ts";

const author: BlacklistedAuthor = {
  platformId: "zhihu",
  userId: "synthetic-author",
  memberHashId: "a".repeat(32),
  authorNameAtCapture: "Synthetic",
  tagId: "default",
  blacklistedAt: "2026-01-01T00:00:00.000Z",
  blockSource: "upvoter",
  sourcePostId: null,
};
const legacyAuthor = createStoredAuthor(author, 7);
Reflect.deleteProperty(legacyAuthor, "sourcePostId");
const legacyMetadata = {
  ...createMetadata({ ...createInitialState(), authors: [author] }, 9),
  logicalSchemaVersion: 5,
  nextAuthorOrder: 8,
};

async function createV2(name: string): Promise<void> {
  const request = indexedDB.open(name, 2);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(BLACKLIST_STORE_NAMES.authors, { keyPath: "authorKey" });
    request.result.createObjectStore(BLACKLIST_STORE_NAMES.metadata, { keyPath: "key" });
  };
  const db = await requestResult(request);
  try {
    const transaction = db.transaction(
      [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.metadata],
      "readwrite",
    );
    const done = transactionDone(transaction);
    transaction.objectStore(BLACKLIST_STORE_NAMES.authors).add(legacyAuthor);
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).add(legacyMetadata);
    await done;
  } finally {
    db.close();
  }
}

test("POST-004 v2 upgrade atomically adds null refs, post stores and schema6 metadata", async () => {
  const name = `post-migration-${crypto.randomUUID()}`;
  await createV2(name);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === BLACKLIST_STORE_NAMES.metadata) throw new Error("Synthetic migration abort");
    return originalPut.apply(this, args);
  };
  try {
    await rejects(openBlacklistDatabase(indexedDB, name));
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  const preserved = await requestResult(indexedDB.open(name));
  try {
    strictEqual(preserved.version, 2);
    strictEqual(preserved.objectStoreNames.contains(BLACKLIST_STORE_NAMES.posts), false);
    const tx = preserved.transaction([
      BLACKLIST_STORE_NAMES.authors,
      BLACKLIST_STORE_NAMES.metadata,
    ]);
    const done = transactionDone(tx);
    deepStrictEqual(
      await requestResult(
        tx.objectStore(BLACKLIST_STORE_NAMES.authors).get(legacyAuthor.authorKey),
      ),
      legacyAuthor,
    );
    deepStrictEqual(
      await requestResult(
        tx.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
      ),
      legacyMetadata,
    );
    await done;
  } finally {
    preserved.close();
  }
  const upgraded = await openBlacklistDatabase(indexedDB, name);
  try {
    strictEqual(upgraded.version, 3);
    const tx = upgraded.transaction([
      BLACKLIST_STORE_NAMES.authors,
      BLACKLIST_STORE_NAMES.metadata,
      BLACKLIST_STORE_NAMES.posts,
      BLACKLIST_STORE_NAMES.importPosts,
    ]);
    const done = transactionDone(tx);
    strictEqual(tx.objectStore(BLACKLIST_STORE_NAMES.posts).keyPath, "postId");
    deepStrictEqual(tx.objectStore(BLACKLIST_STORE_NAMES.importPosts).keyPath, [
      "sessionId",
      "index",
    ]);
    deepStrictEqual(
      await requestResult(
        tx.objectStore(BLACKLIST_STORE_NAMES.authors).get(legacyAuthor.authorKey),
      ),
      { ...legacyAuthor, sourcePostId: null },
    );
    deepStrictEqual(
      await requestResult(
        tx.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
      ),
      { ...legacyMetadata, logicalSchemaVersion: 6 },
    );
    await done;
  } finally {
    upgraded.close();
  }
});
