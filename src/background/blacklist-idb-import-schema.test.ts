import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { indexedDB } from "fake-indexeddb";

import { createBlacklistTransferFileMetadata } from "../core/blacklist-transfer-values.ts";
import {
  createStoredImportAuthor,
  createStoredImportChunk,
  createStoredImportIdentifier,
  createStoredImportSession,
  createStoredImportTag,
  parseStoredImportAuthor,
  parseStoredImportChunk,
  parseStoredImportIdentifier,
  parseStoredImportSession,
  parseStoredImportTag,
} from "./blacklist-idb-import-schema.ts";
import { BLACKLIST_STORE_NAMES, openBlacklistDatabase } from "./blacklist-idb-schema.ts";

const SESSION_ID = "a".repeat(32);
const TIME = "2026-08-25T12:34:56.789Z";
const envelope = {
  product: "cocoon-blacklist" as const,
  formatVersion: 1 as const,
  exportedAt: TIME,
  schemaVersion: 5 as const,
  authors: [
    {
      platformId: "zhihu",
      userId: "synthetic",
      memberHashId: "b".repeat(32),
      authorNameAtCapture: "Synthetic",
      tagId: "default",
      blacklistedAt: TIME,
      blockSource: "direct" as const,
    },
  ],
  tags: [{ tagId: "default", name: "default" }],
};
const json = JSON.stringify(envelope);
const metadata = createBlacklistTransferFileMetadata(
  envelope,
  new TextEncoder().encode(json).byteLength,
);

test("BUG-016 import staging record parsers require exact derived records", () => {
  const session = createStoredImportSession(SESSION_ID, metadata, 1_000, 2_000);
  const tag = createStoredImportTag(SESSION_ID, 0, envelope.tags[0]);
  const author = createStoredImportAuthor(SESSION_ID, 0, envelope.authors[0]);
  const identifier = createStoredImportIdentifier(
    SESSION_ID,
    0,
    envelope.authors[0],
    envelope.authors[0].userId,
  );
  const chunk = createStoredImportChunk({
    sessionId: SESSION_ID,
    kind: "authors",
    chunkIndex: 0,
    startIndex: 0,
    itemCount: 1,
    payloadJson: JSON.stringify(envelope.authors),
  });

  deepStrictEqual(parseStoredImportSession(session), session);
  deepStrictEqual(parseStoredImportTag(tag), tag);
  deepStrictEqual(parseStoredImportAuthor(author), author);
  deepStrictEqual(parseStoredImportIdentifier(identifier), identifier);
  deepStrictEqual(parseStoredImportChunk(chunk), chunk);

  for (const [parser, value] of [
    [parseStoredImportSession, { ...session, extra: true }],
    [parseStoredImportTag, { ...tag, nameKey: "wrong" }],
    [parseStoredImportAuthor, { ...author, userId: " changed" }],
    [parseStoredImportIdentifier, { ...identifier, authorIndex: -1 }],
    [parseStoredImportChunk, { ...chunk, payloadBytes: chunk.payloadBytes + 1 }],
  ] as const) {
    strictEqual(parser(value), null);
  }
});

test("BUG-016 IDB v2 staging stores expose cleanup and session-scoped uniqueness indexes", async () => {
  const database = await openBlacklistDatabase(
    indexedDB,
    `cocoon-import-schema-${crypto.randomUUID()}`,
  );
  try {
    const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readonly");
    const sessions = transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions);
    const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.importAuthors);
    const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.importIdentifiers);
    const tags = transaction.objectStore(BLACKLIST_STORE_NAMES.importTags);
    const chunks = transaction.objectStore(BLACKLIST_STORE_NAMES.importChunks);

    strictEqual(sessions.indexNames.contains("by-expires-at"), true);
    strictEqual(authors.index("by-session-author").unique, true);
    strictEqual(authors.indexNames.contains("by-session-tag"), true);
    strictEqual(identifiers.indexNames.contains("by-session-author"), true);
    strictEqual(tags.index("by-session-tag").unique, true);
    strictEqual(tags.index("by-session-name").unique, true);
    strictEqual(chunks.indexNames.contains("by-session-kind"), true);
  } finally {
    database.close();
  }
});
