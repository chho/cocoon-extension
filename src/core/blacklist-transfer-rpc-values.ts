import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "./blacklist-contract-validation.ts";
import {
  BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE,
  BLACKLIST_TRANSFER_CURSOR_BYTES,
  BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE,
  BLACKLIST_TRANSFER_FILE_BYTES,
  BLACKLIST_TRANSFER_FORMAT_VERSION,
  BLACKLIST_TRANSFER_PRODUCT,
  BLACKLIST_TRANSFER_RPC_BYTES,
  BLACKLIST_TRANSFER_SCHEMA_VERSION,
  BLACKLIST_TRANSFER_TAG_CHUNK_SIZE,
  BLACKLIST_TRANSFER_TAG_LIMIT,
  blacklistTransferJsonBytes,
  blacklistTransferTextBytes,
  canonicalTransferBytes,
  hasExactBlacklistTransferKeys,
  isBlacklistTransferRecord,
  isValidBlacklistTransferTimestamp,
  parseBlacklistTransferAuthorDto,
  parseBlacklistTransferTagDto,
  type BlacklistTransferAuthorDto,
  type BlacklistTransferFileMetadataDto,
  type BlacklistTransferTagDto,
} from "./blacklist-transfer-values.ts";

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

export type BlacklistImportStatus = "receiving" | "ready" | "expired";

export interface BlacklistTransferProgressDto {
  readonly chunks: number;
  readonly count: number;
  readonly bytes: number;
}

export interface BlacklistImportSessionDto {
  readonly sessionId: string;
  readonly metadata: BlacklistTransferFileMetadataDto;
  readonly status: BlacklistImportStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly received: {
    readonly authors: BlacklistTransferProgressDto;
    readonly tags: BlacklistTransferProgressDto;
  };
}

export interface BlacklistImportAuthorsChunkInput {
  readonly sessionId: string;
  readonly chunkIndex: number;
  readonly startIndex: number;
  readonly authors: readonly BlacklistTransferAuthorDto[];
}

export interface BlacklistImportTagsChunkInput {
  readonly sessionId: string;
  readonly chunkIndex: number;
  readonly startIndex: number;
  readonly tags: readonly BlacklistTransferTagDto[];
}

export interface BlacklistExportBeginDto {
  readonly product: typeof BLACKLIST_TRANSFER_PRODUCT;
  readonly formatVersion: typeof BLACKLIST_TRANSFER_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly schemaVersion: typeof BLACKLIST_TRANSFER_SCHEMA_VERSION;
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

export interface BlacklistExportPageInput {
  readonly revision: number;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface BlacklistExportAuthorsPageDto {
  readonly revision: number;
  readonly items: readonly BlacklistTransferAuthorDto[];
  readonly nextCursor: string | null;
}

export interface BlacklistExportTagsPageDto {
  readonly revision: number;
  readonly items: readonly BlacklistTransferTagDto[];
  readonly nextCursor: string | null;
}

export interface BlacklistTransferSummaryDto {
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

export function isBlacklistTransferSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function validChunkCount(count: number, chunks: unknown, maximum: number): chunks is number {
  if (!isNonNegativeSafeInteger(chunks)) return false;
  if (count === 0) return chunks === 0;
  if (chunks < Math.ceil(count / maximum)) return false;
  return chunks <= count;
}

function hasValidMetadataIdentity(value: Record<string, unknown>): boolean {
  if (value.product !== BLACKLIST_TRANSFER_PRODUCT) return false;
  if (value.formatVersion !== BLACKLIST_TRANSFER_FORMAT_VERSION) return false;
  if (!isValidBlacklistTransferTimestamp(value.exportedAt)) return false;
  return value.schemaVersion === BLACKLIST_TRANSFER_SCHEMA_VERSION;
}

function hasValidMetadataBytes(value: Record<string, unknown>): boolean {
  if (!isPositiveSafeInteger(value.sourceBytes)) return false;
  if (value.sourceBytes > BLACKLIST_TRANSFER_FILE_BYTES) return false;
  if (!isPositiveSafeInteger(value.canonicalBytes)) return false;
  if (value.canonicalBytes > value.sourceBytes) return false;
  if (!isPositiveSafeInteger(value.authorsBytes) || value.authorsBytes < 2) return false;
  return isPositiveSafeInteger(value.tagsBytes) && value.tagsBytes > 2;
}

function hasValidMetadataCounts(value: Record<string, unknown>): boolean {
  if (!isNonNegativeSafeInteger(value.authorCount)) return false;
  if ((value.authorCount === 0) !== (value.authorsBytes === 2)) return false;
  if (!isPositiveSafeInteger(value.tagCount)) return false;
  if (value.tagCount > BLACKLIST_TRANSFER_TAG_LIMIT) return false;
  if (
    !validChunkCount(
      value.authorCount,
      value.authorChunkCount,
      BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE,
    )
  ) {
    return false;
  }
  return validChunkCount(value.tagCount, value.tagChunkCount, BLACKLIST_TRANSFER_TAG_CHUNK_SIZE);
}

export function parseBlacklistTransferFileMetadata(
  value: unknown,
): BlacklistTransferFileMetadataDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "product",
      "formatVersion",
      "exportedAt",
      "schemaVersion",
      "sourceBytes",
      "canonicalBytes",
      "authorsBytes",
      "tagsBytes",
      "authorCount",
      "tagCount",
      "authorChunkCount",
      "tagChunkCount",
    ])
  ) {
    return null;
  }
  if (!hasValidMetadataIdentity(value)) return null;
  if (!hasValidMetadataBytes(value)) return null;
  if (!hasValidMetadataCounts(value)) return null;
  const metadata = value as unknown as BlacklistTransferFileMetadataDto;
  return canonicalTransferBytes(metadata) === metadata.canonicalBytes ? metadata : null;
}

function hasUniqueChunkAuthors(authors: readonly BlacklistTransferAuthorDto[]): boolean {
  const identifiers = new Set<string>();
  for (const author of authors) {
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) continue;
      const key = JSON.stringify([author.platformId, identifier]);
      if (identifiers.has(key)) return false;
      identifiers.add(key);
    }
  }
  return true;
}

function hasUniqueChunkTags(tags: readonly BlacklistTransferTagDto[]): boolean {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const tag of tags) {
    const name = tag.name.toLowerCase();
    if (ids.has(tag.tagId) || names.has(name)) return false;
    ids.add(tag.tagId);
    names.add(name);
  }
  return true;
}

function parseChunkRecord(
  value: unknown,
  itemKey: "authors" | "tags",
  maximum: number,
): Record<string, unknown> | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["sessionId", "chunkIndex", "startIndex", itemKey])) {
    return null;
  }
  if (!isBlacklistTransferSessionId(value.sessionId)) return null;
  if (!isNonNegativeSafeInteger(value.chunkIndex)) return null;
  if (!isNonNegativeSafeInteger(value.startIndex)) return null;
  if (!Array.isArray(value[itemKey])) return null;
  if (value[itemKey].length < 1 || value[itemKey].length > maximum) return null;
  return value;
}

function isWithinTransferRpcLimit(value: unknown): boolean {
  return (blacklistTransferJsonBytes(value) ?? Infinity) <= BLACKLIST_TRANSFER_RPC_BYTES;
}

export function parseBlacklistImportAuthorsChunkInput(
  value: unknown,
): BlacklistImportAuthorsChunkInput | null {
  const record = parseChunkRecord(value, "authors", BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE);
  if (!record) return null;
  const authors = (record.authors as unknown[]).map(parseBlacklistTransferAuthorDto);
  if (authors.some((author) => author === null)) return null;
  const parsed = authors as BlacklistTransferAuthorDto[];
  if (!hasUniqueChunkAuthors(parsed)) return null;
  if (!isWithinTransferRpcLimit(record)) return null;
  return {
    sessionId: record.sessionId as string,
    chunkIndex: record.chunkIndex as number,
    startIndex: record.startIndex as number,
    authors: parsed,
  };
}

export function parseBlacklistImportTagsChunkInput(
  value: unknown,
): BlacklistImportTagsChunkInput | null {
  const record = parseChunkRecord(value, "tags", BLACKLIST_TRANSFER_TAG_CHUNK_SIZE);
  if (!record) return null;
  const tags = (record.tags as unknown[]).map(parseBlacklistTransferTagDto);
  if (tags.some((tag) => tag === null)) return null;
  const parsed = tags as BlacklistTransferTagDto[];
  if (!hasUniqueChunkTags(parsed)) return null;
  if (!isWithinTransferRpcLimit(record)) return null;
  return {
    sessionId: record.sessionId as string,
    chunkIndex: record.chunkIndex as number,
    startIndex: record.startIndex as number,
    tags: parsed,
  };
}

export function isBlacklistTransferCursor(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length === 0) return false;
  return blacklistTransferTextBytes(value) <= BLACKLIST_TRANSFER_CURSOR_BYTES;
}

export function parseBlacklistExportPageInput(value: unknown): BlacklistExportPageInput | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["revision", "cursor", "limit"])) return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isBlacklistTransferCursor(value.cursor)) return null;
  if (!isPositiveSafeInteger(value.limit)) return null;
  if (value.limit > BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE) return null;
  return value as unknown as BlacklistExportPageInput;
}

function hasValidProgressBounds(
  value: Record<string, unknown>,
  maximum: number,
  bytes: number,
): boolean {
  if (!isNonNegativeSafeInteger(value.chunks)) return false;
  if (value.chunks > maximum) return false;
  if (!isNonNegativeSafeInteger(value.count)) return false;
  if (value.chunks > value.count) return false;
  if (!isPositiveSafeInteger(value.bytes)) return false;
  if (value.bytes < 2) return false;
  return value.bytes <= bytes;
}

function hasValidEmptyProgress(value: Record<string, unknown>): boolean {
  if (value.chunks === 0) return value.count === 0 && value.bytes === 2;
  return value.bytes !== 2;
}

function parseProgress(
  value: unknown,
  maximum: number,
  bytes: number,
): BlacklistTransferProgressDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["chunks", "count", "bytes"])) return null;
  if (!hasValidProgressBounds(value, maximum, bytes)) return null;
  return hasValidEmptyProgress(value) ? (value as unknown as BlacklistTransferProgressDto) : null;
}

function hasValidSessionTiming(value: Record<string, unknown>): boolean {
  if (!isNonNegativeSafeInteger(value.createdAt)) return false;
  if (!isNonNegativeSafeInteger(value.updatedAt)) return false;
  if (!isNonNegativeSafeInteger(value.expiresAt)) return false;
  if (value.createdAt > value.updatedAt) return false;
  return value.updatedAt < value.expiresAt;
}

function isImportStatus(value: unknown): value is BlacklistImportStatus {
  return value === "receiving" || value === "ready" || value === "expired";
}

function isCompleteSession(
  metadata: BlacklistTransferFileMetadataDto,
  authors: BlacklistTransferProgressDto,
  tags: BlacklistTransferProgressDto,
): boolean {
  return (
    authors.chunks === metadata.authorChunkCount &&
    authors.count === metadata.authorCount &&
    authors.bytes === metadata.authorsBytes &&
    tags.chunks === metadata.tagChunkCount &&
    tags.count === metadata.tagCount &&
    tags.bytes === metadata.tagsBytes
  );
}

function hasStatusMatchingCompleteness(status: BlacklistImportStatus, complete: boolean): boolean {
  if (status === "ready") return complete;
  if (status === "receiving") return !complete;
  return true;
}

interface ParsedSessionProgress {
  readonly authors: BlacklistTransferProgressDto;
  readonly tags: BlacklistTransferProgressDto;
}

function parseSessionProgress(
  value: unknown,
  metadata: BlacklistTransferFileMetadataDto,
): ParsedSessionProgress | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["authors", "tags"])) return null;
  const authors = parseProgress(value.authors, metadata.authorChunkCount, metadata.authorsBytes);
  if (!authors) return null;
  const tags = parseProgress(value.tags, metadata.tagChunkCount, metadata.tagsBytes);
  if (!tags) return null;
  if (authors.count > metadata.authorCount) return null;
  if (tags.count > metadata.tagCount) return null;
  return { authors, tags };
}

export function parseBlacklistImportSessionDto(value: unknown): BlacklistImportSessionDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "sessionId",
      "metadata",
      "status",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "received",
    ])
  ) {
    return null;
  }
  if (!isBlacklistTransferSessionId(value.sessionId)) return null;
  if (!hasValidSessionTiming(value)) return null;
  if (!isImportStatus(value.status)) return null;
  const metadata = parseBlacklistTransferFileMetadata(value.metadata);
  if (!metadata) return null;
  const received = parseSessionProgress(value.received, metadata);
  if (!received) return null;
  const complete = isCompleteSession(metadata, received.authors, received.tags);
  return hasStatusMatchingCompleteness(value.status, complete)
    ? (value as unknown as BlacklistImportSessionDto)
    : null;
}

export function parseBlacklistTransferSummary(value: unknown): BlacklistTransferSummaryDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["revision", "authorCount", "tagCount"])) return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isNonNegativeSafeInteger(value.authorCount)) return null;
  if (!isPositiveSafeInteger(value.tagCount)) return null;
  if (value.tagCount > BLACKLIST_TRANSFER_TAG_LIMIT) return null;
  return value as unknown as BlacklistTransferSummaryDto;
}

export function parseBlacklistExportBegin(value: unknown): BlacklistExportBeginDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "product",
      "formatVersion",
      "exportedAt",
      "schemaVersion",
      "revision",
      "authorCount",
      "tagCount",
    ])
  ) {
    return null;
  }
  if (value.product !== BLACKLIST_TRANSFER_PRODUCT) return null;
  if (value.formatVersion !== BLACKLIST_TRANSFER_FORMAT_VERSION) return null;
  if (!isValidBlacklistTransferTimestamp(value.exportedAt)) return null;
  if (value.schemaVersion !== BLACKLIST_TRANSFER_SCHEMA_VERSION) return null;
  return parseBlacklistTransferSummary({
    revision: value.revision,
    authorCount: value.authorCount,
    tagCount: value.tagCount,
  })
    ? (value as unknown as BlacklistExportBeginDto)
    : null;
}

function parsePageRecord(value: unknown): Record<string, unknown> | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["revision", "items", "nextCursor"])) return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isBlacklistTransferCursor(value.nextCursor)) return null;
  if (!Array.isArray(value.items)) return null;
  if (value.items.length > BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE) return null;
  if (value.items.length === 0 && value.nextCursor !== null) return null;
  return value;
}

export function parseBlacklistExportAuthorsPage(
  value: unknown,
): BlacklistExportAuthorsPageDto | null {
  const record = parsePageRecord(value);
  if (!record) return null;
  const authors = (record.items as unknown[]).map(parseBlacklistTransferAuthorDto);
  if (authors.some((author) => author === null)) return null;
  if (!hasUniqueChunkAuthors(authors as BlacklistTransferAuthorDto[])) return null;
  return record as unknown as BlacklistExportAuthorsPageDto;
}

export function parseBlacklistExportTagsPage(value: unknown): BlacklistExportTagsPageDto | null {
  const record = parsePageRecord(value);
  if (!record) return null;
  const tags = (record.items as unknown[]).map(parseBlacklistTransferTagDto);
  if (tags.some((tag) => tag === null)) return null;
  if (!hasUniqueChunkTags(tags as BlacklistTransferTagDto[])) return null;
  return record as unknown as BlacklistExportTagsPageDto;
}
