import type * as SourcePostModule from "../core/source-post.ts";
// @ts-expect-error Vite resolves the content-only copy during bundling.
import * as contentSourcePost from "../core/source-post.ts?content-copy";
const { hasSourcePostReference } = contentSourcePost as typeof SourcePostModule;
import {
  DEFAULT_TAG_ID,
  ZHIHU_PLATFORM_ID,
  authorIdentityKey,
  canonicalizeAuthorUserId,
  isNonEmptyTrimmedString,
  isValidPlatformId,
  isValidBlacklistTimestamp,
  normalizeMemberHashId,
  parseBlacklistedAuthor,
  validateNewTagLabel,
  type CocoonTag,
  type AuthorIdentity,
  type BlacklistState,
  type BlacklistedAuthor,
  type CommitInput,
  type UpvoterCommitInput,
} from "./blacklist-state-parser.ts";

export * from "./blacklist-state-parser.ts";

export type CommitPlan =
  | { readonly status: "duplicate"; readonly state: BlacklistState }
  | { readonly status: "backfill"; readonly state: BlacklistState }
  | { readonly status: "ready"; readonly state: BlacklistState }
  | { readonly status: "invalid"; readonly state: BlacklistState };

export type MemberHashBackfillPlan =
  | { readonly status: "ready"; readonly state: BlacklistState }
  | { readonly status: "already-present"; readonly state: BlacklistState }
  | { readonly status: "invalid"; readonly state: BlacklistState };

export type TagDeletionPlan =
  | { readonly status: "protected"; readonly state: BlacklistState }
  | { readonly status: "missing"; readonly state: BlacklistState }
  | { readonly status: "ready"; readonly state: BlacklistState };

export type AuthorRemovalPlan =
  | { readonly status: "missing"; readonly state: BlacklistState }
  | {
      readonly status: "ready";
      readonly state: BlacklistState;
      readonly removed: BlacklistedAuthor;
    };

export type AuthorRestorationPlan =
  | {
      readonly status: "conflict" | "missing-tag" | "invalid";
      readonly state: BlacklistState;
    }
  | { readonly status: "ready"; readonly state: BlacklistState };

export type AuthorBatchRemovalPlan =
  | { readonly status: "empty" | "missing"; readonly state: BlacklistState }
  | {
      readonly status: "ready";
      readonly state: BlacklistState;
      readonly removedCount: number;
    };

export type TagRenamePlan =
  | {
      readonly status: "protected" | "missing" | "invalid";
      readonly state: BlacklistState;
      readonly error?: "empty" | "too-long" | "duplicate";
    }
  | { readonly status: "unchanged" | "ready"; readonly state: BlacklistState };

function identifierOwnedByAnotherAuthor(
  state: BlacklistState,
  platformId: string,
  identifier: string,
  userId: string,
): boolean {
  const canonicalIdentifier = canonicalizeAuthorUserId(platformId, identifier);
  const canonicalUserId = canonicalizeAuthorUserId(platformId, userId);
  return state.authors.some((author) => {
    if (author.platformId !== platformId) {
      return false;
    }
    const authorUserId = canonicalizeAuthorUserId(platformId, author.userId);
    const authorMemberHashId =
      author.memberHashId === null ? null : normalizeMemberHashId(author.memberHashId);
    return (
      authorUserId !== canonicalUserId &&
      (authorUserId === canonicalIdentifier || authorMemberHashId === canonicalIdentifier)
    );
  });
}

export function planMemberHashBackfill(
  state: BlacklistState,
  identity: AuthorIdentity,
  memberHashId: string,
): MemberHashBackfillPlan {
  const canonicalMemberHashId = normalizeMemberHashId(memberHashId);
  if (
    identity.platformId !== ZHIHU_PLATFORM_ID ||
    !isValidPlatformId(identity.platformId) ||
    !isNonEmptyTrimmedString(identity.userId) ||
    canonicalMemberHashId === null
  ) {
    return { status: "invalid", state };
  }

  const canonicalUserId = canonicalizeAuthorUserId(identity.platformId, identity.userId);
  const authorIndex = state.authors.findIndex(
    (author) =>
      author.platformId === identity.platformId &&
      canonicalizeAuthorUserId(author.platformId, author.userId) === canonicalUserId,
  );
  if (
    authorIndex < 0 ||
    identifierOwnedByAnotherAuthor(
      state,
      identity.platformId,
      canonicalMemberHashId,
      canonicalUserId,
    )
  ) {
    return { status: "invalid", state };
  }

  const author = state.authors[authorIndex];
  if (!author) {
    return { status: "invalid", state };
  }
  if (normalizeMemberHashId(author.memberHashId) === canonicalMemberHashId) {
    return { status: "already-present", state };
  }
  if (author.memberHashId !== null || canonicalMemberHashId === canonicalUserId) {
    return { status: "invalid", state };
  }

  return {
    status: "ready",
    state: {
      ...state,
      authors: state.authors.map((candidate, index) =>
        index === authorIndex ? { ...candidate, memberHashId: canonicalMemberHashId } : candidate,
      ),
    },
  };
}

function planExistingAuthor(
  state: BlacklistState,
  existing: BlacklistedAuthor,
  memberHashId: string | null,
): CommitPlan {
  if (memberHashId === null || normalizeMemberHashId(existing.memberHashId) === memberHashId)
    return { status: "duplicate", state };
  const backfill = planMemberHashBackfill(state, existing, memberHashId);
  return backfill.status === "ready"
    ? { status: "backfill", state: backfill.state }
    : { status: "invalid", state };
}

function selectCommitTags(state: BlacklistState, input: CommitInput): readonly CocoonTag[] | null {
  if (!input.isNewTag)
    return state.tags.some((tag) => tag.tagId === input.tag.tagId) ? state.tags : null;
  const validation = validateNewTagLabel(input.tag.name, state.tags);
  if (
    validation.error ||
    !isNonEmptyTrimmedString(input.tag.tagId) ||
    input.tag.name !== validation.normalized
  )
    return null;
  return [...state.tags, input.tag];
}

function conflictingCommitIdentifiers(
  state: BlacklistState,
  input: CommitInput,
  userId: string,
  memberHashId: string | null,
): boolean {
  if (identifierOwnedByAnotherAuthor(state, input.platformId, userId, userId)) return true;
  return (
    memberHashId !== null &&
    (memberHashId === userId ||
      identifierOwnedByAnotherAuthor(state, input.platformId, memberHashId, userId))
  );
}

function canonicalCommitIdentity(
  input: CommitInput,
): { readonly userId: string; readonly memberHashId: string | null } | null {
  const canonicalMemberHashId =
    input.memberHashId === null ? null : normalizeMemberHashId(input.memberHashId);
  if (
    !isValidPlatformId(input.platformId) ||
    !isNonEmptyTrimmedString(input.userId) ||
    (input.memberHashId !== null && canonicalMemberHashId === null) ||
    (input.platformId !== ZHIHU_PLATFORM_ID && input.memberHashId !== null)
  ) {
    return null;
  }

  const canonicalUserId = canonicalizeAuthorUserId(input.platformId, input.userId);
  return { userId: canonicalUserId, memberHashId: canonicalMemberHashId };
}

export function planAuthorCommit(state: BlacklistState, input: CommitInput): CommitPlan {
  if (!hasSourcePostReference(input, state.posts)) return { status: "invalid", state };
  const identity = canonicalCommitIdentity(input);
  if (!identity) return { status: "invalid", state };
  const { userId: canonicalUserId, memberHashId: canonicalMemberHashId } = identity;
  const existing = state.authors.find(
    (author) =>
      author.platformId === input.platformId &&
      canonicalizeAuthorUserId(author.platformId, author.userId) === canonicalUserId,
  );
  if (existing) return planExistingAuthor(state, existing, canonicalMemberHashId);

  if (
    conflictingCommitIdentifiers(state, input, canonicalUserId, canonicalMemberHashId) ||
    typeof input.authorNameAtCapture !== "string" ||
    !isValidBlacklistTimestamp(input.blacklistedAt)
  ) {
    return { status: "invalid", state };
  }

  const tags = selectCommitTags(state, input);
  if (!tags) return { status: "invalid", state };

  const author: BlacklistedAuthor = {
    platformId: input.platformId,
    userId: canonicalUserId,
    memberHashId: canonicalMemberHashId,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: input.tag.tagId,
    blacklistedAt: input.blacklistedAt,
    blockSource: "direct",
    sourcePostId: input.sourcePostId,
  };
  return {
    status: "ready",
    state: {
      ...state,
      tags,
      authors: [...state.authors, author],
    },
  };
}

export function planUpvoterCommit(state: BlacklistState, input: UpvoterCommitInput): CommitPlan {
  if (!hasSourcePostReference(input, state.posts)) return { status: "invalid", state };
  if (!isValidPlatformId(input.platformId) || !isNonEmptyTrimmedString(input.userId)) {
    return { status: "invalid", state };
  }
  const canonicalUserId = canonicalizeAuthorUserId(input.platformId, input.userId);
  if (
    state.authors.some(
      (author) =>
        author.platformId === input.platformId &&
        (canonicalizeAuthorUserId(author.platformId, author.userId) === canonicalUserId ||
          normalizeMemberHashId(author.memberHashId) === canonicalUserId),
    )
  ) {
    return { status: "duplicate", state };
  }

  if (
    typeof input.authorNameAtCapture !== "string" ||
    !isNonEmptyTrimmedString(input.tagId) ||
    !state.tags.some((tag) => tag.tagId === input.tagId) ||
    !isValidBlacklistTimestamp(input.blacklistedAt)
  ) {
    return { status: "invalid", state };
  }

  const author: BlacklistedAuthor = {
    platformId: input.platformId,
    userId: canonicalUserId,
    memberHashId: null,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: input.tagId,
    blacklistedAt: input.blacklistedAt,
    blockSource: "upvoter",
    sourcePostId: input.sourcePostId,
  };
  return {
    status: "ready",
    state: { ...state, authors: [...state.authors, author] },
  };
}

function canonicalIdentity(identity: AuthorIdentity): AuthorIdentity | null {
  if (!isValidPlatformId(identity.platformId) || !isNonEmptyTrimmedString(identity.userId)) {
    return null;
  }
  return {
    platformId: identity.platformId,
    userId: canonicalizeAuthorUserId(identity.platformId, identity.userId),
  };
}

function authorOwnsIdentifier(
  author: BlacklistedAuthor,
  platformId: string,
  identifier: string,
): boolean {
  if (author.platformId !== platformId) {
    return false;
  }
  const canonicalIdentifier = canonicalizeAuthorUserId(platformId, identifier);
  return (
    canonicalizeAuthorUserId(platformId, author.userId) === canonicalIdentifier ||
    normalizeMemberHashId(author.memberHashId) === canonicalIdentifier
  );
}

function authorHasExactIdentity(author: BlacklistedAuthor, identity: AuthorIdentity): boolean {
  return (
    author.platformId === identity.platformId &&
    canonicalizeAuthorUserId(author.platformId, author.userId) ===
      canonicalizeAuthorUserId(identity.platformId, identity.userId)
  );
}

export function planAuthorRemoval(
  state: BlacklistState,
  identity: AuthorIdentity,
): AuthorRemovalPlan {
  const canonical = canonicalIdentity(identity);
  if (!canonical) {
    return { status: "missing", state };
  }
  const index = state.authors.findIndex((author) => authorHasExactIdentity(author, canonical));
  const removed = state.authors[index];
  if (index < 0 || !removed) {
    return { status: "missing", state };
  }
  return {
    status: "ready",
    state: {
      ...state,
      authors: state.authors.filter((_, authorIndex) => authorIndex !== index),
    },
    removed,
  };
}

export function planAuthorRestoration(
  state: BlacklistState,
  original: BlacklistedAuthor,
): AuthorRestorationPlan {
  if (
    !parseBlacklistedAuthor(original, new Set([original.tagId])) ||
    !hasSourcePostReference(original, state.posts)
  ) {
    return { status: "invalid", state };
  }
  if (!state.tags.some((tag) => tag.tagId === original.tagId)) {
    return { status: "missing-tag", state };
  }
  if (
    state.authors.some(
      (author) =>
        authorOwnsIdentifier(author, original.platformId, original.userId) ||
        (original.memberHashId !== null &&
          authorOwnsIdentifier(author, original.platformId, original.memberHashId)),
    )
  ) {
    return { status: "conflict", state };
  }
  return {
    status: "ready",
    state: { ...state, authors: [...state.authors, original] },
  };
}

export function planAuthorBatchRemoval(
  state: BlacklistState,
  identities: readonly AuthorIdentity[],
): AuthorBatchRemovalPlan {
  const canonical = identities.map(canonicalIdentity);
  if (identities.length === 0 || canonical.some((identity) => identity === null)) {
    return { status: "empty", state };
  }
  const keys = new Set((canonical as AuthorIdentity[]).map(authorIdentityKey));
  if (keys.size !== identities.length) {
    return { status: "empty", state };
  }
  const existingKeys = new Set(state.authors.map(authorIdentityKey));
  if ([...keys].some((key) => !existingKeys.has(key))) {
    return { status: "missing", state };
  }
  const authors = state.authors.filter((author) => !keys.has(authorIdentityKey(author)));
  return {
    status: "ready",
    state: { ...state, authors },
    removedCount: identities.length,
  };
}

export function planTagRename(state: BlacklistState, tagId: string, label: string): TagRenamePlan {
  if (tagId === DEFAULT_TAG_ID) {
    return { status: "protected", state };
  }
  const tagIndex = state.tags.findIndex((tag) => tag.tagId === tagId);
  const current = state.tags[tagIndex];
  if (tagIndex < 0 || !current) {
    return { status: "missing", state };
  }
  const otherTags = state.tags.filter((tag) => tag.tagId !== tagId);
  const validation = validateNewTagLabel(label, otherTags);
  if (validation.error) {
    return { status: "invalid", state, error: validation.error };
  }
  if (current.name === validation.normalized) {
    return { status: "unchanged", state };
  }
  return {
    status: "ready",
    state: {
      ...state,
      tags: state.tags.map((tag, index) =>
        index === tagIndex ? { ...tag, name: validation.normalized } : tag,
      ),
    },
  };
}

export function planTagDeletion(state: BlacklistState, tagId: string): TagDeletionPlan {
  if (tagId === DEFAULT_TAG_ID) {
    return { status: "protected", state };
  }
  if (!state.tags.some((tag) => tag.tagId === tagId)) {
    return { status: "missing", state };
  }

  return {
    status: "ready",
    state: {
      ...state,
      tags: state.tags.filter((tag) => tag.tagId !== tagId),
      authors: state.authors.map((author) =>
        author.tagId === tagId ? { ...author, tagId: DEFAULT_TAG_ID } : author,
      ),
    },
  };
}

export function runtimeStateAfterPersistence(
  previous: BlacklistState,
  candidate: BlacklistState,
  persisted: boolean,
): BlacklistState {
  return persisted ? candidate : previous;
}
