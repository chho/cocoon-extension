import type * as TransferContractModule from "../core/blacklist-transfer-rpc-contract.ts";
import type {
  BlacklistImportAuthorsChunkInput,
  BlacklistImportSessionDto,
  BlacklistImportTagsChunkInput,
  BlacklistTransferProgressDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type { BlacklistTransferFileMetadataDto } from "../core/blacklist-transfer-values.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundTransferContract from "../core/blacklist-transfer-rpc-contract.ts?background-copy";
import {
  createStoredImportAuthor,
  createStoredImportChunk,
  createStoredImportIdentifier,
  createStoredImportSession,
  createStoredImportTag,
  parseStoredImportChunk,
  parseStoredImportSession,
  type StoredImportChunk,
  type StoredImportSession,
} from "./blacklist-idb-import-schema.ts";
import { BLACKLIST_STORE_NAMES, requestResult, transactionDone } from "./blacklist-idb-schema.ts";
import {
  ImportChunkConflictError,
  ImportSessionExpiredError,
  ImportSessionNotFoundError,
} from "./blacklist-transfer-repository-errors.ts";
import type { ImportChunkStageResult } from "./blacklist-transfer-repository-types.ts";

const {
  parseBlacklistImportAuthorsChunkInput,
  parseBlacklistImportTagsChunkInput,
  parseBlacklistTransferFileMetadata,
} = backgroundTransferContract as typeof TransferContractModule;

export const BLACKLIST_IMPORT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

function abort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Preserve the validation or request failure.
  }
}

function currentTime(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Import clock is invalid.");
  return value;
}

function expiresAt(now: number): number {
  const expiry = now + BLACKLIST_IMPORT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(expiry)) throw new Error("Import expiry is invalid.");
  return expiry;
}

function publicSession(session: StoredImportSession, now: number): BlacklistImportSessionDto {
  return now >= session.expiresAt ? { ...session, status: "expired" } : session;
}

async function storedSessionFrom(
  transaction: IDBTransaction,
  sessionId: string,
): Promise<StoredImportSession | null> {
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions).get(sessionId),
  );
  if (raw === undefined) return null;
  const session = parseStoredImportSession(raw);
  if (!session) throw new Error("IndexedDB import session is unreadable.");
  return session;
}

function requireActiveSession(
  session: StoredImportSession | null,
  now: number,
): StoredImportSession {
  if (!session) throw new ImportSessionNotFoundError();
  if (now >= session.expiresAt) throw new ImportSessionExpiredError();
  return session;
}

export async function beginImportStaging(options: {
  readonly database: IDBDatabase;
  readonly metadata: BlacklistTransferFileMetadataDto;
  readonly clock: () => number;
  readonly randomSessionId: () => string;
}): Promise<BlacklistImportSessionDto> {
  const metadata = parseBlacklistTransferFileMetadata(options.metadata);
  if (!metadata) throw new Error("Blacklist import metadata is invalid.");
  const now = currentTime(options.clock);
  const session = createStoredImportSession(
    options.randomSessionId(),
    metadata,
    now,
    expiresAt(now),
  );
  if (!parseStoredImportSession(session))
    throw new Error("Blacklist import session ID is invalid.");
  const transaction = options.database.transaction(
    BLACKLIST_STORE_NAMES.importSessions,
    "readwrite",
  );
  const done = transactionDone(transaction);
  try {
    transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions).add(session);
    await done;
    return session;
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

function chunkRecord(
  input: BlacklistImportAuthorsChunkInput | BlacklistImportTagsChunkInput,
  kind: StoredImportChunk["kind"],
): StoredImportChunk {
  const items = "authors" in input ? input.authors : input.tags;
  return createStoredImportChunk({
    sessionId: input.sessionId,
    kind,
    chunkIndex: input.chunkIndex,
    startIndex: input.startIndex,
    itemCount: items.length,
    payloadJson: JSON.stringify(items),
  });
}

function sameChunk(left: StoredImportChunk, right: StoredImportChunk): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.kind === right.kind &&
    left.chunkIndex === right.chunkIndex &&
    left.startIndex === right.startIndex &&
    left.itemCount === right.itemCount &&
    left.payloadJson === right.payloadJson &&
    left.payloadBytes === right.payloadBytes
  );
}

function collectionProgress(
  current: BlacklistTransferProgressDto,
  chunk: StoredImportChunk,
): BlacklistTransferProgressDto {
  return {
    chunks: current.chunks + 1,
    count: current.count + chunk.itemCount,
    bytes: current.bytes + chunk.payloadBytes - 2 + (current.chunks > 0 ? 1 : 0),
  };
}

function isComplete(session: StoredImportSession): boolean {
  const { metadata, received } = session;
  return (
    received.authors.chunks === metadata.authorChunkCount &&
    received.authors.count === metadata.authorCount &&
    received.authors.bytes === metadata.authorsBytes &&
    received.tags.chunks === metadata.tagChunkCount &&
    received.tags.count === metadata.tagCount &&
    received.tags.bytes === metadata.tagsBytes
  );
}

function updatedSession(
  session: StoredImportSession,
  chunk: StoredImportChunk,
  now: number,
): StoredImportSession {
  const received = {
    ...session.received,
    [chunk.kind]: collectionProgress(session.received[chunk.kind], chunk),
  };
  const updated: StoredImportSession = {
    ...session,
    status: "receiving",
    updatedAt: now,
    expiresAt: expiresAt(now),
    received,
  };
  return { ...updated, status: isComplete(updated) ? "ready" : "receiving" };
}

function validateChunkRange(session: StoredImportSession, chunk: StoredImportChunk): void {
  const total = chunk.kind === "authors" ? session.metadata.authorCount : session.metadata.tagCount;
  const chunks =
    chunk.kind === "authors" ? session.metadata.authorChunkCount : session.metadata.tagChunkCount;
  if (
    chunk.chunkIndex >= chunks ||
    chunk.startIndex >= total ||
    chunk.itemCount > total - chunk.startIndex
  ) {
    throw new ImportChunkConflictError();
  }
}

function stageAuthorRecords(
  transaction: IDBTransaction,
  input: BlacklistImportAuthorsChunkInput,
): void {
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.importAuthors);
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.importIdentifiers);
  input.authors.forEach((author, offset) => {
    const index = input.startIndex + offset;
    authors.add(createStoredImportAuthor(input.sessionId, index, author));
    identifiers.add(createStoredImportIdentifier(input.sessionId, index, author, author.userId));
    if (author.memberHashId !== null) {
      identifiers.add(
        createStoredImportIdentifier(input.sessionId, index, author, author.memberHashId),
      );
    }
  });
}

function stageTagRecords(transaction: IDBTransaction, input: BlacklistImportTagsChunkInput): void {
  const tags = transaction.objectStore(BLACKLIST_STORE_NAMES.importTags);
  input.tags.forEach((tag, offset) => {
    tags.add(createStoredImportTag(input.sessionId, input.startIndex + offset, tag));
  });
}

function isConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConstraintError"
  );
}

function stagingStoreNames(kind: StoredImportChunk["kind"]): string[] {
  const itemStore =
    kind === "authors" ? BLACKLIST_STORE_NAMES.importAuthors : BLACKLIST_STORE_NAMES.importTags;
  return [
    BLACKLIST_STORE_NAMES.importSessions,
    BLACKLIST_STORE_NAMES.importChunks,
    itemStore,
    ...(kind === "authors" ? [BLACKLIST_STORE_NAMES.importIdentifiers] : []),
  ];
}

async function existingChunkFrom(
  transaction: IDBTransaction,
  chunk: StoredImportChunk,
): Promise<StoredImportChunk | null> {
  const raw = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importChunks)
      .get([chunk.sessionId, chunk.kind, chunk.chunkIndex]),
  );
  if (raw === undefined) return null;
  const existing = parseStoredImportChunk(raw);
  if (!existing || !sameChunk(existing, chunk)) throw new ImportChunkConflictError();
  return existing;
}

async function stageChunk(options: {
  readonly database: IDBDatabase;
  readonly clock: () => number;
  readonly kind: StoredImportChunk["kind"];
  readonly input: BlacklistImportAuthorsChunkInput | BlacklistImportTagsChunkInput;
}): Promise<ImportChunkStageResult> {
  const transaction = options.database.transaction(stagingStoreNames(options.kind), "readwrite");
  const done = transactionDone(transaction);
  try {
    const now = currentTime(options.clock);
    const session = requireActiveSession(
      await storedSessionFrom(transaction, options.input.sessionId),
      now,
    );
    const chunk = chunkRecord(options.input, options.kind);
    validateChunkRange(session, chunk);
    const existing = await existingChunkFrom(transaction, chunk);
    if (existing) {
      await done;
      return { status: "duplicate", session: publicSession(session, now) };
    }
    if (options.kind === "authors") {
      stageAuthorRecords(transaction, options.input as BlacklistImportAuthorsChunkInput);
    } else {
      stageTagRecords(transaction, options.input as BlacklistImportTagsChunkInput);
    }
    transaction.objectStore(BLACKLIST_STORE_NAMES.importChunks).add(chunk);
    const updated = updatedSession(session, chunk, now);
    transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions).put(updated);
    await done;
    return { status: "staged", session: updated };
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    if (error instanceof ImportChunkConflictError || isConstraintError(error)) {
      throw new ImportChunkConflictError();
    }
    throw error;
  }
}

export function stageImportAuthorsChunk(options: {
  readonly database: IDBDatabase;
  readonly clock: () => number;
  readonly input: BlacklistImportAuthorsChunkInput;
}): Promise<ImportChunkStageResult> {
  const input = parseBlacklistImportAuthorsChunkInput(options.input);
  if (!input) throw new Error("Blacklist import author chunk is invalid.");
  return stageChunk({ ...options, kind: "authors", input });
}

export function stageImportTagsChunk(options: {
  readonly database: IDBDatabase;
  readonly clock: () => number;
  readonly input: BlacklistImportTagsChunkInput;
}): Promise<ImportChunkStageResult> {
  const input = parseBlacklistImportTagsChunkInput(options.input);
  if (!input) throw new Error("Blacklist import tag chunk is invalid.");
  return stageChunk({ ...options, kind: "tags", input });
}

export async function inspectImportStaging(
  database: IDBDatabase,
  sessionId: string,
  clock: () => number,
): Promise<BlacklistImportSessionDto | null> {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.importSessions, "readonly");
  const done = transactionDone(transaction);
  const session = await storedSessionFrom(transaction, sessionId);
  const now = currentTime(clock);
  await done;
  return session ? publicSession(session, now) : null;
}

function sessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId], [sessionId, []]);
}

export function deleteImportSessionRecords(transaction: IDBTransaction, sessionId: string): void {
  for (const storeName of [
    BLACKLIST_STORE_NAMES.importAuthors,
    BLACKLIST_STORE_NAMES.importIdentifiers,
    BLACKLIST_STORE_NAMES.importTags,
    BLACKLIST_STORE_NAMES.importChunks,
  ]) {
    transaction.objectStore(storeName).delete(sessionRange(sessionId));
  }
  transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions).delete(sessionId);
}

export async function abortImportStaging(
  database: IDBDatabase,
  sessionId: string,
): Promise<boolean> {
  const transaction = database.transaction(
    [
      BLACKLIST_STORE_NAMES.importSessions,
      BLACKLIST_STORE_NAMES.importAuthors,
      BLACKLIST_STORE_NAMES.importIdentifiers,
      BLACKLIST_STORE_NAMES.importTags,
      BLACKLIST_STORE_NAMES.importChunks,
    ],
    "readwrite",
  );
  const done = transactionDone(transaction);
  const exists = (await storedSessionFrom(transaction, sessionId)) !== null;
  if (exists) deleteImportSessionRecords(transaction, sessionId);
  await done;
  return exists;
}

export async function cleanupExpiredImportStaging(
  database: IDBDatabase,
  clock: () => number,
): Promise<number> {
  const transaction = database.transaction(
    [
      BLACKLIST_STORE_NAMES.importSessions,
      BLACKLIST_STORE_NAMES.importAuthors,
      BLACKLIST_STORE_NAMES.importIdentifiers,
      BLACKLIST_STORE_NAMES.importTags,
      BLACKLIST_STORE_NAMES.importChunks,
    ],
    "readwrite",
  );
  const done = transactionDone(transaction);
  const keys = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importSessions)
      .index("by-expires-at")
      .getAllKeys(IDBKeyRange.upperBound(currentTime(clock))),
  );
  const sessionIds = keys.filter((key): key is string => typeof key === "string");
  if (sessionIds.length !== keys.length) throw new Error("Import session key is unreadable.");
  for (const sessionId of sessionIds) deleteImportSessionRecords(transaction, sessionId);
  await done;
  return sessionIds.length;
}

export { storedSessionFrom };
