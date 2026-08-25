import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  BlacklistedAuthor,
  CocoonTag,
  CommitInput,
  UpvoterCommitInput,
} from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import {
  BLACKLIST_STORE_NAMES,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  incrementMetadata,
  requestResult,
  transactionDone,
} from "./blacklist-idb-schema.ts";
import {
  abortTransaction as abort,
  authorFrom,
  createTransactionContext as createTargetContext,
  finishTransaction as finish,
  identifierOwner,
  isBoundedAuthorName,
  isBoundedStableId,
  isTrimmedNonEmpty,
  metadataFrom,
  mutationContext as context,
  putMetadata,
  putNewAuthor,
  storedAuthorOrder,
  tagFrom,
  type RepositoryTransactionContext as TargetContext,
} from "./blacklist-repository-records.ts";
import type {
  AliasMutationResult,
  AuthorMutationResult,
  DirectPreflightInput,
} from "./blacklist-repository-types.ts";

const {
  DEFAULT_TAG_ID,
  ZHIHU_PLATFORM_ID,
  canonicalizeAuthorUserId,
  isValidBlacklistTimestamp,
  isValidPlatformId,
  normalizeMemberHashId,
  validateNewTagLabel,
} = backgroundBlacklistState as typeof BlacklistStateModule;

async function currentMetadata(database: IDBDatabase) {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  await done;
  return metadata;
}

async function invalidAuthorMutation(database: IDBDatabase): Promise<AuthorMutationResult> {
  const metadata = await currentMetadata(database);
  return {
    status: "invalid",
    author: null,
    tag: null,
    ...context(metadata),
  };
}

async function invalidAliasMutation(database: IDBDatabase): Promise<AliasMutationResult> {
  const metadata = await currentMetadata(database);
  return { status: "invalid", author: null, ...context(metadata) };
}

interface CanonicalAliasInput {
  readonly platformId: typeof ZHIHU_PLATFORM_ID;
  readonly userId: string;
  readonly memberHashId: string;
}

function hasValidDirectFields(input: CommitInput): boolean {
  return (
    input.platformId === ZHIHU_PLATFORM_ID &&
    isValidPlatformId(input.platformId) &&
    isBoundedStableId(input.userId) &&
    canonicalizeAuthorUserId(input.platformId, input.userId) === input.userId &&
    isBoundedAuthorName(input.authorNameAtCapture) &&
    isBoundedStableId(input.tag.tagId) &&
    isTrimmedNonEmpty(input.tag.name) &&
    Array.from(input.tag.name).length <= 30 &&
    isValidBlacklistTimestamp(input.blacklistedAt)
  );
}

function isCompatibleMemberHash(
  platformId: string,
  rawMemberHashId: string | null,
  memberHashId: string | null,
): boolean {
  if (rawMemberHashId === null) return true;
  if (memberHashId === null) return false;
  return platformId === ZHIHU_PLATFORM_ID;
}

function canonicalDirectInput(input: CommitInput): CommitInput | null {
  if (!hasValidDirectFields(input)) return null;
  const memberHashId =
    input.memberHashId === null ? null : normalizeMemberHashId(input.memberHashId);
  if (!isCompatibleMemberHash(input.platformId, input.memberHashId, memberHashId)) return null;
  if (input.memberHashId !== null && memberHashId !== input.memberHashId) return null;
  if (memberHashId === input.userId) return null;
  return { ...input, memberHashId };
}

async function selectedTag(
  transaction: IDBTransaction,
  input: CommitInput,
): Promise<{ readonly tag: CocoonTag; readonly created: boolean } | null> {
  if (!input.isNewTag) {
    const tag = await tagFrom(transaction, input.tag.tagId);
    return tag ? { tag, created: false } : null;
  }
  const validation = validateNewTagLabel(input.tag.name, []);
  if (validation.error || validation.normalized !== input.tag.name) return null;
  if (!isBoundedStableId(input.tag.tagId)) return null;
  const tags = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  const [sameId, sameName] = await Promise.all([
    requestResult(tags.get(input.tag.tagId)),
    requestResult(tags.index("by-name").get(input.tag.name.toLowerCase())),
  ]);
  return sameId === undefined && sameName === undefined ? { tag: input.tag, created: true } : null;
}

async function persistDirectAlias(
  target: TargetContext,
  input: CommitInput & { readonly memberHashId: string },
  existing: BlacklistedAuthor,
  owner: string,
): Promise<AuthorMutationResult> {
  const updated = { ...existing, memberHashId: input.memberHashId };
  const order = await storedAuthorOrder(target.transaction, owner);
  target.transaction
    .objectStore(BLACKLIST_STORE_NAMES.authors)
    .put(createStoredAuthor(updated, order));
  target.transaction
    .objectStore(BLACKLIST_STORE_NAMES.identifiers)
    .add(createStoredIdentifier(updated, input.memberHashId));
  const next = incrementMetadata(target.metadata);
  putMetadata(target.transaction, next);
  return finish(target.done, {
    status: "duplicate",
    author: updated,
    tag: null,
    ...context(target.metadata, next),
  });
}

async function commitExistingAuthor(
  target: TargetContext,
  input: CommitInput,
  userOwner: string,
  hashOwner: string | null,
): Promise<AuthorMutationResult> {
  const existing = await authorFrom(target.transaction, userOwner);
  const identityMatches =
    existing.platformId === input.platformId && existing.userId === input.userId;
  if (!identityMatches) {
    return finish(target.done, {
      status: "invalid",
      author: null,
      tag: null,
      ...context(target.metadata),
    });
  }
  if (input.memberHashId === null || existing.memberHashId === input.memberHashId) {
    return finish(target.done, {
      status: "duplicate",
      author: existing,
      tag: null,
      ...context(target.metadata),
    });
  }
  if (existing.memberHashId !== null || hashOwner !== null) {
    return finish(target.done, {
      status: "invalid",
      author: null,
      tag: null,
      ...context(target.metadata),
    });
  }
  return persistDirectAlias(
    target,
    { ...input, memberHashId: input.memberHashId },
    existing,
    userOwner,
  );
}

async function commitNewAuthor(
  target: TargetContext,
  input: CommitInput,
  hashOwner: string | null,
): Promise<AuthorMutationResult> {
  if (hashOwner !== null) {
    return finish(target.done, {
      status: "invalid",
      author: null,
      tag: null,
      ...context(target.metadata),
    });
  }
  const selection = await selectedTag(target.transaction, input);
  if (!selection) {
    return finish(target.done, {
      status: "invalid",
      author: null,
      tag: null,
      ...context(target.metadata),
    });
  }
  const author: BlacklistedAuthor = {
    platformId: input.platformId,
    userId: input.userId,
    memberHashId: input.memberHashId,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: selection.tag.tagId,
    blacklistedAt: input.blacklistedAt,
    blockSource: "direct",
  };
  putNewAuthor(target.transaction, author, target.metadata);
  if (selection.created) {
    target.transaction
      .objectStore(BLACKLIST_STORE_NAMES.tags)
      .add(createStoredTag(selection.tag, target.metadata.nextTagOrder));
  }
  const next = incrementMetadata(target.metadata, { authors: 1, tags: selection.created ? 1 : 0 });
  putMetadata(target.transaction, next);
  return finish(target.done, {
    status: "persisted",
    author,
    tag: selection.created ? selection.tag : null,
    ...context(target.metadata, next),
  });
}

export async function commitAuthorTarget(
  database: IDBDatabase,
  untrustedInput: CommitInput,
): Promise<AuthorMutationResult> {
  const input = canonicalDirectInput(untrustedInput);
  if (!input) return invalidAuthorMutation(database);
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const target = { transaction, done, metadata: await metadataFrom(transaction) };
    const [userOwner, hashOwner] = await Promise.all([
      identifierOwner(transaction, input.platformId, input.userId),
      input.memberHashId === null
        ? Promise.resolve(null)
        : identifierOwner(transaction, input.platformId, input.memberHashId),
    ]);
    return userOwner === null
      ? commitNewAuthor(target, input, hashOwner)
      : commitExistingAuthor(target, input, userOwner, hashOwner);
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

function canonicalAliasInput(
  platformId: string,
  userIdInput: string,
  memberHashIdInput: string,
): CanonicalAliasInput | null {
  if (platformId !== ZHIHU_PLATFORM_ID || !isValidPlatformId(platformId)) return null;
  if (!isBoundedStableId(userIdInput)) return null;
  const userId = canonicalizeAuthorUserId(platformId, userIdInput);
  const memberHashId = normalizeMemberHashId(memberHashIdInput);
  if (userId !== userIdInput || memberHashId !== memberHashIdInput) return null;
  if (memberHashId === null || memberHashId === userId) return null;
  return { platformId, userId, memberHashId };
}

async function persistMemberHash(
  target: TargetContext,
  existing: BlacklistedAuthor,
  owner: string,
  memberHashId: string,
): Promise<AliasMutationResult> {
  const updated = { ...existing, memberHashId };
  const order = await storedAuthorOrder(target.transaction, owner);
  target.transaction
    .objectStore(BLACKLIST_STORE_NAMES.authors)
    .put(createStoredAuthor(updated, order));
  target.transaction
    .objectStore(BLACKLIST_STORE_NAMES.identifiers)
    .add(createStoredIdentifier(updated, memberHashId));
  const next = incrementMetadata(target.metadata);
  putMetadata(target.transaction, next);
  return finish(target.done, {
    status: "persisted",
    author: updated,
    ...context(target.metadata, next),
  });
}

async function applyMemberHashBackfill(
  target: TargetContext,
  input: CanonicalAliasInput,
): Promise<AliasMutationResult> {
  const [owner, aliasOwner] = await Promise.all([
    identifierOwner(target.transaction, input.platformId, input.userId),
    identifierOwner(target.transaction, input.platformId, input.memberHashId),
  ]);
  if (owner === null) {
    return finish(target.done, { status: "invalid", author: null, ...context(target.metadata) });
  }
  const existing = await authorFrom(target.transaction, owner);
  if (existing.userId !== input.userId) {
    return finish(target.done, { status: "invalid", author: null, ...context(target.metadata) });
  }
  if (existing.memberHashId === input.memberHashId && aliasOwner === owner) {
    return finish(target.done, {
      status: "unchanged",
      author: existing,
      ...context(target.metadata),
    });
  }
  if (existing.memberHashId !== null || aliasOwner !== null) {
    return finish(target.done, { status: "invalid", author: null, ...context(target.metadata) });
  }
  return persistMemberHash(target, existing, owner, input.memberHashId);
}

export async function backfillMemberHashTarget(
  database: IDBDatabase,
  platformId: string,
  userIdInput: string,
  memberHashIdInput: string,
): Promise<AliasMutationResult> {
  const input = canonicalAliasInput(platformId, userIdInput, memberHashIdInput);
  if (!input) return invalidAliasMutation(database);
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const target = await createTargetContext(transaction);
    return applyMemberHashBackfill(target, input);
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

function canonicalUpvoterInput(input: UpvoterCommitInput): UpvoterCommitInput | null {
  const valid =
    input.platformId === ZHIHU_PLATFORM_ID &&
    isValidPlatformId(input.platformId) &&
    isBoundedStableId(input.userId) &&
    canonicalizeAuthorUserId(input.platformId, input.userId) === input.userId &&
    isBoundedAuthorName(input.authorNameAtCapture) &&
    isBoundedStableId(input.tagId) &&
    isValidBlacklistTimestamp(input.blacklistedAt);
  return valid ? input : null;
}

async function insertUpvoter(
  target: TargetContext,
  input: UpvoterCommitInput,
): Promise<AuthorMutationResult> {
  const owner = await identifierOwner(target.transaction, input.platformId, input.userId);
  if (owner !== null) {
    return finish(target.done, {
      status: "duplicate",
      author: await authorFrom(target.transaction, owner),
      tag: null,
      ...context(target.metadata),
    });
  }
  const tag =
    (await tagFrom(target.transaction, input.tagId)) ??
    (await tagFrom(target.transaction, DEFAULT_TAG_ID));
  if (!tag) throw new Error("The default blacklist tag is unavailable.");
  const author: BlacklistedAuthor = {
    platformId: input.platformId,
    userId: input.userId,
    memberHashId: null,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: tag.tagId,
    blacklistedAt: input.blacklistedAt,
    blockSource: "upvoter",
  };
  putNewAuthor(target.transaction, author, target.metadata);
  const next = incrementMetadata(target.metadata, { authors: 1 });
  putMetadata(target.transaction, next);
  return finish(target.done, {
    status: "persisted",
    author,
    tag: null,
    ...context(target.metadata, next),
  });
}

export async function commitUpvoterTarget(
  database: IDBDatabase,
  untrustedInput: UpvoterCommitInput,
): Promise<AuthorMutationResult> {
  const input = canonicalUpvoterInput(untrustedInput);
  if (!input) return invalidAuthorMutation(database);
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const target = await createTargetContext(transaction);
    return insertUpvoter(target, input);
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

function preflightUserId(input: DirectPreflightInput): string | null {
  const valid =
    input.platformId === ZHIHU_PLATFORM_ID &&
    isValidPlatformId(input.platformId) &&
    isBoundedStableId(input.userId) &&
    canonicalizeAuthorUserId(input.platformId, input.userId) === input.userId;
  return valid ? input.userId : null;
}

export async function preflightDirectTarget(
  database: IDBDatabase,
  input: DirectPreflightInput,
): Promise<{ readonly status: "ready" | "existing" }> {
  const userId = preflightUserId(input);
  if (userId === null || !isValidBlacklistTimestamp(input.expectedBlacklistedAt)) {
    return { status: "existing" };
  }
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readonly");
  const done = transactionDone(transaction);
  await metadataFrom(transaction);
  const owner = await identifierOwner(transaction, input.platformId, userId);
  if (owner === null) return finish(done, { status: "existing" });
  const author = await authorFrom(transaction, owner);
  return finish(done, {
    status:
      author.platformId === input.platformId &&
      author.userId === userId &&
      author.blockSource === "direct" &&
      author.blacklistedAt === input.expectedBlacklistedAt
        ? "ready"
        : "existing",
  });
}
