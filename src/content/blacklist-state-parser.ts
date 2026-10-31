import type { SourcePost } from "../core/source-post.ts";
import type * as SourcePostModule from "../core/source-post.ts";
// @ts-expect-error Vite resolves the content-only copy during bundling.
import * as contentSourcePost from "../core/source-post.ts?content-copy";
const { isSourcePostId, parseSourcePosts } = contentSourcePost as typeof SourcePostModule;

export const STORAGE_KEY = "cocoonBlacklistState";
export const STORAGE_SCHEMA_VERSION = 6;
export const LEGACY_STORAGE_SCHEMA_VERSIONS = [1, 2, 3, 4, 5] as const;
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
  readonly sourcePostId: string | null;
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
  readonly posts: readonly SourcePost[];
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
  readonly sourcePostId: string | null;
  readonly memberHashId: string | null;
  readonly authorNameAtCapture: string;
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
  readonly blacklistedAt: string;
}

export interface UpvoterCommitInput extends AuthorIdentity {
  readonly sourcePostId: string | null;
  readonly authorNameAtCapture: string;
  readonly tagId: string;
  readonly blacklistedAt: string;
}

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

export function isNonEmptyTrimmedString(value: unknown): value is string {
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
    posts: [],
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
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6,
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
    schemaVersion === 6
      ? ["platformId", "sourcePostId", ...current]
      : schemaVersion === 5
        ? ["platformId", ...current]
        : current,
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

type SourceSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6;

function parseAuthorPlatform(
  value: Record<string, unknown>,
  version: SourceSchemaVersion,
): {
  readonly platformId: string;
  readonly memberHashId: string | null;
} | null {
  const platformId = version >= 5 ? value.platformId : ZHIHU_PLATFORM_ID;
  const rawHash = version >= 4 ? value.memberHashId : null;
  const memberHashId = rawHash === null ? null : normalizeMemberHashId(rawHash);
  if (
    !isValidPlatformId(platformId) ||
    (rawHash !== null && memberHashId === null) ||
    (platformId !== ZHIHU_PLATFORM_ID && rawHash !== null)
  )
    return null;
  return { platformId, memberHashId };
}

function parseAuthorCapture(
  value: Record<string, unknown>,
  version: SourceSchemaVersion,
): {
  readonly blockSource: BlockSource;
  readonly blacklistedAt: string | null;
} | null {
  const blockSource = version >= 3 ? value.blockSource : "direct";
  const blacklistedAt = version === 1 ? null : value.blacklistedAt;
  if (blockSource !== "direct" && blockSource !== "upvoter") return null;
  if (blacklistedAt !== null && !isValidBlacklistTimestamp(blacklistedAt)) return null;
  if (blockSource === "upvoter" && blacklistedAt === null) return null;
  return { blockSource, blacklistedAt };
}

function parseAuthorSource(value: Record<string, unknown>, version: SourceSchemaVersion) {
  const capture = parseAuthorCapture(value, version);
  const sourcePostId = version === 6 ? value.sourcePostId : null;
  if (!capture || (sourcePostId !== null && !isSourcePostId(sourcePostId))) return null;
  return { ...capture, sourcePostId };
}

function parseAuthor(
  value: unknown,
  validTagIds: ReadonlySet<string>,
  schemaVersion: SourceSchemaVersion,
): BlacklistedAuthor | null {
  if (!isRecord(value) || !hasExactAuthorKeys(value, schemaVersion)) return null;
  const fields = boundedAuthorFields(value);
  if (!fields || !validTagIds.has(fields.tagId)) return null;
  const platform = parseAuthorPlatform(value, schemaVersion);
  const source = parseAuthorSource(value, schemaVersion);
  if (!platform || !source) return null;
  if (source.sourcePostId !== null && platform.platformId !== ZHIHU_PLATFORM_ID) return null;
  return {
    ...fields,
    ...platform,
    ...source,
    userId: canonicalizeAuthorUserId(platform.platformId, fields.userId),
  };
}

export function parseBlacklistedAuthor(
  value: unknown,
  validTagIds: ReadonlySet<string>,
): BlacklistedAuthor | null {
  const author = parseAuthor(value, validTagIds, 6);
  if (
    !author ||
    !isRecord(value) ||
    author.memberHashId === author.userId ||
    value.userId !== author.userId ||
    value.memberHashId !== author.memberHashId
  )
    return null;
  return author;
}

function parseStateEnvelope(value: unknown): {
  readonly version: SourceSchemaVersion;
  readonly tags: unknown[];
  readonly authors: unknown[];
  readonly posts: SourcePost[];
} | null {
  if (
    !isRecord(value) ||
    ![1, 2, 3, 4, 5, 6].includes(value.schemaVersion as number) ||
    !Array.isArray(value.tags) ||
    !Array.isArray(value.authors)
  )
    return null;
  const version = value.schemaVersion as SourceSchemaVersion;
  const keys =
    version === 6
      ? ["schemaVersion", "tags", "authors", "posts"]
      : ["schemaVersion", "tags", "authors"];
  if (!hasExactKeys(value, keys)) return null;
  const posts = version === 6 ? parseSourcePosts(value.posts) : [];
  return posts ? { version, tags: value.tags, authors: value.authors, posts } : null;
}

function parseStateTags(values: readonly unknown[]): CocoonTag[] | null {
  const tags: CocoonTag[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of values) {
    const tag = parseTag(value, true);
    if (!tag || ids.has(tag.tagId) || names.has(tagLabelKey(tag.name))) return null;
    tags.push(tag);
    ids.add(tag.tagId);
    names.add(tagLabelKey(tag.name));
  }
  return tags.find((tag) => tag.tagId === DEFAULT_TAG_ID)?.name === "default" ? tags : null;
}

function addAuthorIdentifiers(author: BlacklistedAuthor, identifiers: Set<string>): boolean {
  for (const identifier of [author.userId, author.memberHashId]) {
    if (identifier === null) continue;
    const key = authorIdentityKey({ platformId: author.platformId, userId: identifier });
    if (identifiers.has(key)) return false;
    identifiers.add(key);
  }
  return true;
}

function authorIdentifiersNormalized(
  value: unknown,
  author: BlacklistedAuthor,
  version: SourceSchemaVersion,
): boolean {
  return (
    isRecord(value) &&
    (value.userId !== author.userId || (version >= 4 && value.memberHashId !== author.memberHashId))
  );
}

function parseStateAuthors(
  envelope: NonNullable<ReturnType<typeof parseStateEnvelope>>,
  tags: readonly CocoonTag[],
): {
  readonly authors: BlacklistedAuthor[];
  readonly normalized: boolean;
} | null {
  const tagIds = new Set(tags.map((tag) => tag.tagId));
  const posts = new Map(envelope.posts.map((post) => [post.postId, post.platformId]));
  const authors: BlacklistedAuthor[] = [];
  const identifiers = new Set<string>();
  let normalized = false;
  for (const value of envelope.authors) {
    const author = parseAuthor(value, tagIds, envelope.version);
    if (!author || !addAuthorIdentifiers(author, identifiers)) return null;
    if (author.sourcePostId !== null && posts.get(author.sourcePostId) !== author.platformId)
      return null;
    if (authorIdentifiersNormalized(value, author, envelope.version)) normalized = true;
    authors.push(author);
  }
  return { authors, normalized };
}

export function parseBlacklistState(value: unknown): ParsedBlacklistState {
  const fallback = createInitialState();
  if (value === undefined) return { status: "missing", state: fallback };
  const envelope = parseStateEnvelope(value);
  if (!envelope) return { status: "malformed", state: fallback };
  const tags = parseStateTags(envelope.tags);
  if (!tags) return { status: "malformed", state: fallback };
  const parsed = parseStateAuthors(envelope, tags);
  if (!parsed) return { status: "malformed", state: fallback };
  return {
    status:
      envelope.version === STORAGE_SCHEMA_VERSION && !parsed.normalized ? "valid" : "migrated",
    state: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      tags,
      authors: parsed.authors,
      posts: envelope.posts,
    },
  };
}
