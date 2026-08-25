import type { BlacklistedAuthor, CocoonTag } from "../content/blacklist-state.ts";
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  createStoredAuthor,
  createStoredIdentifier,
  identifierKey,
  parseStoredAuthor,
  parseStoredIdentifier,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
  type StoredBlacklistMetadata,
  type StoredTag,
} from "./blacklist-idb-schema.ts";
import type { MutationContext } from "./blacklist-repository-types.ts";

export interface RepositoryTransactionContext {
  readonly transaction: IDBTransaction;
  readonly done: Promise<void>;
  readonly metadata: StoredBlacklistMetadata;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isBoundedStableId(value: unknown): value is string {
  return isTrimmedNonEmpty(value) && Array.from(value).length <= 512;
}

export function isBoundedAuthorName(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length <= 500;
}

export function logicalAuthor(
  author: NonNullable<ReturnType<typeof parseStoredAuthor>>,
): BlacklistedAuthor {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorNameAtCapture,
    tagId: author.tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.blockSource,
  };
}

export function mutationContext(base: StoredBlacklistMetadata, current = base): MutationContext {
  return {
    baseRevision: base.revision,
    revision: current.revision,
    authorCount: current.authorCount,
    tagCount: current.tagCount,
  };
}

export async function metadataFrom(transaction: IDBTransaction): Promise<StoredBlacklistMetadata> {
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
  );
  const metadata = parseStoredMetadata(raw);
  if (!metadata) throw new Error("IndexedDB blacklist metadata is unreadable.");
  return metadata;
}

export async function createTransactionContext(
  transaction: IDBTransaction,
): Promise<RepositoryTransactionContext> {
  const done = transactionDone(transaction);
  return { transaction, done, metadata: await metadataFrom(transaction) };
}

export async function identifierOwner(
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
  if (!parsed) throw new Error("IndexedDB identifier record is unreadable.");
  return parsed.authorKey;
}

export async function storedTagFrom(
  transaction: IDBTransaction,
  tagId: string,
): Promise<StoredTag | null> {
  const raw = await requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.tags).get(tagId));
  if (raw === undefined) return null;
  const tag = parseStoredTag(raw);
  if (!tag) throw new Error("IndexedDB tag record is unreadable.");
  return tag;
}

export async function tagFrom(
  transaction: IDBTransaction,
  tagId: string,
): Promise<CocoonTag | null> {
  const tag = await storedTagFrom(transaction, tagId);
  return tag ? { tagId: tag.tagId, name: tag.name } : null;
}

export async function storedAuthorFrom(
  transaction: IDBTransaction,
  key: string,
): Promise<ReturnType<typeof parseStoredAuthor>> {
  const raw = await requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).get(key));
  if (!isRecord(raw) || typeof raw.tagId !== "string") return null;
  const tag = await storedTagFrom(transaction, raw.tagId);
  return tag ? parseStoredAuthor(raw, { tagId: tag.tagId, name: tag.name }) : null;
}

export async function authorFrom(
  transaction: IDBTransaction,
  key: string,
): Promise<BlacklistedAuthor> {
  const stored = await storedAuthorFrom(transaction, key);
  if (!stored) throw new Error("IndexedDB author record is unreadable.");
  return logicalAuthor(stored);
}

export async function storedAuthorOrder(transaction: IDBTransaction, key: string): Promise<number> {
  const raw = await requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).get(key));
  if (!isRecord(raw) || !Number.isSafeInteger(raw.order)) {
    throw new Error("IndexedDB author order is unreadable.");
  }
  return raw.order as number;
}

export async function finishTransaction<Result>(
  done: Promise<void>,
  result: Result,
): Promise<Result> {
  await done;
  return result;
}

export function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Preserve the original validation or request error.
  }
}

export function putMetadata(transaction: IDBTransaction, metadata: StoredBlacklistMetadata): void {
  transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(metadata);
}

export function putNewAuthor(
  transaction: IDBTransaction,
  author: BlacklistedAuthor,
  metadata: StoredBlacklistMetadata,
): void {
  transaction
    .objectStore(BLACKLIST_STORE_NAMES.authors)
    .add(createStoredAuthor(author, metadata.nextAuthorOrder));
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  identifiers.add(createStoredIdentifier(author, author.userId));
  if (author.memberHashId !== null) {
    identifiers.add(createStoredIdentifier(author, author.memberHashId));
  }
}
