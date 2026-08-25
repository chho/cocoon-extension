export const STORAGE_KEY = "cocoonBlacklistState";
export const STORAGE_SCHEMA_VERSION = 5;
export const LEGACY_STORAGE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export const DEFAULT_TAG_ID = "default";
export const MAX_TAG_CODE_POINTS = 30;
export const MAX_STABLE_ID_CODE_POINTS = 512;
export const MAX_AUTHOR_NAME_CODE_POINTS = 500;
export const ZHIHU_PLATFORM_ID = "zhihu";
export const MAX_PLATFORM_ID_LENGTH = 64;
export const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface CocoonTag {
  readonly tagId: string;
  readonly name: string;
}

export type BlockSource = "direct" | "upvoter";

export interface AuthorIdentity {
  readonly platformId: string;
  readonly userId: string;
}

export interface BlacklistedAuthor extends AuthorIdentity {
  readonly memberHashId: string | null;
  readonly authorNameAtCapture: string;
  readonly tagId: string;
  readonly blacklistedAt: string | null;
  readonly blockSource: BlockSource;
}

export interface BlacklistState {
  readonly schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  readonly tags: readonly CocoonTag[];
  readonly authors: readonly BlacklistedAuthor[];
}

export type ParsedBlacklistState =
  | { readonly status: "valid"; readonly state: BlacklistState }
  | { readonly status: "migrated"; readonly state: BlacklistState }
  | { readonly status: "missing"; readonly state: BlacklistState }
  | { readonly status: "malformed"; readonly state: BlacklistState };

export function resolveInitializedState(
  initialRead: ParsedBlacklistState,
  readAfterInitializationWrite: ParsedBlacklistState | null,
): BlacklistState {
  if (initialRead.status !== "missing" && initialRead.status !== "migrated") {
    return initialRead.state;
  }

  return readAfterInitializationWrite?.status === "valid"
    ? readAfterInitializationWrite.state
    : initialRead.state;
}

export interface TagLabelValidation {
  readonly normalized: string;
  readonly error: "empty" | "too-long" | "duplicate" | null;
}

export interface CommitInput extends AuthorIdentity {
  readonly memberHashId: string | null;
  readonly authorNameAtCapture: string;
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
  readonly blacklistedAt: string;
}

export interface UpvoterCommitInput extends AuthorIdentity {
  readonly authorNameAtCapture: string;
  readonly tagId: string;
  readonly blacklistedAt: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index])
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isValidPlatformId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PLATFORM_ID_LENGTH &&
    PLATFORM_ID_PATTERN.test(value)
  );
}

export function normalizeMemberHashId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) ? value.toLowerCase() : null;
}

export function isMemberHashId(value: unknown): value is string {
  return normalizeMemberHashId(value) !== null;
}

export function canonicalizeAuthorUserId(platformId: string, userId: string): string {
  return platformId === ZHIHU_PLATFORM_ID ? (normalizeMemberHashId(userId) ?? userId) : userId;
}

export function authorIdentityKey(identity: AuthorIdentity): string {
  return JSON.stringify([
    identity.platformId,
    canonicalizeAuthorUserId(identity.platformId, identity.userId),
  ]);
}

export function createInitialState(): BlacklistState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    tags: [{ tagId: DEFAULT_TAG_ID, name: "default" }],
    authors: [],
  };
}

export function normalizeTagLabel(label: string): string {
  return label.trim();
}

export function tagLabelKey(label: string): string {
  return normalizeTagLabel(label).toLowerCase();
}

export function validateNewTagLabel(label: string, tags: readonly CocoonTag[]): TagLabelValidation {
  const normalized = normalizeTagLabel(label);
  if (!normalized) {
    return { normalized, error: "empty" };
  }

  if (Array.from(normalized).length > MAX_TAG_CODE_POINTS) {
    return { normalized, error: "too-long" };
  }

  const key = tagLabelKey(normalized);
  if (tags.some((tag) => tagLabelKey(tag.name) === key)) {
    return { normalized, error: "duplicate" };
  }

  return { normalized, error: null };
}

export function isValidBlacklistTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }

  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function createBlacklistTimestamp(now: () => Date = () => new Date()): string {
  const timestamp = now().toISOString();
  if (!isValidBlacklistTimestamp(timestamp)) {
    throw new Error("The blacklist clock did not produce a valid UTC timestamp.");
  }
  return timestamp;
}

function parseTag(value: unknown, strict: boolean): CocoonTag | null {
  if (!isRecord(value) || (strict && !hasExactKeys(value, ["tagId", "name"]))) {
    return null;
  }

  const { tagId, name } = value;
  if (
    !isNonEmptyTrimmedString(tagId) ||
    Array.from(tagId).length > MAX_STABLE_ID_CODE_POINTS ||
    !isNonEmptyTrimmedString(name) ||
    Array.from(name).length > MAX_TAG_CODE_POINTS
  ) {
    return null;
  }

  return { tagId, name };
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function hasExactAuthorKeys(
  value: Record<string, unknown>,
  schemaVersion: 1 | 2 | 3 | 4 | 5,
): boolean {
  const legacy = ["userId", "authorNameAtCapture", "tagId"];
  if (schemaVersion === 1) {
    return hasRequiredAndOptionalKeys(value, legacy, ["cardImage"]);
  }
  if (schemaVersion === 2) {
    return hasRequiredAndOptionalKeys(value, [...legacy, "blacklistedAt"], ["cardImage"]);
  }
  if (schemaVersion === 3) {
    return hasRequiredAndOptionalKeys(
      value,
      [...legacy, "blacklistedAt", "blockSource"],
      ["cardImage"],
    );
  }
  const current = [
    "userId",
    "memberHashId",
    "authorNameAtCapture",
    "tagId",
    "blacklistedAt",
    "blockSource",
  ];
  return hasExactKeys(
    value,
    schemaVersion === STORAGE_SCHEMA_VERSION ? ["platformId", ...current] : current,
  );
}

function boundedAuthorFields(value: Record<string, unknown>): {
  readonly userId: string;
  readonly authorNameAtCapture: string;
  readonly tagId: string;
} | null {
  const { userId, authorNameAtCapture, tagId } = value;
  if (
    !isNonEmptyTrimmedString(userId) ||
    Array.from(userId).length > MAX_STABLE_ID_CODE_POINTS ||
    typeof authorNameAtCapture !== "string" ||
    Array.from(authorNameAtCapture).length > MAX_AUTHOR_NAME_CODE_POINTS ||
    !isNonEmptyTrimmedString(tagId) ||
    Array.from(tagId).length > MAX_STABLE_ID_CODE_POINTS
  ) {
    return null;
  }
  return { userId, authorNameAtCapture, tagId };
}

function parseAuthor(
  value: unknown,
  validTagIds: ReadonlySet<string>,
  schemaVersion: 1 | 2 | 3 | 4 | 5,
): BlacklistedAuthor | null {
  if (!isRecord(value) || !hasExactAuthorKeys(value, schemaVersion)) {
    return null;
  }

  const fields = boundedAuthorFields(value);
  if (!fields) return null;
  const platformId =
    schemaVersion === STORAGE_SCHEMA_VERSION ? value.platformId : ZHIHU_PLATFORM_ID;
  const { userId, authorNameAtCapture, tagId } = fields;
  const { memberHashId, blacklistedAt } = value;
  const migratedFromV1 = schemaVersion === 1;
  const blockSource = schemaVersion >= 3 ? value.blockSource : "direct";
  const parsedMemberHashId =
    schemaVersion >= 4
      ? memberHashId === null
        ? null
        : normalizeMemberHashId(memberHashId)
      : null;

  if (
    !isValidPlatformId(platformId) ||
    !validTagIds.has(tagId) ||
    (schemaVersion >= 4 && memberHashId !== null && parsedMemberHashId === null) ||
    (platformId !== ZHIHU_PLATFORM_ID && memberHashId !== null) ||
    (!migratedFromV1 && blacklistedAt !== null && !isValidBlacklistTimestamp(blacklistedAt)) ||
    (blockSource !== "direct" && blockSource !== "upvoter") ||
    (blockSource === "upvoter" && !isValidBlacklistTimestamp(blacklistedAt))
  ) {
    return null;
  }

  return {
    platformId,
    userId: canonicalizeAuthorUserId(platformId, userId),
    memberHashId: parsedMemberHashId,
    authorNameAtCapture,
    tagId,
    blacklistedAt: migratedFromV1 ? null : (blacklistedAt as string | null),
    blockSource,
  };
}

export function parseBlacklistState(value: unknown): ParsedBlacklistState {
  const fallback = createInitialState();
  if (value === undefined) return { status: "missing", state: fallback };

  if (
    !isRecord(value) ||
    (value.schemaVersion !== STORAGE_SCHEMA_VERSION &&
      !LEGACY_STORAGE_SCHEMA_VERSIONS.includes(
        value.schemaVersion as (typeof LEGACY_STORAGE_SCHEMA_VERSIONS)[number],
      )) ||
    !Array.isArray(value.tags) ||
    !Array.isArray(value.authors)
  ) {
    return { status: "malformed", state: fallback };
  }

  const sourceSchemaVersion = value.schemaVersion as 1 | 2 | 3 | 4 | 5;
  if (!hasExactKeys(value, ["schemaVersion", "tags", "authors"])) {
    return { status: "malformed", state: fallback };
  }

  const tags: CocoonTag[] = [];
  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  for (const valueTag of value.tags) {
    const tag = parseTag(valueTag, true);
    if (!tag || tagIds.has(tag.tagId) || tagNames.has(tagLabelKey(tag.name))) {
      return { status: "malformed", state: fallback };
    }
    tags.push(tag);
    tagIds.add(tag.tagId);
    tagNames.add(tagLabelKey(tag.name));
  }

  if (
    !tagIds.has(DEFAULT_TAG_ID) ||
    tags.find((tag) => tag.tagId === DEFAULT_TAG_ID)?.name !== "default"
  ) {
    return { status: "malformed", state: fallback };
  }

  const authors: BlacklistedAuthor[] = [];
  const identifierOwners = new Map<string, number>();
  let identifiersWereNormalized = false;
  for (const valueAuthor of value.authors) {
    const author = parseAuthor(valueAuthor, tagIds, sourceSchemaVersion);
    if (!author) {
      return { status: "malformed", state: fallback };
    }

    if (author.memberHashId === author.userId) {
      return { status: "malformed", state: fallback };
    }

    if (
      isRecord(valueAuthor) &&
      (valueAuthor.userId !== author.userId ||
        (sourceSchemaVersion >= 4 && valueAuthor.memberHashId !== author.memberHashId))
    ) {
      identifiersWereNormalized = true;
    }

    const authorIndex = authors.length;
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) {
        continue;
      }
      const scopedIdentifier = authorIdentityKey({
        platformId: author.platformId,
        userId: identifier,
      });
      const existingOwner = identifierOwners.get(scopedIdentifier);
      if (existingOwner !== undefined && existingOwner !== authorIndex) {
        return { status: "malformed", state: fallback };
      }
      identifierOwners.set(scopedIdentifier, authorIndex);
    }
    authors.push(author);
  }

  return {
    status:
      sourceSchemaVersion === STORAGE_SCHEMA_VERSION && !identifiersWereNormalized
        ? "valid"
        : "migrated",
    state: { schemaVersion: STORAGE_SCHEMA_VERSION, tags, authors },
  };
}

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

export function planAuthorCommit(state: BlacklistState, input: CommitInput): CommitPlan {
  const canonicalMemberHashId =
    input.memberHashId === null ? null : normalizeMemberHashId(input.memberHashId);
  if (
    !isValidPlatformId(input.platformId) ||
    !isNonEmptyTrimmedString(input.userId) ||
    (input.memberHashId !== null && canonicalMemberHashId === null) ||
    (input.platformId !== ZHIHU_PLATFORM_ID && input.memberHashId !== null)
  ) {
    return { status: "invalid", state };
  }

  const canonicalUserId = canonicalizeAuthorUserId(input.platformId, input.userId);
  const existing = state.authors.find(
    (author) =>
      author.platformId === input.platformId &&
      canonicalizeAuthorUserId(author.platformId, author.userId) === canonicalUserId,
  );
  if (existing) {
    if (
      canonicalMemberHashId === null ||
      normalizeMemberHashId(existing.memberHashId) === canonicalMemberHashId
    ) {
      return { status: "duplicate", state };
    }
    const backfill = planMemberHashBackfill(
      state,
      { platformId: input.platformId, userId: canonicalUserId },
      canonicalMemberHashId,
    );
    return backfill.status === "ready"
      ? { status: "backfill", state: backfill.state }
      : { status: "invalid", state };
  }

  if (
    identifierOwnedByAnotherAuthor(state, input.platformId, canonicalUserId, canonicalUserId) ||
    (canonicalMemberHashId !== null &&
      (canonicalMemberHashId === canonicalUserId ||
        identifierOwnedByAnotherAuthor(
          state,
          input.platformId,
          canonicalMemberHashId,
          canonicalUserId,
        ))) ||
    typeof input.authorNameAtCapture !== "string" ||
    !isValidBlacklistTimestamp(input.blacklistedAt)
  ) {
    return { status: "invalid", state };
  }

  const tags = [...state.tags];
  if (input.isNewTag) {
    const validation = validateNewTagLabel(input.tag.name, tags);
    if (
      validation.error ||
      !isNonEmptyTrimmedString(input.tag.tagId) ||
      input.tag.name !== validation.normalized
    ) {
      return { status: "invalid", state };
    }
    tags.push(input.tag);
  } else if (!tags.some((tag) => tag.tagId === input.tag.tagId)) {
    return { status: "invalid", state };
  }

  const author: BlacklistedAuthor = {
    platformId: input.platformId,
    userId: canonicalUserId,
    memberHashId: canonicalMemberHashId,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: input.tag.tagId,
    blacklistedAt: input.blacklistedAt,
    blockSource: "direct",
  };
  return {
    status: "ready",
    state: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      tags,
      authors: [...state.authors, author],
    },
  };
}

export function planUpvoterCommit(state: BlacklistState, input: UpvoterCommitInput): CommitPlan {
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

function isRestorableAuthor(author: BlacklistedAuthor): boolean {
  const canonicalMemberHashId =
    author.memberHashId === null ? null : normalizeMemberHashId(author.memberHashId);
  return (
    isValidPlatformId(author.platformId) &&
    isNonEmptyTrimmedString(author.userId) &&
    canonicalizeAuthorUserId(author.platformId, author.userId) === author.userId &&
    (author.memberHashId === null ||
      (author.platformId === ZHIHU_PLATFORM_ID && canonicalMemberHashId === author.memberHashId)) &&
    canonicalMemberHashId !== canonicalizeAuthorUserId(author.platformId, author.userId) &&
    typeof author.authorNameAtCapture === "string" &&
    isNonEmptyTrimmedString(author.tagId) &&
    (author.blacklistedAt === null || isValidBlacklistTimestamp(author.blacklistedAt)) &&
    (author.blockSource === "direct" || author.blockSource === "upvoter") &&
    (author.blockSource !== "upvoter" || author.blacklistedAt !== null)
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
  if (!isRestorableAuthor(original)) {
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
