import type * as TransferContractModule from "../core/blacklist-transfer-rpc-contract.ts";
import type {
  BlacklistImportSessionDto,
  BlacklistTransferProgressDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type * as TransferValuesModule from "../core/blacklist-transfer-values.ts";
import type {
  BlacklistTransferAuthorDto,
  BlacklistTransferFileMetadataDto,
  BlacklistTransferTagDto,
} from "../core/blacklist-transfer-values.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundTransferContract from "../core/blacklist-transfer-rpc-contract.ts?background-copy";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundTransferValues from "../core/blacklist-transfer-values.ts?background-copy";

const { parseBlacklistImportSessionDto, parseBlacklistTransferFileMetadata } =
  backgroundTransferContract as typeof TransferContractModule;
const {
  blacklistTransferTextBytes,
  hasExactBlacklistTransferKeys,
  isBlacklistTransferRecord,
  parseBlacklistTransferAuthorDto,
  parseBlacklistTransferTagDto,
} = backgroundTransferValues as typeof TransferValuesModule;

export interface StoredImportSession extends Omit<BlacklistImportSessionDto, "status"> {
  readonly status: "receiving" | "ready";
}

export interface StoredImportAuthor extends BlacklistTransferAuthorDto {
  readonly sessionId: string;
  readonly index: number;
}

export interface StoredImportIdentifier {
  readonly sessionId: string;
  readonly platformId: string;
  readonly identifier: string;
  readonly authorIndex: number;
}

export interface StoredImportTag extends BlacklistTransferTagDto {
  readonly sessionId: string;
  readonly index: number;
  readonly nameKey: string;
}

export interface StoredImportChunk {
  readonly sessionId: string;
  readonly kind: "authors" | "tags";
  readonly chunkIndex: number;
  readonly startIndex: number;
  readonly itemCount: number;
  readonly payloadJson: string;
  readonly payloadBytes: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isImportSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function createStoredImportSession(
  sessionId: string,
  metadata: BlacklistTransferFileMetadataDto,
  createdAt: number,
  expiresAt: number,
): StoredImportSession {
  const emptyProgress: BlacklistTransferProgressDto = { chunks: 0, count: 0, bytes: 2 };
  return {
    sessionId,
    metadata,
    status: "receiving",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    received: { authors: emptyProgress, tags: emptyProgress },
  };
}

export function parseStoredImportSession(value: unknown): StoredImportSession | null {
  const parsed = parseBlacklistImportSessionDto(value);
  return parsed && parsed.status !== "expired" ? (parsed as StoredImportSession) : null;
}

export function createStoredImportAuthor(
  sessionId: string,
  index: number,
  author: BlacklistTransferAuthorDto,
): StoredImportAuthor {
  return { sessionId, index, ...author };
}

export function parseStoredImportAuthor(value: unknown): StoredImportAuthor | null {
  if (
    !isBlacklistTransferRecord(value) ||
    !hasExactBlacklistTransferKeys(value, [
      "sessionId",
      "index",
      "platformId",
      "userId",
      "memberHashId",
      "authorNameAtCapture",
      "tagId",
      "blacklistedAt",
      "blockSource",
    ]) ||
    !isImportSessionId(value.sessionId) ||
    !isNonNegativeInteger(value.index)
  ) {
    return null;
  }
  const author = parseBlacklistTransferAuthorDto({
    platformId: value.platformId,
    userId: value.userId,
    memberHashId: value.memberHashId,
    authorNameAtCapture: value.authorNameAtCapture,
    tagId: value.tagId,
    blacklistedAt: value.blacklistedAt,
    blockSource: value.blockSource,
  });
  return author ? { sessionId: value.sessionId, index: value.index, ...author } : null;
}

export function createStoredImportIdentifier(
  sessionId: string,
  authorIndex: number,
  author: Pick<BlacklistTransferAuthorDto, "platformId">,
  identifier: string,
): StoredImportIdentifier {
  return { sessionId, platformId: author.platformId, identifier, authorIndex };
}

function hasStoredImportIdentifierValues(value: Record<string, unknown>): boolean {
  if (!isImportSessionId(value.sessionId)) return false;
  if (typeof value.platformId !== "string") return false;
  if (!/^[a-z][a-z0-9-]*$/.test(value.platformId) || value.platformId.length > 64) return false;
  if (typeof value.identifier !== "string") return false;
  if (value.identifier.length === 0 || value.identifier !== value.identifier.trim()) return false;
  if (Array.from(value.identifier).length > 512) return false;
  return isNonNegativeInteger(value.authorIndex);
}

export function parseStoredImportIdentifier(value: unknown): StoredImportIdentifier | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, [
      "sessionId",
      "platformId",
      "identifier",
      "authorIndex",
    ]) ||
    !hasStoredImportIdentifierValues(value)
  ) {
    return null;
  }
  return value as unknown as StoredImportIdentifier;
}

export function createStoredImportTag(
  sessionId: string,
  index: number,
  tag: BlacklistTransferTagDto,
): StoredImportTag {
  return { sessionId, index, ...tag, nameKey: tag.name.toLowerCase() };
}

export function parseStoredImportTag(value: unknown): StoredImportTag | null {
  if (
    !isBlacklistTransferRecord(value) ||
    !hasExactBlacklistTransferKeys(value, ["sessionId", "index", "tagId", "name", "nameKey"]) ||
    !isImportSessionId(value.sessionId) ||
    !isNonNegativeInteger(value.index) ||
    typeof value.nameKey !== "string"
  ) {
    return null;
  }
  const tag = parseBlacklistTransferTagDto({ tagId: value.tagId, name: value.name });
  if (!tag || value.nameKey !== tag.name.toLowerCase()) return null;
  return { sessionId: value.sessionId, index: value.index, ...tag, nameKey: value.nameKey };
}

function parseChunkPayload(
  value: Pick<StoredImportChunk, "kind" | "payloadJson" | "itemCount">,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.payloadJson) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length !== value.itemCount) return false;
  const values =
    value.kind === "authors"
      ? parsed.map(parseBlacklistTransferAuthorDto)
      : parsed.map(parseBlacklistTransferTagDto);
  return values.every((item) => item !== null) && JSON.stringify(values) === value.payloadJson;
}

export function createStoredImportChunk(input: {
  readonly sessionId: string;
  readonly kind: StoredImportChunk["kind"];
  readonly chunkIndex: number;
  readonly startIndex: number;
  readonly itemCount: number;
  readonly payloadJson: string;
}): StoredImportChunk {
  return { ...input, payloadBytes: blacklistTransferTextBytes(input.payloadJson) };
}

const IMPORT_CHUNK_KEYS = [
  "sessionId",
  "kind",
  "chunkIndex",
  "startIndex",
  "itemCount",
  "payloadJson",
  "payloadBytes",
] as const;

function hasStoredImportChunkValues(value: Record<string, unknown>): boolean {
  if (!isImportSessionId(value.sessionId)) return false;
  if (value.kind !== "authors" && value.kind !== "tags") return false;
  if (!isNonNegativeInteger(value.chunkIndex) || !isNonNegativeInteger(value.startIndex)) {
    return false;
  }
  if (!Number.isSafeInteger(value.itemCount) || (value.itemCount as number) < 1) return false;
  if (typeof value.payloadJson !== "string" || !isNonNegativeInteger(value.payloadBytes)) {
    return false;
  }
  return blacklistTransferTextBytes(value.payloadJson) === value.payloadBytes;
}

export function parseStoredImportChunk(value: unknown): StoredImportChunk | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, IMPORT_CHUNK_KEYS)) return null;
  if (!hasStoredImportChunkValues(value)) return null;
  const parsed = value as unknown as StoredImportChunk;
  return parseChunkPayload(parsed) ? parsed : null;
}

export function requireStoredImportMetadata(value: unknown): BlacklistTransferFileMetadataDto {
  const metadata = parseBlacklistTransferFileMetadata(value);
  if (!metadata) throw new Error("IndexedDB import metadata is unreadable.");
  return metadata;
}
