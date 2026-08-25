import type {
  AuthorIdentity,
  CommitInput,
  UpvoterCommitInput,
} from "../content/blacklist-state.ts";

export const BLACKLIST_CONTENT_RPC_VERSION = 1 as const;
export const BLACKLIST_CONTENT_RPC_REQUEST_TYPE = "cocoon.blacklist.content.request" as const;
export const BLACKLIST_CONTENT_RPC_RESPONSE_TYPE = "cocoon.blacklist.content.response" as const;

const MAX_CONTENT_RPC_BYTES = 8 * 1024 * 1024;
const MAX_PLATFORM_ID_LENGTH = 64;
const MAX_STABLE_ID_CODE_POINTS = 512;
const MAX_AUTHOR_NAME_CODE_POINTS = 500;
const MAX_TAG_NAME_CODE_POINTS = 30;
const ZHIHU_PLATFORM_ID = "zhihu";
const MEMBER_HASH_PATTERN = /^[0-9a-f]{32}$/;
const MEMBER_HASH_CASE_INSENSITIVE_PATTERN = /^[0-9a-f]{32}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type BlacklistContentOperation =
  | "hydrate"
  | "commit-author"
  | "backfill-member-hash"
  | "commit-upvoter"
  | "preflight-direct"
  | "delete-tag";

export type BlacklistContentRequest =
  | ContentRequest<"hydrate", Record<string, never>>
  | ContentRequest<"commit-author", { readonly input: CommitInput }>
  | ContentRequest<
      "backfill-member-hash",
      { readonly identity: AuthorIdentity; readonly memberHashId: string }
    >
  | ContentRequest<"commit-upvoter", { readonly input: UpvoterCommitInput }>
  | ContentRequest<
      "preflight-direct",
      { readonly identity: AuthorIdentity; readonly expectedBlacklistedAt: string }
    >
  | ContentRequest<"delete-tag", { readonly tagId: string }>;

interface ContentRequest<Operation extends BlacklistContentOperation, Input> {
  readonly version: typeof BLACKLIST_CONTENT_RPC_VERSION;
  readonly type: typeof BLACKLIST_CONTENT_RPC_REQUEST_TYPE;
  readonly operation: Operation;
  readonly input: Input;
}

export interface BlacklistContentResponse {
  readonly version: typeof BLACKLIST_CONTENT_RPC_VERSION;
  readonly type: typeof BLACKLIST_CONTENT_RPC_RESPONSE_TYPE;
  readonly operation: BlacklistContentOperation;
  readonly ok: boolean;
  readonly result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isTrimmedWithin(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    codePointLength(value) <= maximum
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isCanonicalZhihuUserId(value: unknown): value is string {
  return (
    isTrimmedWithin(value, MAX_STABLE_ID_CODE_POINTS) &&
    (!MEMBER_HASH_CASE_INSENSITIVE_PATTERN.test(value) || MEMBER_HASH_PATTERN.test(value))
  );
}

function isIdentity(value: unknown): value is AuthorIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["platformId", "userId"]) &&
    value.platformId === ZHIHU_PLATFORM_ID &&
    value.platformId.length <= MAX_PLATFORM_ID_LENGTH &&
    isCanonicalZhihuUserId(value.userId)
  );
}

function isTag(value: unknown): value is CommitInput["tag"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "tagId"]) &&
    isTrimmedWithin(value.tagId, MAX_STABLE_ID_CODE_POINTS) &&
    isTrimmedWithin(value.name, MAX_TAG_NAME_CODE_POINTS)
  );
}

function isMemberHash(value: unknown, userId: string): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && MEMBER_HASH_PATTERN.test(value) && value !== userId)
  );
}

function isCommitInput(value: unknown): value is CommitInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "authorNameAtCapture",
      "blacklistedAt",
      "isNewTag",
      "memberHashId",
      "platformId",
      "tag",
      "userId",
    ]) &&
    value.platformId === ZHIHU_PLATFORM_ID &&
    isCanonicalZhihuUserId(value.userId) &&
    isMemberHash(value.memberHashId, value.userId) &&
    typeof value.authorNameAtCapture === "string" &&
    codePointLength(value.authorNameAtCapture) <= MAX_AUTHOR_NAME_CODE_POINTS &&
    isTag(value.tag) &&
    typeof value.isNewTag === "boolean" &&
    isTimestamp(value.blacklistedAt)
  );
}

function isUpvoterInput(value: unknown): value is UpvoterCommitInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "authorNameAtCapture",
      "blacklistedAt",
      "platformId",
      "tagId",
      "userId",
    ]) &&
    value.platformId === ZHIHU_PLATFORM_ID &&
    isCanonicalZhihuUserId(value.userId) &&
    typeof value.authorNameAtCapture === "string" &&
    codePointLength(value.authorNameAtCapture) <= MAX_AUTHOR_NAME_CODE_POINTS &&
    isTrimmedWithin(value.tagId, MAX_STABLE_ID_CODE_POINTS) &&
    isTimestamp(value.blacklistedAt)
  );
}

function isWithinContentRpcLimit(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return (
      typeof json === "string" && new TextEncoder().encode(json).byteLength <= MAX_CONTENT_RPC_BYTES
    );
  } catch {
    return false;
  }
}

function requestBase(value: Record<string, unknown>): boolean {
  return (
    hasExactKeys(value, ["input", "operation", "type", "version"]) &&
    value.version === BLACKLIST_CONTENT_RPC_VERSION &&
    value.type === BLACKLIST_CONTENT_RPC_REQUEST_TYPE &&
    isRecord(value.input)
  );
}

function parseCommitAuthor(input: Record<string, unknown>): BlacklistContentRequest | null {
  return hasExactKeys(input, ["input"]) && isCommitInput(input.input)
    ? createBlacklistContentRequest("commit-author", { input: input.input })
    : null;
}

function parseAliasBackfill(input: Record<string, unknown>): BlacklistContentRequest | null {
  if (
    !hasExactKeys(input, ["identity", "memberHashId"]) ||
    !isIdentity(input.identity) ||
    !isMemberHash(input.memberHashId, input.identity.userId) ||
    input.memberHashId === null
  ) {
    return null;
  }
  return createBlacklistContentRequest("backfill-member-hash", {
    identity: input.identity,
    memberHashId: input.memberHashId,
  });
}

function parseUpvoterCommit(input: Record<string, unknown>): BlacklistContentRequest | null {
  return hasExactKeys(input, ["input"]) && isUpvoterInput(input.input)
    ? createBlacklistContentRequest("commit-upvoter", { input: input.input })
    : null;
}

function parseDirectPreflight(input: Record<string, unknown>): BlacklistContentRequest | null {
  if (
    !hasExactKeys(input, ["expectedBlacklistedAt", "identity"]) ||
    !isIdentity(input.identity) ||
    !isTimestamp(input.expectedBlacklistedAt)
  ) {
    return null;
  }
  return createBlacklistContentRequest("preflight-direct", {
    identity: input.identity,
    expectedBlacklistedAt: input.expectedBlacklistedAt,
  });
}

function parseContentOperation(
  operation: unknown,
  input: Record<string, unknown>,
): BlacklistContentRequest | null {
  switch (operation) {
    case "hydrate":
      return hasExactKeys(input, []) ? createBlacklistContentRequest("hydrate", {}) : null;
    case "commit-author":
      return parseCommitAuthor(input);
    case "backfill-member-hash":
      return parseAliasBackfill(input);
    case "commit-upvoter":
      return parseUpvoterCommit(input);
    case "preflight-direct":
      return parseDirectPreflight(input);
    case "delete-tag":
      return hasExactKeys(input, ["tagId"]) &&
        isTrimmedWithin(input.tagId, MAX_STABLE_ID_CODE_POINTS)
        ? createBlacklistContentRequest("delete-tag", { tagId: input.tagId })
        : null;
    default:
      return null;
  }
}

export function parseBlacklistContentRequest(value: unknown): BlacklistContentRequest | null {
  if (!isWithinContentRpcLimit(value) || !isRecord(value) || !requestBase(value)) return null;
  return parseContentOperation(value.operation, value.input as Record<string, unknown>);
}

export function createBlacklistContentRequest<
  Operation extends BlacklistContentRequest["operation"],
>(
  operation: Operation,
  input: Extract<BlacklistContentRequest, { readonly operation: Operation }>["input"],
): Extract<BlacklistContentRequest, { readonly operation: Operation }> {
  return {
    version: BLACKLIST_CONTENT_RPC_VERSION,
    type: BLACKLIST_CONTENT_RPC_REQUEST_TYPE,
    operation,
    input,
  } as Extract<BlacklistContentRequest, { readonly operation: Operation }>;
}

export function createBlacklistContentResponse(
  operation: BlacklistContentOperation,
  ok: boolean,
  result: unknown = null,
): BlacklistContentResponse {
  return {
    version: BLACKLIST_CONTENT_RPC_VERSION,
    type: BLACKLIST_CONTENT_RPC_RESPONSE_TYPE,
    operation,
    ok,
    result,
  };
}

export function parseBlacklistContentResponseEnvelope(
  value: unknown,
  operation: BlacklistContentOperation,
): BlacklistContentResponse | null {
  if (
    !isWithinContentRpcLimit(value) ||
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "operation", "result", "type", "version"]) ||
    value.version !== BLACKLIST_CONTENT_RPC_VERSION ||
    value.type !== BLACKLIST_CONTENT_RPC_RESPONSE_TYPE ||
    value.operation !== operation ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  return value as unknown as BlacklistContentResponse;
}
