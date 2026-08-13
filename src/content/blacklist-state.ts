export const STORAGE_KEY = "cocoonBlacklistState";
export const STORAGE_SCHEMA_VERSION = 2;
export const LEGACY_STORAGE_SCHEMA_VERSION = 1;
export const DEFAULT_TAG_ID = "default";
export const MAX_TAG_CODE_POINTS = 30;
export const MAX_IMAGE_BYTES = 500 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 5 * 1024 * 1024;

export interface CocoonTag {
  readonly tagId: string;
  readonly name: string;
}

export interface CardImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface BlacklistedAuthor {
  readonly userId: string;
  readonly authorNameAtCapture: string;
  readonly tagId: string;
  readonly blacklistedAt: string | null;
  readonly cardImage?: CardImage;
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
  readonly authorNameAtCapture: string;
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
  readonly blacklistedAt: string;
  readonly cardImage?: CardImage;
}

export type CommitPlan =
  | { readonly status: "duplicate"; readonly state: BlacklistState }
  | {
      readonly status: "ready";
      readonly withImage: BlacklistState;
      readonly withoutImage: BlacklistState;
      readonly imageIncluded: boolean;
    }
  | { readonly status: "invalid"; readonly state: BlacklistState };

export type TagDeletionPlan =
  | { readonly status: "protected"; readonly state: BlacklistState }
  | { readonly status: "missing"; readonly state: BlacklistState }
  | { readonly status: "ready"; readonly state: BlacklistState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim()
  );
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

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function isValidCardImage(value: unknown): value is CardImage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.dataUrl === "string" &&
    value.dataUrl.startsWith("data:image/webp;") &&
    utf8ByteLength(value.dataUrl) <= MAX_IMAGE_BYTES &&
    Number.isInteger(value.width) &&
    (value.width as number) > 0 &&
    (value.width as number) <= 1200 &&
    Number.isInteger(value.height) &&
    (value.height as number) > 0 &&
    (value.height as number) <= 1200
  );
}

function parseTag(value: unknown): CocoonTag | null {
  if (!isRecord(value)) {
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
  legacy: boolean,
): BlacklistedAuthor | null {
  if (!isRecord(value)) {
    return null;
  }

  const { userId, authorNameAtCapture, tagId, cardImage, blacklistedAt } = value;
  if (
    !isNonEmptyTrimmedString(userId) ||
    typeof authorNameAtCapture !== "string" ||
    !isNonEmptyTrimmedString(tagId) ||
    !validTagIds.has(tagId) ||
    (cardImage !== undefined && !isValidCardImage(cardImage)) ||
    (!legacy && blacklistedAt !== null && !isValidBlacklistTimestamp(blacklistedAt))
  ) {
    return null;
  }

  const author: BlacklistedAuthor = {
    userId,
    authorNameAtCapture,
    tagId,
    blacklistedAt: legacy ? null : (blacklistedAt as string | null),
  };
  return cardImage === undefined ? author : { ...author, cardImage };
}

export function parseBlacklistState(value: unknown): ParsedBlacklistState {
  const fallback = createInitialState();
  if (value === undefined) {
    return { status: "missing", state: fallback };
  }

  if (
    !isRecord(value) ||
    (value.schemaVersion !== STORAGE_SCHEMA_VERSION &&
      value.schemaVersion !== LEGACY_STORAGE_SCHEMA_VERSION) ||
    !Array.isArray(value.tags) ||
    !Array.isArray(value.authors)
  ) {
    return { status: "malformed", state: fallback };
  }

  const legacy = value.schemaVersion === LEGACY_STORAGE_SCHEMA_VERSION;
  const tags: CocoonTag[] = [];
  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  for (const valueTag of value.tags) {
    const tag = parseTag(valueTag);
    if (
      !tag ||
      tagIds.has(tag.tagId) ||
      tagNames.has(tagLabelKey(tag.name))
    ) {
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
  const userIds = new Set<string>();
  let totalImageBytes = 0;
  for (const valueAuthor of value.authors) {
    const author = parseAuthor(valueAuthor, tagIds, legacy);
    if (!author || userIds.has(author.userId)) {
      return { status: "malformed", state: fallback };
    }

    if (author.cardImage) {
      totalImageBytes += utf8ByteLength(author.cardImage.dataUrl);
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        return { status: "malformed", state: fallback };
      }
    }

    authors.push(author);
    userIds.add(author.userId);
  }

  return {
    status: legacy ? "migrated" : "valid",
    state: { schemaVersion: STORAGE_SCHEMA_VERSION, tags, authors },
  };
}

function totalImageBytes(state: BlacklistState): number {
  return state.authors.reduce(
    (total, author) =>
      total +
      (author.cardImage ? utf8ByteLength(author.cardImage.dataUrl) : 0),
    0,
  );
}

export function planAuthorCommit(
  state: BlacklistState,
  input: CommitInput,
): CommitPlan {
  if (state.authors.some((author) => author.userId === input.userId)) {
    return { status: "duplicate", state };
  }

  const userId = input.userId.trim();
  if (
    !userId ||
    userId !== input.userId ||
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

  const minimalAuthor: BlacklistedAuthor = {
    userId,
    authorNameAtCapture: input.authorNameAtCapture,
    tagId: input.tag.tagId,
    blacklistedAt: input.blacklistedAt,
  };
  const withoutImage: BlacklistState = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    tags,
    authors: [...state.authors, minimalAuthor],
  };

  const imageFits =
    input.cardImage !== undefined &&
    isValidCardImage(input.cardImage) &&
    totalImageBytes(state) + utf8ByteLength(input.cardImage.dataUrl) <=
      MAX_TOTAL_IMAGE_BYTES;
  if (!imageFits || !input.cardImage) {
    return {
      status: "ready",
      withImage: withoutImage,
      withoutImage,
      imageIncluded: false,
    };
  }

  const withImage: BlacklistState = {
    ...withoutImage,
    authors: [
      ...state.authors,
      { ...minimalAuthor, cardImage: input.cardImage },
    ],
  };
  return {
    status: "ready",
    withImage,
    withoutImage,
    imageIncluded: true,
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
        author.tagId === tagId
          ? { ...author, tagId: DEFAULT_TAG_ID }
          : author,
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
