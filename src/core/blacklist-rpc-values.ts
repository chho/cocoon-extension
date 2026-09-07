import {
  contractCodePointLength as codePointLength,
  hasExactContractKeys,
  isContractRecord,
} from "./blacklist-contract-validation.ts";

const MAX_PLATFORM_ID_ASCII_LENGTH = 64;
const MAX_STABLE_ID_CODE_POINTS = 512;
const MAX_AUTHOR_NAME_CODE_POINTS = 500;
const MAX_TAG_NAME_CODE_POINTS = 30;
const ZHIHU_PLATFORM_ID = "zhihu";
const DEFAULT_TAG_ID = "default";
const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MEMBER_HASH_PATTERN = /^[0-9a-f]{32}$/;
const MEMBER_HASH_CASE_INSENSITIVE_PATTERN = /^[0-9a-f]{32}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface BlacklistAuthorIdentityDto {
  readonly platformId: string;
  readonly userId: string;
}

export interface BlacklistAuthorDto extends BlacklistAuthorIdentityDto {
  readonly memberHashId: string | null;
  readonly authorName: string;
  readonly tagId: string;
  readonly blacklistedAt: string | null;
  readonly source: "direct" | "upvoter";
}

export interface BlacklistTagDto {
  readonly tagId: string;
  readonly name: string;
  readonly isDefault: boolean;
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isPlatformId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.length <= MAX_PLATFORM_ID_ASCII_LENGTH && PLATFORM_ID_PATTERN.test(value);
}

function isCanonicalUserId(platformId: string, value: unknown): value is string {
  if (!isTrimmedNonEmpty(value)) return false;
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
  if (typeof value.authorName !== "string") return false;
  if (codePointLength(value.authorName) > MAX_AUTHOR_NAME_CODE_POINTS) return false;
  return isBlacklistTagId(value.tagId);
}

function hasValidAuthorSource(value: Record<string, unknown>): boolean {
  if (value.blacklistedAt !== null && !isValidTimestamp(value.blacklistedAt)) return false;
  if (value.source !== "direct" && value.source !== "upvoter") return false;
  return value.source !== "upvoter" || value.blacklistedAt !== null;
}

export function scopedBlacklistIdentifierKey(platformId: string, identifier: string): string {
  return JSON.stringify([platformId, identifier]);
}

export function isBlacklistTagId(value: unknown): value is string {
  return isTrimmedNonEmpty(value) && codePointLength(value) <= MAX_STABLE_ID_CODE_POINTS;
}

export function isBoundedBlacklistTagName(value: unknown): value is string {
  return typeof value === "string" && codePointLength(value) <= MAX_TAG_NAME_CODE_POINTS;
}

export function parseBlacklistAuthorIdentityDto(value: unknown): BlacklistAuthorIdentityDto | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["platformId", "userId"])) return null;
  if (!isPlatformId(value.platformId)) return null;
  if (!isCanonicalUserId(value.platformId, value.userId)) return null;
  if (codePointLength(value.userId) > MAX_STABLE_ID_CODE_POINTS) return null;
  return { platformId: value.platformId, userId: value.userId };
}

export function parseBlacklistAuthorDto(value: unknown): BlacklistAuthorDto | null {
  if (!isContractRecord(value)) return null;
  if (
    !hasExactContractKeys(value, [
      "platformId",
      "userId",
      "memberHashId",
      "authorName",
      "tagId",
      "blacklistedAt",
      "source",
    ])
  ) {
    return null;
  }
  if (!isPlatformId(value.platformId)) return null;
  if (!isCanonicalUserId(value.platformId, value.userId)) return null;
  if (codePointLength(value.userId) > MAX_STABLE_ID_CODE_POINTS) return null;
  if (!isValidMemberHash(value.platformId, value.userId, value.memberHashId)) return null;
  if (!hasValidAuthorText(value)) return null;
  if (!hasValidAuthorSource(value)) return null;
  return {
    platformId: value.platformId,
    userId: value.userId,
    memberHashId: value.memberHashId as string | null,
    authorName: value.authorName as string,
    tagId: value.tagId as string,
    blacklistedAt: value.blacklistedAt as string | null,
    source: value.source as "direct" | "upvoter",
  };
}

export function parseBlacklistTagDto(value: unknown): BlacklistTagDto | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["tagId", "name", "isDefault"])) return null;
  if (!isBlacklistTagId(value.tagId)) return null;
  if (!isTrimmedNonEmpty(value.name)) return null;
  if (codePointLength(value.name) > MAX_TAG_NAME_CODE_POINTS) return null;
  if (typeof value.isDefault !== "boolean") return null;
  if (value.isDefault !== (value.tagId === DEFAULT_TAG_ID)) return null;
  if (value.isDefault && value.name !== "default") return null;
  return { tagId: value.tagId, name: value.name, isDefault: value.isDefault };
}
