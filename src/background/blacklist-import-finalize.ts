import type { BlacklistedAuthor, CocoonTag } from "../content/blacklist-state.ts";
import type { BlacklistTransferSummaryDto } from "../core/blacklist-transfer-rpc-contract.ts";
import {
  parseStoredImportAuthor,
  parseStoredImportChunk,
  parseStoredImportIdentifier,
  parseStoredImportTag,
  type StoredImportAuthor,
  type StoredImportSession,
  type StoredImportTag,
} from "./blacklist-idb-import-schema.ts";
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  authorKey,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  identifierKey,
  parseStoredIdentifier,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
  type StoredBlacklistMetadata,
} from "./blacklist-idb-schema.ts";
import { deleteImportSessionRecords, storedSessionFrom } from "./blacklist-import-staging.ts";
import {
  ImportSessionExpiredError,
  ImportSessionNotFoundError,
  IncompleteBlacklistImportError,
  TransferFinalizeConflictError,
} from "./blacklist-transfer-repository-errors.ts";

function abort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Preserve the validation, quota, or request failure.
  }
}

function currentTime(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Import clock is invalid.");
  return value;
}

function requireReadySession(
  session: StoredImportSession | null,
  now: number,
): StoredImportSession {
  if (!session) throw new ImportSessionNotFoundError();
  if (now >= session.expiresAt) throw new ImportSessionExpiredError();
  if (session.status !== "ready") throw new IncompleteBlacklistImportError();
  return session;
}

async function metadataFrom(transaction: IDBTransaction): Promise<StoredBlacklistMetadata> {
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
  );
  const metadata = parseStoredMetadata(raw);
  if (!metadata) throw new Error("IndexedDB blacklist metadata is unreadable.");
  if (metadata.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Blacklist revision is exhausted.");
  }
  return metadata;
}

function chunkRange(sessionId: string, kind: "authors" | "tags"): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, kind, 0], [sessionId, kind, Number.MAX_SAFE_INTEGER]);
}

interface ChunkSequenceState {
  expectedChunk: number;
  expectedStart: number;
  bytes: number;
}

function requireCompleteChunkSequence(
  state: ChunkSequenceState,
  session: StoredImportSession,
  kind: "authors" | "tags",
): void {
  const metadata = session.metadata;
  const expectedChunks = kind === "authors" ? metadata.authorChunkCount : metadata.tagChunkCount;
  const expectedCount = kind === "authors" ? metadata.authorCount : metadata.tagCount;
  const expectedBytes = kind === "authors" ? metadata.authorsBytes : metadata.tagsBytes;
  if (state.expectedChunk !== expectedChunks) throw new IncompleteBlacklistImportError();
  if (state.expectedStart !== expectedCount) throw new IncompleteBlacklistImportError();
  if (state.bytes !== expectedBytes) throw new IncompleteBlacklistImportError();
}

function advanceChunkSequence(
  state: ChunkSequenceState,
  cursor: IDBCursorWithValue,
  session: StoredImportSession,
  kind: "authors" | "tags",
): void {
  const chunk = parseStoredImportChunk(cursor.value);
  if (!chunk || chunk.sessionId !== session.sessionId || chunk.kind !== kind) {
    throw new IncompleteBlacklistImportError();
  }
  if (chunk.chunkIndex !== state.expectedChunk || chunk.startIndex !== state.expectedStart) {
    throw new IncompleteBlacklistImportError();
  }
  state.bytes += chunk.payloadBytes - 2 + (state.expectedChunk > 0 ? 1 : 0);
  state.expectedChunk += 1;
  state.expectedStart += chunk.itemCount;
}

function validateChunkSequence(
  transaction: IDBTransaction,
  session: StoredImportSession,
  kind: "authors" | "tags",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const state: ChunkSequenceState = { expectedChunk: 0, expectedStart: 0, bytes: 2 };
    const request = transaction
      .objectStore(BLACKLIST_STORE_NAMES.importChunks)
      .openCursor(chunkRange(session.sessionId, kind));
    request.onerror = () => reject(request.error ?? new Error("Import chunk scan failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      try {
        if (!cursor) {
          requireCompleteChunkSequence(state, session, kind);
          resolve();
          return;
        }
        advanceChunkSequence(state, cursor, session, kind);
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

async function stagedTags(
  transaction: IDBTransaction,
  session: StoredImportSession,
): Promise<StoredImportTag[]> {
  const raw = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importTags)
      .index("by-session")
      .getAll(session.sessionId, session.metadata.tagCount + 1),
  );
  if (raw.length !== session.metadata.tagCount) throw new IncompleteBlacklistImportError();
  const tags = raw.map(parseStoredImportTag);
  if (tags.some((tag) => tag === null)) throw new IncompleteBlacklistImportError();
  const parsed = tags as StoredImportTag[];
  parsed.sort((left, right) => left.index - right.index);
  if (parsed.some((tag, index) => tag.sessionId !== session.sessionId || tag.index !== index)) {
    throw new IncompleteBlacklistImportError();
  }
  if (parsed.find(({ tagId }) => tagId === "default")?.name !== "default") {
    throw new IncompleteBlacklistImportError();
  }
  return parsed;
}

function logicalTag(tag: StoredImportTag): CocoonTag {
  return { tagId: tag.tagId, name: tag.name };
}

function logicalAuthor(author: StoredImportAuthor, tagId = author.tagId): BlacklistedAuthor {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorNameAtCapture,
    tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.blockSource,
  };
}

async function verifyStagedIdentifiers(
  transaction: IDBTransaction,
  sessionId: string,
  author: StoredImportAuthor,
): Promise<number> {
  let count = 0;
  for (const identifier of [author.userId, author.memberHashId]) {
    if (identifier === null) continue;
    const raw = await requestResult(
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.importIdentifiers)
        .get([sessionId, author.platformId, identifier]),
    );
    const parsed = parseStoredImportIdentifier(raw);
    if (
      !parsed ||
      parsed.sessionId !== sessionId ||
      parsed.platformId !== author.platformId ||
      parsed.identifier !== identifier ||
      parsed.authorIndex !== author.index
    ) {
      throw new IncompleteBlacklistImportError();
    }
    count += 1;
  }
  return count;
}

interface StagedAuthorScanState {
  expectedIndex: number;
  identifierCount: number;
}

function stagedAuthorRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
}

async function visitStagedAuthorCursor(
  options: {
    readonly transaction: IDBTransaction;
    readonly session: StoredImportSession;
    readonly visit: (author: StoredImportAuthor) => Promise<void>;
  },
  state: StagedAuthorScanState,
  cursor: IDBCursorWithValue,
): Promise<void> {
  const author = parseStoredImportAuthor(cursor.value);
  if (!author || author.sessionId !== options.session.sessionId) {
    throw new IncompleteBlacklistImportError();
  }
  if (author.index !== state.expectedIndex) throw new IncompleteBlacklistImportError();
  state.identifierCount += await verifyStagedIdentifiers(
    options.transaction,
    options.session.sessionId,
    author,
  );
  await options.visit(author);
  state.expectedIndex += 1;
}

function scanStagedAuthors(options: {
  readonly transaction: IDBTransaction;
  readonly session: StoredImportSession;
  readonly visit: (author: StoredImportAuthor) => Promise<void>;
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const state: StagedAuthorScanState = { expectedIndex: 0, identifierCount: 0 };
    const request = options.transaction
      .objectStore(BLACKLIST_STORE_NAMES.importAuthors)
      .openCursor(stagedAuthorRange(options.session.sessionId));
    request.onerror = () => reject(request.error ?? new Error("Import author scan failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        if (state.expectedIndex !== options.session.metadata.authorCount) {
          reject(new IncompleteBlacklistImportError());
          return;
        }
        resolve(state.identifierCount);
        return;
      }
      void (async () => {
        try {
          await visitStagedAuthorCursor(options, state, cursor);
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      })();
    };
  });
}

async function verifyIdentifierCount(
  transaction: IDBTransaction,
  session: StoredImportSession,
  expected: number,
): Promise<void> {
  const actual = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importIdentifiers)
      .index("by-session")
      .count(session.sessionId),
  );
  if (actual !== expected) throw new IncompleteBlacklistImportError();
}

function replaceMetadata(
  current: StoredBlacklistMetadata,
  authorCount: number,
  tagCount: number,
): StoredBlacklistMetadata {
  return {
    key: BLACKLIST_METADATA_KEY,
    migrationComplete: true,
    logicalSchemaVersion: 5,
    revision: current.revision + 1,
    authorCount,
    tagCount,
    nextAuthorOrder: authorCount,
    nextTagOrder: tagCount,
  };
}

async function replaceFromStaging(
  transaction: IDBTransaction,
  session: StoredImportSession,
  tags: readonly StoredImportTag[],
  current: StoredBlacklistMetadata,
): Promise<StoredBlacklistMetadata> {
  const liveAuthors = transaction.objectStore(BLACKLIST_STORE_NAMES.authors);
  const liveIdentifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  const liveTags = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  liveAuthors.clear();
  liveIdentifiers.clear();
  liveTags.clear();
  tags.forEach((tag, order) => liveTags.add(createStoredTag(logicalTag(tag), order)));
  const tagIds = new Set(tags.map(({ tagId }) => tagId));
  const identifierCount = await scanStagedAuthors({
    transaction,
    session,
    async visit(staged) {
      if (!tagIds.has(staged.tagId)) throw new IncompleteBlacklistImportError();
      const author = logicalAuthor(staged);
      liveAuthors.add(createStoredAuthor(author, staged.index));
      liveIdentifiers.add(createStoredIdentifier(author, author.userId));
      if (author.memberHashId !== null) {
        liveIdentifiers.add(createStoredIdentifier(author, author.memberHashId));
      }
    },
  });
  await verifyIdentifierCount(transaction, session, identifierCount);
  return replaceMetadata(current, session.metadata.authorCount, session.metadata.tagCount);
}

async function matchingLiveTags(
  store: IDBObjectStore,
  imported: StoredImportTag,
): Promise<{
  readonly sameId: ReturnType<typeof parseStoredTag>;
  readonly sameName: ReturnType<typeof parseStoredTag>;
}> {
  const [rawSameId, rawSameName] = await Promise.all([
    requestResult(store.get(imported.tagId)),
    requestResult(store.index("by-name").get(imported.nameKey)),
  ]);
  const sameId = rawSameId === undefined ? null : parseStoredTag(rawSameId);
  const sameName = rawSameName === undefined ? null : parseStoredTag(rawSameName);
  if (rawSameId !== undefined && !sameId) throw new Error("IndexedDB live tag is unreadable.");
  if (rawSameName !== undefined && !sameName) throw new Error("IndexedDB live tag is unreadable.");
  return { sameId, sameName };
}

function reusedTagId(
  imported: StoredImportTag,
  matches: Awaited<ReturnType<typeof matchingLiveTags>>,
): string | null {
  if (matches.sameId && matches.sameId.nameKey !== imported.nameKey) {
    throw new TransferFinalizeConflictError();
  }
  if (matches.sameName) return matches.sameName.tagId;
  return matches.sameId?.tagId ?? null;
}

async function importedTagMap(
  transaction: IDBTransaction,
  tags: readonly StoredImportTag[],
  current: StoredBlacklistMetadata,
): Promise<{ readonly ids: ReadonlyMap<string, string>; readonly added: number }> {
  const store = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  const ids = new Map<string, string>();
  let added = 0;
  for (const imported of tags) {
    const reused = reusedTagId(imported, await matchingLiveTags(store, imported));
    if (reused) {
      ids.set(imported.tagId, reused);
      continue;
    }
    store.add(createStoredTag(logicalTag(imported), current.nextTagOrder + added));
    ids.set(imported.tagId, imported.tagId);
    added += 1;
  }
  return { ids, added };
}

async function liveIdentifierOwner(
  transaction: IDBTransaction,
  platformId: string,
  identifier: string,
): Promise<string | null> {
  const raw = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.identifiers)
      .get(identifierKey(platformId, identifier)),
  );
  if (raw === undefined) return null;
  const parsed = parseStoredIdentifier(raw);
  if (!parsed) throw new Error("IndexedDB live identifier is unreadable.");
  return parsed.authorKey;
}

async function mergeAuthor(
  transaction: IDBTransaction,
  staged: StoredImportAuthor,
  tagIds: ReadonlyMap<string, string>,
  order: number,
): Promise<boolean> {
  const expectedOwner = authorKey(staged.platformId, staged.userId);
  const userOwner = await liveIdentifierOwner(transaction, staged.platformId, staged.userId);
  if (userOwner === expectedOwner) return false;
  if (userOwner !== null) throw new TransferFinalizeConflictError();
  if (staged.memberHashId !== null) {
    const aliasOwner = await liveIdentifierOwner(
      transaction,
      staged.platformId,
      staged.memberHashId,
    );
    if (aliasOwner !== null) throw new TransferFinalizeConflictError();
  }
  const tagId = tagIds.get(staged.tagId);
  if (!tagId) throw new IncompleteBlacklistImportError();
  const author = logicalAuthor(staged, tagId);
  transaction.objectStore(BLACKLIST_STORE_NAMES.authors).add(createStoredAuthor(author, order));
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  identifiers.add(createStoredIdentifier(author, author.userId));
  if (author.memberHashId !== null) {
    identifiers.add(createStoredIdentifier(author, author.memberHashId));
  }
  return true;
}

async function mergeFromStaging(
  transaction: IDBTransaction,
  session: StoredImportSession,
  tags: readonly StoredImportTag[],
  current: StoredBlacklistMetadata,
): Promise<StoredBlacklistMetadata> {
  const mapping = await importedTagMap(transaction, tags, current);
  let addedAuthors = 0;
  const identifierCount = await scanStagedAuthors({
    transaction,
    session,
    async visit(staged) {
      const added = await mergeAuthor(
        transaction,
        staged,
        mapping.ids,
        current.nextAuthorOrder + addedAuthors,
      );
      if (added) addedAuthors += 1;
    },
  });
  await verifyIdentifierCount(transaction, session, identifierCount);
  return {
    ...current,
    revision: current.revision + 1,
    authorCount: current.authorCount + addedAuthors,
    tagCount: current.tagCount + mapping.added,
    nextAuthorOrder: current.nextAuthorOrder + addedAuthors,
    nextTagOrder: current.nextTagOrder + mapping.added,
  };
}

export async function finalizeImport(options: {
  readonly database: IDBDatabase;
  readonly sessionId: string;
  readonly mode: "merge" | "replace";
  readonly clock: () => number;
  readonly beforeCommit?: (transaction: IDBTransaction) => void;
}): Promise<BlacklistTransferSummaryDto> {
  const transaction = options.database.transaction(
    Object.values(BLACKLIST_STORE_NAMES),
    "readwrite",
  );
  const done = transactionDone(transaction);
  try {
    const session = requireReadySession(
      await storedSessionFrom(transaction, options.sessionId),
      currentTime(options.clock),
    );
    await validateChunkSequence(transaction, session, "authors");
    await validateChunkSequence(transaction, session, "tags");
    const tags = await stagedTags(transaction, session);
    const current = await metadataFrom(transaction);
    const next =
      options.mode === "replace"
        ? await replaceFromStaging(transaction, session, tags, current)
        : await mergeFromStaging(transaction, session, tags, current);
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    options.beforeCommit?.(transaction);
    deleteImportSessionRecords(transaction, session.sessionId);
    await done;
    return {
      revision: next.revision,
      authorCount: next.authorCount,
      tagCount: next.tagCount,
    };
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}
