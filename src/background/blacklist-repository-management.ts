import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type { AuthorIdentity, BlacklistedAuthor, CocoonTag } from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import {
  BLACKLIST_STORE_NAMES,
  authorKey,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  identifierKey,
  incrementMetadata,
  parseStoredAuthor,
  parseStoredIdentifier,
  requestResult,
  transactionDone,
} from "./blacklist-idb-schema.ts";
import {
  abortTransaction as abort,
  finishTransaction as finish,
  isBoundedStableId,
  isTrimmedNonEmpty,
  logicalAuthor,
  metadataFrom,
  mutationContext as context,
  storedAuthorFrom,
  storedTagFrom,
} from "./blacklist-repository-records.ts";
import type {
  AuthorBatchRemovalResult,
  AuthorRemovalResult,
  AuthorRestorationResult,
  TagDeletionMutationResult,
  TagRenameResult,
} from "./blacklist-repository-types.ts";

const {
  DEFAULT_TAG_ID,
  canonicalizeAuthorUserId,
  isValidPlatformId,
  parseBlacklistState,
  validateNewTagLabel,
} = backgroundBlacklistState as typeof BlacklistStateModule;

async function ownerFor(
  transaction: IDBTransaction,
  identity: AuthorIdentity,
): Promise<string | null> {
  if (!isValidPlatformId(identity.platformId) || !isTrimmedNonEmpty(identity.userId)) {
    return null;
  }
  const userId = canonicalizeAuthorUserId(identity.platformId, identity.userId);
  const raw = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.identifiers)
      .get(identifierKey(identity.platformId, userId)),
  );
  if (raw === undefined) return null;
  const identifier = parseStoredIdentifier(raw as unknown);
  if (!identifier) throw new Error("IndexedDB identifier record is unreadable.");
  const expected = authorKey(identity.platformId, userId);
  return identifier.authorKey === expected ? expected : null;
}

async function deleteAuthorRecords(transaction: IDBTransaction, key: string): Promise<void> {
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  const rawIdentifiers = await requestResult(identifiers.index("by-author").getAll(key));
  for (const raw of rawIdentifiers) {
    const identifier = parseStoredIdentifier(raw as unknown);
    if (!identifier || identifier.authorKey !== key) {
      throw new Error("IndexedDB identifier ownership is unreadable.");
    }
    identifiers.delete(identifier.identifierKey);
  }
  transaction.objectStore(BLACKLIST_STORE_NAMES.authors).delete(key);
}

async function missingTagDeletion(database: IDBDatabase): Promise<TagDeletionMutationResult> {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  await done;
  return { status: "missing", deletedTagId: null, migratedCount: 0, ...context(metadata) };
}

async function migrateTagAuthors(transaction: IDBTransaction, tag: CocoonTag): Promise<number> {
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.authors);
  const referenced = await requestResult(authors.index("by-tag").getAll(tag.tagId));
  for (const raw of referenced) {
    const stored = parseStoredAuthor(raw as unknown, tag);
    if (!stored) throw new Error("IndexedDB tag reference is unreadable.");
    authors.put(
      createStoredAuthor({ ...logicalAuthor(stored), tagId: DEFAULT_TAG_ID }, stored.order),
    );
  }
  return referenced.length;
}

export async function deleteTagTarget(
  database: IDBDatabase,
  tagId: string,
): Promise<TagDeletionMutationResult> {
  if (!isBoundedStableId(tagId)) return missingTagDeletion(database);
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readwrite",
  );
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    if (tagId === DEFAULT_TAG_ID) {
      return finish(done, {
        status: "protected",
        deletedTagId: null,
        migratedCount: 0,
        ...context(metadata),
      });
    }
    const tag = await storedTagFrom(transaction, tagId);
    if (!tag) {
      return finish(done, {
        status: "missing",
        deletedTagId: null,
        migratedCount: 0,
        ...context(metadata),
      });
    }
    const migratedCount = await migrateTagAuthors(transaction, {
      tagId: tag.tagId,
      name: tag.name,
    });
    transaction.objectStore(BLACKLIST_STORE_NAMES.tags).delete(tagId);
    const next = incrementMetadata(metadata, { tags: -1 });
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    return finish(done, {
      status: "persisted",
      deletedTagId: tagId,
      migratedCount,
      ...context(metadata, next),
    });
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

export async function removeAuthorTarget(
  database: IDBDatabase,
  identity: AuthorIdentity,
): Promise<AuthorRemovalResult> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    const owner = await ownerFor(transaction, identity);
    if (owner === null) {
      return finish(done, { status: "missing", removed: null, ...context(metadata) });
    }
    const stored = await storedAuthorFrom(transaction, owner);
    if (!stored) throw new Error("IndexedDB author record is unreadable.");
    await deleteAuthorRecords(transaction, owner);
    const next = incrementMetadata(metadata, { authors: -1 });
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    return finish(done, {
      status: "persisted",
      removed: logicalAuthor(stored),
      ...context(metadata, next),
    });
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

function validateRestoredAuthor(
  author: BlacklistedAuthor,
  tag: CocoonTag,
): BlacklistedAuthor | null {
  const tags =
    tag.tagId === DEFAULT_TAG_ID ? [tag] : [{ tagId: DEFAULT_TAG_ID, name: "default" }, tag];
  const parsed = parseBlacklistState({ schemaVersion: 5, tags, authors: [author] });
  return parsed.status === "valid" ? (parsed.state.authors[0] ?? null) : null;
}

export async function restoreAuthorTarget(
  database: IDBDatabase,
  untrustedAuthor: BlacklistedAuthor,
): Promise<AuthorRestorationResult> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    const tag = await storedTagFrom(transaction, untrustedAuthor.tagId);
    if (!tag) return finish(done, { status: "missing-tag", ...context(metadata) });
    const author = validateRestoredAuthor(untrustedAuthor, {
      tagId: tag.tagId,
      name: tag.name,
    });
    if (!author) return finish(done, { status: "invalid", ...context(metadata) });
    const owners = await Promise.all(
      [author.userId, author.memberHashId]
        .filter((identifier): identifier is string => identifier !== null)
        .map(async (identifier) =>
          requestResult(
            transaction
              .objectStore(BLACKLIST_STORE_NAMES.identifiers)
              .get(identifierKey(author.platformId, identifier)),
          ),
        ),
    );
    if (owners.some((owner) => owner !== undefined)) {
      return finish(done, { status: "conflict", ...context(metadata) });
    }
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.authors)
      .add(createStoredAuthor(author, metadata.nextAuthorOrder));
    const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
    identifiers.add(createStoredIdentifier(author, author.userId));
    if (author.memberHashId !== null) {
      identifiers.add(createStoredIdentifier(author, author.memberHashId));
    }
    const next = incrementMetadata(metadata, { authors: 1 });
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    return finish(done, { status: "persisted", ...context(metadata, next) });
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

export async function removeAuthorsTarget(
  database: IDBDatabase,
  identities: readonly AuthorIdentity[],
): Promise<AuthorBatchRemovalResult> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    const canonicalKeys = identities.map((identity) =>
      isValidPlatformId(identity.platformId) && isTrimmedNonEmpty(identity.userId)
        ? authorKey(
            identity.platformId,
            canonicalizeAuthorUserId(identity.platformId, identity.userId),
          )
        : null,
    );
    const unique = new Set(canonicalKeys);
    if (identities.length === 0 || unique.has(null) || unique.size !== identities.length) {
      return finish(done, { status: "empty", removedCount: 0, ...context(metadata) });
    }
    const owners = await Promise.all(
      identities.map(async (identity) => ownerFor(transaction, identity)),
    );
    if (owners.some((owner) => owner === null)) {
      return finish(done, { status: "missing", removedCount: 0, ...context(metadata) });
    }
    for (const owner of owners) await deleteAuthorRecords(transaction, owner as string);
    const next = incrementMetadata(metadata, { authors: -owners.length });
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    return finish(done, {
      status: "persisted",
      removedCount: owners.length,
      ...context(metadata, next),
    });
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

export async function renameTagTarget(
  database: IDBDatabase,
  tagId: string,
  name: string,
): Promise<TagRenameResult> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readwrite",
  );
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    if (tagId === DEFAULT_TAG_ID) {
      return finish(done, { status: "protected", tag: null, ...context(metadata) });
    }
    const stored = await storedTagFrom(transaction, tagId);
    if (!stored) return finish(done, { status: "missing", tag: null, ...context(metadata) });
    const validation = validateNewTagLabel(name, []);
    if (validation.error) {
      return finish(done, { status: "invalid", tag: null, ...context(metadata) });
    }
    if (validation.normalized === stored.name) {
      return finish(done, {
        status: "unchanged",
        tag: { tagId: stored.tagId, name: stored.name },
        ...context(metadata),
      });
    }
    const sameName = await requestResult(
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.tags)
        .index("by-name")
        .get(validation.normalized.toLowerCase()),
    );
    if (sameName !== undefined) {
      return finish(done, { status: "invalid", tag: null, ...context(metadata) });
    }
    const tag = { tagId, name: validation.normalized };
    transaction.objectStore(BLACKLIST_STORE_NAMES.tags).put(createStoredTag(tag, stored.order));
    const next = incrementMetadata(metadata);
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put(next);
    return finish(done, { status: "persisted", tag, ...context(metadata, next) });
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}
