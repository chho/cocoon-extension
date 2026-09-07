import {
  parseBlacklistState,
  type BlacklistState,
  type BlacklistedAuthor,
  type CocoonTag,
} from "../content/blacklist-state.ts";
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  LIVE_BLACKLIST_STORE_NAMES,
  createMetadata,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  openBlacklistDatabase,
  parseStoredAuthor,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
} from "./blacklist-idb-schema.ts";

export interface LogicalBlacklistStateRead {
  readonly state: BlacklistState;
  readonly revision: number;
}

function logicalAuthor(author: BlacklistedAuthor): BlacklistedAuthor {
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

async function readRawLogicalState(database: IDBDatabase): Promise<{
  readonly authors: readonly unknown[];
  readonly tags: readonly unknown[];
  readonly metadata: unknown;
}> {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const [authors, tags, metadata] = await Promise.all([
    requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).getAll()),
    requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.tags).getAll()),
    requestResult(
      transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
    ),
  ]);
  await done;
  return { authors, tags, metadata };
}

function parseLogicalTags(rawTags: readonly unknown[]): CocoonTag[] {
  const tags = rawTags
    .map(parseStoredTag)
    .sort((left, right) => (left?.order ?? -1) - (right?.order ?? -1));
  if (tags.some((tag) => tag === null)) throw new Error("Stored test tag is invalid.");
  return (tags as NonNullable<(typeof tags)[number]>[]).map(({ tagId, name }) => ({ tagId, name }));
}

function parseLogicalAuthors(
  rawAuthors: readonly unknown[],
  tags: readonly CocoonTag[],
): BlacklistedAuthor[] {
  const tagsById = new Map(tags.map((tag) => [tag.tagId, tag]));
  const authors = rawAuthors
    .map((value) => {
      const tagId = (value as { readonly tagId?: unknown }).tagId;
      const tag = typeof tagId === "string" ? tagsById.get(tagId) : undefined;
      return tag ? parseStoredAuthor(value, tag) : null;
    })
    .sort((left, right) => (left?.order ?? -1) - (right?.order ?? -1));
  if (authors.some((author) => author === null)) throw new Error("Stored test author is invalid.");
  return (authors as NonNullable<(typeof authors)[number]>[]).map(logicalAuthor);
}

function validatedLogicalState(
  authors: readonly BlacklistedAuthor[],
  tags: readonly CocoonTag[],
  rawMetadata: unknown,
): LogicalBlacklistStateRead {
  const parsed = parseBlacklistState({ schemaVersion: 5, authors, tags });
  const metadata = parseStoredMetadata(rawMetadata);
  if (parsed.status !== "valid" || !metadata)
    throw new Error("Stored logical test state is invalid.");
  if (metadata.authorCount !== parsed.state.authors.length) {
    throw new Error("Stored logical test counts are inconsistent.");
  }
  if (metadata.tagCount !== parsed.state.tags.length) {
    throw new Error("Stored logical test counts are inconsistent.");
  }
  return { state: parsed.state, revision: metadata.revision };
}

export async function readLogicalState(
  factory: IDBFactory,
  databaseName: string,
): Promise<LogicalBlacklistStateRead> {
  const database = await openBlacklistDatabase(factory, databaseName);
  try {
    const raw = await readRawLogicalState(database);
    const tags = parseLogicalTags(raw.tags);
    return validatedLogicalState(parseLogicalAuthors(raw.authors, tags), tags, raw.metadata);
  } finally {
    database.close();
  }
}

export async function storeLogicalState(
  factory: IDBFactory,
  databaseName: string,
  state: BlacklistState,
  revision = 1,
): Promise<void> {
  const parsed = parseBlacklistState(state);
  if (parsed.status !== "valid") throw new Error("Test state must be valid schema v5 data.");
  const database = await openBlacklistDatabase(factory, databaseName);
  try {
    const transaction = database.transaction(LIVE_BLACKLIST_STORE_NAMES, "readwrite");
    const done = transactionDone(transaction);
    for (const storeName of LIVE_BLACKLIST_STORE_NAMES) {
      transaction.objectStore(storeName).clear();
    }
    parsed.state.tags.forEach((tag, order) => {
      transaction.objectStore(BLACKLIST_STORE_NAMES.tags).add(createStoredTag(tag, order));
    });
    parsed.state.authors.forEach((author, order) => {
      transaction.objectStore(BLACKLIST_STORE_NAMES.authors).add(createStoredAuthor(author, order));
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.identifiers)
        .add(createStoredIdentifier(author, author.userId));
      if (author.memberHashId !== null) {
        transaction
          .objectStore(BLACKLIST_STORE_NAMES.identifiers)
          .add(createStoredIdentifier(author, author.memberHashId));
      }
    });
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.metadata)
      .add(createMetadata(parsed.state, revision));
    await done;
  } finally {
    database.close();
  }
}
