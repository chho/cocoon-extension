export const BLACKLIST_RPC_VERSION = 1 as const;
export const BLACKLIST_RPC_REQUEST_TYPE = "cocoon.blacklist.request" as const;
export const BLACKLIST_RPC_RESPONSE_TYPE = "cocoon.blacklist.response" as const;

export type BlacklistRpcOperation =
  | "status"
  | "snapshot"
  | "remove-one"
  | "restore-one"
  | "remove-many"
  | "rename-tag"
  | "delete-tag";

export interface BlacklistAuthorDto {
  readonly userId: string;
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

export interface BlacklistSnapshotDto {
  readonly authors: readonly BlacklistAuthorDto[];
  readonly tags: readonly BlacklistTagDto[];
}

export type CurrentPageStatus = "running" | "unsupported" | "connection-error";

export type BlacklistRpcRequest =
  | RpcRequest<"status", Record<never, never>>
  | RpcRequest<"snapshot", Record<never, never>>
  | RpcRequest<"remove-one", { readonly userId: string }>
  | RpcRequest<"restore-one", { readonly author: BlacklistAuthorDto }>
  | RpcRequest<"remove-many", { readonly userIds: readonly string[] }>
  | RpcRequest<"rename-tag", { readonly tagId: string; readonly name: string }>
  | RpcRequest<"delete-tag", { readonly tagId: string }>;

interface RpcRequest<Operation extends BlacklistRpcOperation, Input> {
  readonly version: typeof BLACKLIST_RPC_VERSION;
  readonly type: typeof BLACKLIST_RPC_REQUEST_TYPE;
  readonly operation: Operation;
  readonly input: Input;
}

export type BlacklistRpcError =
  | "storage-unreadable"
  | "save-failed"
  | "conflict"
  | "not-found"
  | "invalid-tag";

export interface BlacklistRpcData {
  readonly status: CurrentPageStatus | null;
  readonly count: number | null;
  readonly snapshot: BlacklistSnapshotDto | null;
  readonly removed: BlacklistAuthorDto | null;
}

export interface BlacklistRpcResponse {
  readonly version: typeof BLACKLIST_RPC_VERSION;
  readonly type: typeof BLACKLIST_RPC_RESPONSE_TYPE;
  readonly operation: BlacklistRpcOperation;
  readonly ok: boolean;
  readonly data: BlacklistRpcData;
  readonly error: BlacklistRpcError | null;
}

const OPERATIONS: readonly BlacklistRpcOperation[] = [
  "status",
  "snapshot",
  "remove-one",
  "restore-one",
  "remove-many",
  "rename-tag",
  "delete-tag",
];
const ERRORS: readonly BlacklistRpcError[] = [
  "storage-unreadable",
  "save-failed",
  "conflict",
  "not-found",
  "invalid-tag",
];
const MEMBER_HASH_PATTERN = /^[0-9a-f]{32}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function isTrimmedNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isCanonicalUserId(value: unknown): value is string {
  return isTrimmedNonEmpty(value) &&
    (!/^[0-9a-f]{32}$/i.test(value) || MEMBER_HASH_PATTERN.test(value));
}

function isEmptyInput(value: unknown): value is Record<never, never> {
  return isRecord(value) && hasExactKeys(value, []);
}

function parseAuthor(value: unknown): BlacklistAuthorDto | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "userId",
      "memberHashId",
      "authorName",
      "tagId",
      "blacklistedAt",
      "source",
    ]) ||
    !isCanonicalUserId(value.userId) ||
    (value.memberHashId !== null &&
      (typeof value.memberHashId !== "string" ||
        !MEMBER_HASH_PATTERN.test(value.memberHashId))) ||
    value.memberHashId === value.userId ||
    typeof value.authorName !== "string" ||
    !isTrimmedNonEmpty(value.tagId) ||
    (value.blacklistedAt !== null && !isValidTimestamp(value.blacklistedAt)) ||
    (value.source !== "direct" && value.source !== "upvoter") ||
    (value.source === "upvoter" && value.blacklistedAt === null)
  ) {
    return null;
  }
  return {
    userId: value.userId,
    memberHashId: value.memberHashId as string | null,
    authorName: value.authorName,
    tagId: value.tagId,
    blacklistedAt: value.blacklistedAt as string | null,
    source: value.source,
  };
}

function parseTag(value: unknown): BlacklistTagDto | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tagId", "name", "isDefault"]) ||
    !isTrimmedNonEmpty(value.tagId) ||
    !isTrimmedNonEmpty(value.name) ||
    Array.from(value.name).length > 30 ||
    typeof value.isDefault !== "boolean" ||
    value.isDefault !== (value.tagId === "default") ||
    (value.isDefault && value.name !== "default")
  ) {
    return null;
  }
  return { tagId: value.tagId, name: value.name, isDefault: value.isDefault };
}

function parseSnapshot(value: unknown): BlacklistSnapshotDto | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authors", "tags"]) ||
    !Array.isArray(value.authors) ||
    !Array.isArray(value.tags)
  ) {
    return null;
  }
  const authors = value.authors.map(parseAuthor);
  const tags = value.tags.map(parseTag);
  if (authors.some((author) => author === null) || tags.some((tag) => tag === null)) {
    return null;
  }
  const parsedAuthors = authors as BlacklistAuthorDto[];
  const parsedTags = tags as BlacklistTagDto[];
  const tagIds = new Set(parsedTags.map(({ tagId }) => tagId));
  const tagNames = new Set(parsedTags.map(({ name }) => name.toLocaleLowerCase()));
  const identifiers = new Set<string>();
  if (
    tagIds.size !== parsedTags.length ||
    tagNames.size !== parsedTags.length ||
    parsedTags.filter(({ isDefault }) => isDefault).length !== 1 ||
    parsedAuthors.some(({ tagId }) => !tagIds.has(tagId))
  ) {
    return null;
  }
  for (const author of parsedAuthors) {
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) continue;
      if (identifiers.has(identifier)) return null;
      identifiers.add(identifier);
    }
  }
  return { authors: parsedAuthors, tags: parsedTags };
}

function isOperation(value: unknown): value is BlacklistRpcOperation {
  return typeof value === "string" && OPERATIONS.includes(value as BlacklistRpcOperation);
}

export function parseBlacklistRpcRequest(value: unknown): BlacklistRpcRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "type", "operation", "input"]) ||
    value.version !== BLACKLIST_RPC_VERSION ||
    value.type !== BLACKLIST_RPC_REQUEST_TYPE ||
    !isOperation(value.operation)
  ) {
    return null;
  }
  const input = value.input;
  if ((value.operation === "status" || value.operation === "snapshot") && isEmptyInput(input)) {
    return value as unknown as BlacklistRpcRequest;
  }
  if (!isRecord(input)) {
    return null;
  }
  if (
    value.operation === "remove-one" &&
    hasExactKeys(input, ["userId"]) &&
    isCanonicalUserId(input.userId)
  ) {
    return value as unknown as BlacklistRpcRequest;
  }
  if (
    value.operation === "restore-one" &&
    hasExactKeys(input, ["author"]) &&
    parseAuthor(input.author) !== null
  ) {
    return value as unknown as BlacklistRpcRequest;
  }
  if (
    value.operation === "remove-many" &&
    hasExactKeys(input, ["userIds"]) &&
    Array.isArray(input.userIds) &&
    input.userIds.length > 0 &&
    input.userIds.every(isCanonicalUserId) &&
    new Set(input.userIds).size === input.userIds.length
  ) {
    return value as unknown as BlacklistRpcRequest;
  }
  if (
    value.operation === "rename-tag" &&
    hasExactKeys(input, ["tagId", "name"]) &&
    isTrimmedNonEmpty(input.tagId) &&
    typeof input.name === "string"
  ) {
    return value as unknown as BlacklistRpcRequest;
  }
  if (
    value.operation === "delete-tag" &&
    hasExactKeys(input, ["tagId"]) &&
    isTrimmedNonEmpty(input.tagId)
  ) {
    return value as unknown as BlacklistRpcRequest;
  }
  return null;
}

function hasValidResponseShape(
  operation: BlacklistRpcOperation,
  ok: boolean,
  data: BlacklistRpcData,
  error: BlacklistRpcError | null,
): boolean {
  if (operation === "status") {
    return ok && error === null && data.status !== null && data.count !== null &&
      data.snapshot === null && data.removed === null &&
      (data.status !== "unsupported" || data.count === 0);
  }
  if (data.status !== null || data.count !== null) {
    return false;
  }
  if (operation === "snapshot") {
    return data.removed === null && (ok
      ? error === null && data.snapshot !== null
      : error === "storage-unreadable" && data.snapshot === null);
  }
  if (ok) {
    return error === null && data.snapshot !== null &&
      (operation === "remove-one" ? data.removed !== null : data.removed === null);
  }
  return data.removed === null && error !== null &&
    (data.snapshot !== null || error === "storage-unreadable");
}

export function parseBlacklistRpcResponse(
  value: unknown,
  expectedOperation: BlacklistRpcOperation,
): BlacklistRpcResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "type", "operation", "ok", "data", "error"]) ||
    value.version !== BLACKLIST_RPC_VERSION ||
    value.type !== BLACKLIST_RPC_RESPONSE_TYPE ||
    value.operation !== expectedOperation ||
    typeof value.ok !== "boolean" ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ["status", "count", "snapshot", "removed"])
  ) {
    return null;
  }
  const { status, count, snapshot, removed } = value.data;
  if (
    (status !== null && status !== "running" && status !== "unsupported" && status !== "connection-error") ||
    (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0)) ||
    (snapshot !== null && parseSnapshot(snapshot) === null) ||
    (removed !== null && parseAuthor(removed) === null) ||
    (value.error !== null &&
      (typeof value.error !== "string" || !ERRORS.includes(value.error as BlacklistRpcError)))
  ) {
    return null;
  }
  const data = value.data as unknown as BlacklistRpcData;
  const error = value.error as BlacklistRpcError | null;
  return hasValidResponseShape(expectedOperation, value.ok, data, error)
    ? value as unknown as BlacklistRpcResponse
    : null;
}

export function createBlacklistRpcRequest(
  operation: BlacklistRpcOperation,
  input: BlacklistRpcRequest["input"],
): BlacklistRpcRequest {
  return {
    version: BLACKLIST_RPC_VERSION,
    type: BLACKLIST_RPC_REQUEST_TYPE,
    operation,
    input,
  } as BlacklistRpcRequest;
}

export function createBlacklistRpcResponse(
  operation: BlacklistRpcOperation,
  ok: boolean,
  data: Partial<BlacklistRpcData> = {},
  error: BlacklistRpcError | null = null,
): BlacklistRpcResponse {
  return {
    version: BLACKLIST_RPC_VERSION,
    type: BLACKLIST_RPC_RESPONSE_TYPE,
    operation,
    ok,
    data: {
      status: data.status ?? null,
      count: data.count ?? null,
      snapshot: data.snapshot ?? null,
      removed: data.removed ?? null,
    },
    error,
  };
}
