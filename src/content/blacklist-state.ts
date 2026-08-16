export const STORAGE_KEY = "cocoonBlacklistState";
export const STORAGE_SCHEMA_VERSION = 4;
export const LEGACY_STORAGE_SCHEMA_VERSIONS = [1, 2, 3] as const;
export const DEFAULT_TAG_ID = "default";
export const MAX_TAG_CODE_POINTS = 30;

export interface CocoonTag {
  readonly tagId: string;
  readonly name: string;
}

export type BlockSource = "direct" | "upvoter";

export interface BlacklistedAuthor {
  readonly userId: string;
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

export interface CommitInput {
  readonly userId: string;
  readonly memberHashId: string | null;
  readonly authorNameAtCapture: string;
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
  readonly blacklistedAt: string;
}

export interface UpvoterCommitInput {
  readonly userId: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length &&
    actualKeys.every((key, index) => key === sortedExpected[index]);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function normalizeMemberHashId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

export function isMemberHashId(value: unknown): value is string {
  return normalizeMemberHashId(value) !== null;
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

export function validateNewTagLabel(
  label: string,
  tags: readonly CocoonTag[],
): TagLabelValidation {
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
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }

  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

export function createBlacklistTimestamp(
  now: () => Date = () => new Date(),
): string {
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
    !isNonEmptyTrimmedString(name) ||
    Array.from(name).length > MAX_TAG_CODE_POINTS
  ) {
    return null;
  }

  return { tagId, name };
}

function parseAuthor(
  value: unknown,
  validTagIds: ReadonlySet<string>,
  schemaVersion: 1 | 2 | 3 | 4,
): BlacklistedAuthor | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    schemaVersion === STORAGE_SCHEMA_VERSION &&
    !hasExactKeys(value, [
      "userId",
      "memberHashId",
      "authorNameAtCapture",
      "tagId",
      "blacklistedAt",
      "blockSource",
    ])
  ) {
    return null;
  }

  const { userId, memberHashId, authorNameAtCapture, tagId, blacklistedAt } = value;
  const migratedFromV1 = schemaVersion === 1;
  const blockSource = schemaVersion >= 3 ? value.blockSource : "direct";
  const parsedMemberHashId = schemaVersion === STORAGE_SCHEMA_VERSION
    ? memberHashId === null
      ? null
      : normalizeMemberHashId(memberHashId)
    : null;

  if (
    !isNonEmptyTrimmedString(userId) ||
    typeof authorNameAtCapture !== "string" ||
    !isNonEmptyTrimmedString(tagId) ||
    !validTagIds.has(tagId) ||
    (schemaVersion === STORAGE_SCHEMA_VERSION &&
      memberHashId !== null &&
      parsedMemberHashId === null) ||
    (!migratedFromV1 &&
      blacklistedAt !== null &&
      !isValidBlacklistTimestamp(blacklistedAt)) ||
    (blockSource !== "direct" && blockSource !== "upvoter") ||
    (blockSource === "upvoter" && !isValidBlacklistTimestamp(blacklistedAt))
  ) {
    return null;
  }

  return {
    userId: normalizeMemberHashId(userId) ?? userId,
    memberHashId: parsedMemberHashId,
    authorNameAtCapture,
    tagId,
    blacklistedAt: migratedFromV1 ? null : blacklistedAt as string | null,
    blockSource,
  };
}

export function parseBlacklistState(value: unknown): ParsedBlacklistState {
  const fallback = createInitialState();
  if (value === undefined) {
    return { status: "missing", state: fallback };
  }

  if (
    !isRecord(value) ||
    (value.schemaVersion !== STORAGE_SCHEMA_VERSION &&
      !LEGACY_STORAGE_SCHEMA_VERSIONS.includes(
        value.schemaVersion as (typeof LEGACY_STORAGE_SCHEMA_VERSIONS)[number],
      )) ||
    !Array.isArray(value.tags) ||
    !Array.isArray(value.authors) ||
    (value.schemaVersion === STORAGE_SCHEMA_VERSION &&
      !hasExactKeys(value, ["schemaVersion", "tags", "authors"]))
  ) {
    return { status: "malformed", state: fallback };
  }

  const sourceSchemaVersion = value.schemaVersion as 1 | 2 | 3 | 4;
  const tags: CocoonTag[] = [];
  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  for (const valueTag of value.tags) {
    const tag = parseTag(valueTag, sourceSchemaVersion === STORAGE_SCHEMA_VERSION);
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
        (sourceSchemaVersion === STORAGE_SCHEMA_VERSION &&
          valueAuthor.memberHashId !== author.memberHashId))
    ) {
      identifiersWereNormalized = true;
    }

    const authorIndex = authors.length;
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) {
        continue;
      }
      const existingOwner = identifierOwners.get(identifier);
      if (existingOwner !== undefined && existingOwner !== authorIndex) {
        return { status: "malformed", state: fallback };
      }
      identifierOwners.set(identifier, authorIndex);
    }
    authors.push(author);
  }

  return {
    status: sourceSchemaVersion === STORAGE_SCHEMA_VERSION &&
        !identifiersWereNormalized
      ? "valid"
      : "migrated",
    state: { schemaVersion: STORAGE_SCHEMA_VERSION, tags, authors },
  };
}

function identifierOwnedByAnotherAuthor(
  state: BlacklistState,
  identifier: string,
  userId: string,
): boolean {
  const canonicalIdentifier = normalizeMemberHashId(identifier) ?? identifier;
  const canonicalUserId = normalizeMemberHashId(userId) ?? userId;
  return state.authors.some((author) => {
    const authorUserId = normalizeMemberHashId(author.userId) ?? author.userId;
    const authorMemberHashId = author.memberHashId === null
      ? null
      : normalizeMemberHashId(author.memberHashId);
    return authorUserId !== canonicalUserId &&
      (authorUserId === canonicalIdentifier ||
        authorMemberHashId === canonicalIdentifier);
  });
}

export function planMemberHashBackfill(
  state: BlacklistState,
  userId: string,
  memberHashId: string,
): MemberHashBackfillPlan {
  const canonicalMemberHashId = normalizeMemberHashId(memberHashId);
  if (!isNonEmptyTrimmedString(userId) || canonicalMemberHashId === null) {
    return { status: "invalid", state };
  }

  const canonicalUserId = normalizeMemberHashId(userId) ?? userId;
  const authorIndex = state.authors.findIndex(
    (author) =>
      (normalizeMemberHashId(author.userId) ?? author.userId) === canonicalUserId,
  );
  if (
    authorIndex < 0 ||
    identifierOwnedByAnotherAuthor(state, canonicalMemberHashId, canonicalUserId)
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
        index === authorIndex
          ? { ...candidate, memberHashId: canonicalMemberHashId }
          : candidate
      ),
    },
  };
}

export function planAuthorCommit(
  state: BlacklistState,
  input: CommitInput,
): CommitPlan {
  const canonicalMemberHashId = input.memberHashId === null
    ? null
    : normalizeMemberHashId(input.memberHashId);
  if (
    !isNonEmptyTrimmedString(input.userId) ||
    (input.memberHashId !== null && canonicalMemberHashId === null)
  ) {
    return { status: "invalid", state };
  }

  const canonicalUserId = normalizeMemberHashId(input.userId) ?? input.userId;
  const existing = state.authors.find(
    (author) =>
      (normalizeMemberHashId(author.userId) ?? author.userId) === canonicalUserId,
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
      canonicalUserId,
      canonicalMemberHashId,
    );
    return backfill.status === "ready"
      ? { status: "backfill", state: backfill.state }
      : { status: "invalid", state };
  }

  if (
    identifierOwnedByAnotherAuthor(state, canonicalUserId, canonicalUserId) ||
    (canonicalMemberHashId !== null &&
      (canonicalMemberHashId === canonicalUserId ||
        identifierOwnedByAnotherAuthor(
          state,
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

export function planUpvoterCommit(
  state: BlacklistState,
  input: UpvoterCommitInput,
): CommitPlan {
  const canonicalUserId = normalizeMemberHashId(input.userId) ?? input.userId;
  if (
    state.authors.some((author) =>
      (normalizeMemberHashId(author.userId) ?? author.userId) === canonicalUserId ||
      normalizeMemberHashId(author.memberHashId) === canonicalUserId
    )
  ) {
    return { status: "duplicate", state };
  }

  if (
    !isNonEmptyTrimmedString(input.userId) ||
    typeof input.authorNameAtCapture !== "string" ||
    !isNonEmptyTrimmedString(input.tagId) ||
    !state.tags.some((tag) => tag.tagId === input.tagId) ||
    !isValidBlacklistTimestamp(input.blacklistedAt)
  ) {
    return { status: "invalid", state };
  }

  const author: BlacklistedAuthor = {
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

export function planTagDeletion(
  state: BlacklistState,
  tagId: string,
): TagDeletionPlan {
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
        author.tagId === tagId ? { ...author, tagId: DEFAULT_TAG_ID } : author
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
