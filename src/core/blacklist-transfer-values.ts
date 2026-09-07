import {
  contractCodePointLength as codePointLength,
  contractJsonByteLength as blacklistTransferJsonBytes,
  contractTextByteLength as blacklistTransferTextBytes,
  hasExactContractKeys as hasExactBlacklistTransferKeys,
  isContractRecord as isBlacklistTransferRecord,
} from "./blacklist-contract-validation.ts";

export const BLACKLIST_TRANSFER_PRODUCT = "cocoon-blacklist" as const;
export const BLACKLIST_TRANSFER_FORMAT_VERSION = 1 as const;
export const BLACKLIST_TRANSFER_SCHEMA_VERSION = 5 as const;
export const BLACKLIST_TRANSFER_FILE_BYTES = 32 * 1024 * 1024;
export const BLACKLIST_TRANSFER_RPC_BYTES = 256 * 1024;
export const BLACKLIST_TRANSFER_CURSOR_BYTES = 2 * 1024;
export const BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE = 500;
export const BLACKLIST_TRANSFER_TAG_CHUNK_SIZE = 500;
export const BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE = 500;
export const BLACKLIST_TRANSFER_TAG_LIMIT = 2_000;
export const BLACKLIST_TRANSFER_PAGE_PAYLOAD_BYTES = 240 * 1024;

const DEFAULT_TAG_ID = "default";
const ZHIHU_PLATFORM_ID = "zhihu";
const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MEMBER_HASH_PATTERN = /^[0-9a-f]{32}$/;
const MEMBER_HASH_CASE_INSENSITIVE_PATTERN = /^[0-9a-f]{32}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BlacklistTransferAuthorDto {
  readonly platformId: string;
  readonly userId: string;
  readonly memberHashId: string | null;
  readonly authorNameAtCapture: string;
  readonly tagId: string;
  readonly blacklistedAt: string | null;
  readonly blockSource: "direct" | "upvoter";
}

export interface BlacklistTransferTagDto {
  readonly tagId: string;
  readonly name: string;
}

export interface BlacklistTransferEnvelopeV1 {
  readonly product: typeof BLACKLIST_TRANSFER_PRODUCT;
  readonly formatVersion: typeof BLACKLIST_TRANSFER_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly schemaVersion: typeof BLACKLIST_TRANSFER_SCHEMA_VERSION;
  readonly authors: readonly BlacklistTransferAuthorDto[];
  readonly tags: readonly BlacklistTransferTagDto[];
}

export interface BlacklistTransferFileMetadataDto {
  readonly product: typeof BLACKLIST_TRANSFER_PRODUCT;
  readonly formatVersion: typeof BLACKLIST_TRANSFER_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly schemaVersion: typeof BLACKLIST_TRANSFER_SCHEMA_VERSION;
  readonly sourceBytes: number;
  readonly canonicalBytes: number;
  readonly authorsBytes: number;
  readonly tagsBytes: number;
  readonly authorCount: number;
  readonly tagCount: number;
  readonly authorChunkCount: number;
  readonly tagChunkCount: number;
}

export type BlacklistTransferFileParseResult =
  | {
      readonly status: "valid";
      readonly transfer: BlacklistTransferEnvelopeV1;
      readonly metadata: BlacklistTransferFileMetadataDto;
    }
  | { readonly status: "invalid" | "too-large" };

export {
  blacklistTransferJsonBytes,
  blacklistTransferTextBytes,
  hasExactBlacklistTransferKeys,
  isBlacklistTransferRecord,
};

function isTrimmed(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isPlatformId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.length <= 64 && PLATFORM_ID_PATTERN.test(value);
}

function isCanonicalUserId(platformId: string, value: unknown): value is string {
  if (!isTrimmed(value)) return false;
  if (codePointLength(value) > 512) return false;
  if (platformId !== ZHIHU_PLATFORM_ID) return true;
  if (!MEMBER_HASH_CASE_INSENSITIVE_PATTERN.test(value)) return true;
  return MEMBER_HASH_PATTERN.test(value);
}

function isValidMemberHash(platformId: string, userId: string, value: unknown): boolean {
  if (value === null) return true;
  if (platformId !== ZHIHU_PLATFORM_ID) return false;
  if (typeof value !== "string") return false;
  if (!MEMBER_HASH_PATTERN.test(value)) return false;
  return value !== userId;
}

function hasValidAuthorText(value: Record<string, unknown>): boolean {
  if (typeof value.authorNameAtCapture !== "string") return false;
  if (codePointLength(value.authorNameAtCapture) > 500) return false;
  if (!isTrimmed(value.tagId)) return false;
  return codePointLength(value.tagId) <= 512;
}

function hasValidAuthorSource(value: Record<string, unknown>): boolean {
  if (value.blacklistedAt !== null && !isTimestamp(value.blacklistedAt)) return false;
  if (value.blockSource !== "direct" && value.blockSource !== "upvoter") return false;
  return value.blockSource !== "upvoter" || value.blacklistedAt !== null;
}

export function parseBlacklistTransferAuthorDto(value: unknown): BlacklistTransferAuthorDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "platformId",
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
  if (!isPlatformId(value.platformId)) return null;
  if (!isCanonicalUserId(value.platformId, value.userId)) return null;
  if (!isValidMemberHash(value.platformId, value.userId, value.memberHashId)) return null;
  if (!hasValidAuthorText(value)) return null;
  if (!hasValidAuthorSource(value)) return null;
  return {
    platformId: value.platformId,
    userId: value.userId,
    memberHashId: value.memberHashId as string | null,
    authorNameAtCapture: value.authorNameAtCapture as string,
    tagId: value.tagId as string,
    blacklistedAt: value.blacklistedAt as string | null,
    blockSource: value.blockSource as "direct" | "upvoter",
  };
}

export function parseBlacklistTransferTagDto(value: unknown): BlacklistTransferTagDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["tagId", "name"])) return null;
  if (!isTrimmed(value.tagId)) return null;
  if (codePointLength(value.tagId) > 512) return null;
  if (!isTrimmed(value.name)) return null;
  if (codePointLength(value.name) > 30) return null;
  return { tagId: value.tagId, name: value.name };
}

function scopedIdentifier(platformId: string, identifier: string): string {
  return JSON.stringify([platformId, identifier]);
}

function validateTags(tags: readonly BlacklistTransferTagDto[]): Set<string> | null {
  if (tags.length < 1 || tags.length > BLACKLIST_TRANSFER_TAG_LIMIT) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const tag of tags) {
    const name = tag.name.toLowerCase();
    if (ids.has(tag.tagId) || names.has(name)) return null;
    ids.add(tag.tagId);
    names.add(name);
  }
  return tags.find(({ tagId }) => tagId === DEFAULT_TAG_ID)?.name === "default" ? ids : null;
}

function validateAuthors(
  authors: readonly BlacklistTransferAuthorDto[],
  tagIds: ReadonlySet<string>,
): boolean {
  const identifiers = new Set<string>();
  for (const author of authors) {
    if (!tagIds.has(author.tagId)) return false;
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) continue;
      const key = scopedIdentifier(author.platformId, identifier);
      if (identifiers.has(key)) return false;
      identifiers.add(key);
    }
  }
  return true;
}

function hasValidEnvelopeHeader(value: Record<string, unknown>): boolean {
  if (value.product !== BLACKLIST_TRANSFER_PRODUCT) return false;
  if (value.formatVersion !== BLACKLIST_TRANSFER_FORMAT_VERSION) return false;
  if (!isTimestamp(value.exportedAt)) return false;
  return value.schemaVersion === BLACKLIST_TRANSFER_SCHEMA_VERSION;
}

function parseTransferAuthors(value: unknown): readonly BlacklistTransferAuthorDto[] | null {
  if (!Array.isArray(value)) return null;
  const authors = value.map(parseBlacklistTransferAuthorDto);
  return authors.some((author) => author === null)
    ? null
    : (authors as BlacklistTransferAuthorDto[]);
}

function parseTransferTags(value: unknown): readonly BlacklistTransferTagDto[] | null {
  if (!Array.isArray(value)) return null;
  const tags = value.map(parseBlacklistTransferTagDto);
  return tags.some((tag) => tag === null) ? null : (tags as BlacklistTransferTagDto[]);
}

export function parseBlacklistTransferEnvelopeV1(
  value: unknown,
): BlacklistTransferEnvelopeV1 | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "product",
      "formatVersion",
      "exportedAt",
      "schemaVersion",
      "authors",
      "tags",
    ])
  ) {
    return null;
  }
  if (!hasValidEnvelopeHeader(value)) return null;
  const authors = parseTransferAuthors(value.authors);
  const tags = parseTransferTags(value.tags);
  if (!authors || !tags) return null;
  const tagIds = validateTags(tags);
  if (!tagIds || !validateAuthors(authors, tagIds)) return null;
  return {
    product: BLACKLIST_TRANSFER_PRODUCT,
    formatVersion: BLACKLIST_TRANSFER_FORMAT_VERSION,
    exportedAt: value.exportedAt as string,
    schemaVersion: BLACKLIST_TRANSFER_SCHEMA_VERSION,
    authors,
    tags,
  };
}

export function transferCollectionBytes(items: readonly unknown[]): number {
  const bytes = blacklistTransferJsonBytes(items);
  if (bytes === null) throw new Error("Transfer collection is not serializable.");
  return bytes;
}

export function canonicalTransferBytes(
  metadata: Pick<
    BlacklistTransferFileMetadataDto,
    "product" | "formatVersion" | "exportedAt" | "schemaVersion" | "authorsBytes" | "tagsBytes"
  >,
): number {
  const empty = blacklistTransferJsonBytes({
    product: metadata.product,
    formatVersion: metadata.formatVersion,
    exportedAt: metadata.exportedAt,
    schemaVersion: metadata.schemaVersion,
    authors: [],
    tags: [],
  });
  if (empty === null) throw new Error("Transfer metadata is not serializable.");
  return empty - 4 + metadata.authorsBytes + metadata.tagsBytes;
}

export function createBlacklistTransferFileMetadata(
  transfer: BlacklistTransferEnvelopeV1,
  sourceBytes: number,
): BlacklistTransferFileMetadataDto {
  const authorsBytes = transferCollectionBytes(transfer.authors);
  const tagsBytes = transferCollectionBytes(transfer.tags);
  const base = {
    product: transfer.product,
    formatVersion: transfer.formatVersion,
    exportedAt: transfer.exportedAt,
    schemaVersion: transfer.schemaVersion,
    authorsBytes,
    tagsBytes,
  };
  return {
    ...base,
    sourceBytes,
    canonicalBytes: canonicalTransferBytes(base),
    authorCount: transfer.authors.length,
    tagCount: transfer.tags.length,
    authorChunkCount: Math.ceil(transfer.authors.length / BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE),
    tagChunkCount: Math.ceil(transfer.tags.length / BLACKLIST_TRANSFER_TAG_CHUNK_SIZE),
  };
}

export function parseBlacklistTransferFileJson(json: string): BlacklistTransferFileParseResult {
  const sourceBytes = blacklistTransferTextBytes(json);
  if (sourceBytes > BLACKLIST_TRANSFER_FILE_BYTES) return { status: "too-large" };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const transfer = parseBlacklistTransferEnvelopeV1(parsedJson);
  if (!transfer) return { status: "invalid" };
  const metadata = createBlacklistTransferFileMetadata(transfer, sourceBytes);
  return metadata.canonicalBytes <= BLACKLIST_TRANSFER_FILE_BYTES
    ? { status: "valid", transfer, metadata }
    : { status: "too-large" };
}

export function serializeBlacklistTransferFile(value: BlacklistTransferEnvelopeV1): string | null {
  const transfer = parseBlacklistTransferEnvelopeV1(value);
  if (!transfer) return null;
  const json = JSON.stringify(transfer);
  return blacklistTransferTextBytes(json) <= BLACKLIST_TRANSFER_FILE_BYTES ? json : null;
}

export function isValidBlacklistTransferTimestamp(value: unknown): value is string {
  return isTimestamp(value);
}
