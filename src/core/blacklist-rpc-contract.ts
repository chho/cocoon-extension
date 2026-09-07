import {
  contractJsonByteLength,
  hasExactContractKeys,
  isContractRecord,
  isNonNegativeSafeInteger,
  valueOrNull,
} from "./blacklist-contract-validation.ts";
import {
  isBlacklistTagId,
  isBoundedBlacklistTagName,
  parseBlacklistAuthorDto,
  parseBlacklistAuthorIdentityDto,
  parseBlacklistTagDto,
  scopedBlacklistIdentifierKey,
  type BlacklistAuthorDto,
  type BlacklistAuthorIdentityDto,
  type BlacklistTagDto,
} from "./blacklist-rpc-values.ts";

export const BLACKLIST_RPC_VERSION = 2 as const;
export const BLACKLIST_RPC_REQUEST_TYPE = "cocoon.blacklist.request" as const;
export const BLACKLIST_RPC_RESPONSE_TYPE = "cocoon.blacklist.response" as const;
export const MAX_BLACKLIST_MANAGEMENT_RPC_BYTES = 256 * 1024;
export const MAX_BLACKLIST_MUTATION_IDENTITIES = 500;

export type BlacklistRpcOperation =
  "status" | "remove-one" | "restore-one" | "remove-many" | "rename-tag" | "delete-tag";

export type { BlacklistAuthorDto, BlacklistAuthorIdentityDto, BlacklistTagDto };
export { parseBlacklistAuthorDto, parseBlacklistTagDto };

export type CurrentPageStatus = "running" | "unsupported" | "connection-error";

interface RpcRequest<Operation extends BlacklistRpcOperation, Input> {
  readonly version: typeof BLACKLIST_RPC_VERSION;
  readonly type: typeof BLACKLIST_RPC_REQUEST_TYPE;
  readonly operation: Operation;
  readonly input: Input;
}

export type BlacklistRpcRequest =
  | RpcRequest<"status", Record<never, never>>
  | RpcRequest<"remove-one", { readonly identity: BlacklistAuthorIdentityDto }>
  | RpcRequest<"restore-one", { readonly author: BlacklistAuthorDto }>
  | RpcRequest<"remove-many", { readonly identities: readonly BlacklistAuthorIdentityDto[] }>
  | RpcRequest<"rename-tag", { readonly tagId: string; readonly name: string }>
  | RpcRequest<"delete-tag", { readonly tagId: string }>;

export type BlacklistRpcError =
  "storage-unreadable" | "save-failed" | "conflict" | "not-found" | "invalid-tag";

export interface BlacklistRpcData {
  readonly status: CurrentPageStatus | null;
  readonly count: number | null;
  readonly removed: BlacklistAuthorDto | null;
  readonly revision: number | null;
  readonly authorCount: number | null;
  readonly tagCount: number | null;
  readonly removedCount: number | null;
  readonly tag: BlacklistTagDto | null;
  readonly deletedTagId: string | null;
  readonly migratedCount: number | null;
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
  "remove-one",
  "restore-one",
  "remove-many",
  "rename-tag",
  "delete-tag",
];
const MANAGEMENT_MUTATION_OPERATIONS: readonly BlacklistRpcOperation[] = [
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
const COMMON_MUTATION_ERRORS: readonly BlacklistRpcError[] = ["storage-unreadable", "save-failed"];
const OPERATION_MUTATION_ERRORS: Record<
  Exclude<BlacklistRpcOperation, "status">,
  readonly BlacklistRpcError[]
> = {
  "remove-one": ["not-found"],
  "restore-one": ["conflict", "invalid-tag"],
  "remove-many": ["not-found"],
  "rename-tag": ["invalid-tag"],
  "delete-tag": ["invalid-tag"],
};

const RPC_DATA_KEYS = [
  "status",
  "count",
  "removed",
  "revision",
  "authorCount",
  "tagCount",
  "removedCount",
  "tag",
  "deletedTagId",
  "migratedCount",
] as const;

type RequestInputParser = (value: unknown) => BlacklistRpcRequest["input"] | null;
type MutationOperation = Exclude<BlacklistRpcOperation, "status">;
type MutationSuccessValidator = (data: BlacklistRpcData) => boolean;

export function blacklistRpcJsonByteLength(value: unknown): number | null {
  return contractJsonByteLength(value);
}

export function isWithinBlacklistManagementRpcLimit(value: unknown): boolean {
  const size = blacklistRpcJsonByteLength(value);
  return size !== null && size <= MAX_BLACKLIST_MANAGEMENT_RPC_BYTES;
}

function isOperation(value: unknown): value is BlacklistRpcOperation {
  return typeof value === "string" && OPERATIONS.includes(value as BlacklistRpcOperation);
}

function parseEmptyInput(value: unknown): Record<never, never> | null {
  if (!isContractRecord(value)) return null;
  return hasExactContractKeys(value, []) ? (value as Record<never, never>) : null;
}

function parseRemoveOneInput(value: unknown): BlacklistRpcRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["identity"])) return null;
  return parseBlacklistAuthorIdentityDto(value.identity)
    ? (value as unknown as BlacklistRpcRequest["input"])
    : null;
}

function parseRestoreOneInput(value: unknown): BlacklistRpcRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["author"])) return null;
  return parseBlacklistAuthorDto(value.author)
    ? (value as unknown as BlacklistRpcRequest["input"])
    : null;
}

function parseMutationIdentities(value: unknown): readonly BlacklistAuthorIdentityDto[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > MAX_BLACKLIST_MUTATION_IDENTITIES) return null;
  const identities = value.map(parseBlacklistAuthorIdentityDto);
  if (identities.some((identity) => identity === null)) return null;
  const parsed = identities as BlacklistAuthorIdentityDto[];
  const keys = parsed.map(({ platformId, userId }) =>
    scopedBlacklistIdentifierKey(platformId, userId),
  );
  return new Set(keys).size === keys.length ? parsed : null;
}

function parseRemoveManyInput(value: unknown): BlacklistRpcRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["identities"])) return null;
  return parseMutationIdentities(value.identities)
    ? (value as unknown as BlacklistRpcRequest["input"])
    : null;
}

function parseRenameTagInput(value: unknown): BlacklistRpcRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["tagId", "name"])) return null;
  if (!isBlacklistTagId(value.tagId)) return null;
  return isBoundedBlacklistTagName(value.name)
    ? (value as unknown as BlacklistRpcRequest["input"])
    : null;
}

function parseDeleteTagInput(value: unknown): BlacklistRpcRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["tagId"])) return null;
  return isBlacklistTagId(value.tagId) ? (value as unknown as BlacklistRpcRequest["input"]) : null;
}

const REQUEST_INPUT_PARSERS: Record<BlacklistRpcOperation, RequestInputParser> = {
  status: parseEmptyInput,
  "remove-one": parseRemoveOneInput,
  "restore-one": parseRestoreOneInput,
  "remove-many": parseRemoveManyInput,
  "rename-tag": parseRenameTagInput,
  "delete-tag": parseDeleteTagInput,
};

function parseRequestRecord(value: unknown): Record<string, unknown> | null {
  if (!isWithinBlacklistManagementRpcLimit(value)) return null;
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["version", "type", "operation", "input"])) return null;
  if (value.version !== BLACKLIST_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_RPC_REQUEST_TYPE) return null;
  return isOperation(value.operation) ? value : null;
}

export function parseBlacklistRpcRequest(value: unknown): BlacklistRpcRequest | null {
  const request = parseRequestRecord(value);
  if (!request) return null;
  const operation = request.operation as BlacklistRpcOperation;
  return REQUEST_INPUT_PARSERS[operation](request.input)
    ? (request as unknown as BlacklistRpcRequest)
    : null;
}

export function isBlacklistManagementMutationOperation(
  operation: BlacklistRpcOperation,
): operation is MutationOperation {
  return MANAGEMENT_MUTATION_OPERATIONS.includes(operation);
}

function hasNoMutationDelta(data: BlacklistRpcData): boolean {
  return [
    data.revision,
    data.authorCount,
    data.tagCount,
    data.removedCount,
    data.tag,
    data.deletedTagId,
    data.migratedCount,
  ].every((value) => value === null);
}

function hasMutationSummary(data: BlacklistRpcData): boolean {
  return data.revision !== null && data.authorCount !== null && data.tagCount !== null;
}

function hasNoValues(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function isRemoveOneSuccess(data: BlacklistRpcData): boolean {
  return (
    data.removed !== null &&
    hasNoValues([data.removedCount, data.tag, data.deletedTagId, data.migratedCount])
  );
}

function isRestoreOneSuccess(data: BlacklistRpcData): boolean {
  return (
    data.removed === null &&
    hasNoValues([data.removedCount, data.tag, data.deletedTagId, data.migratedCount])
  );
}

function isRemoveManySuccess(data: BlacklistRpcData): boolean {
  return (
    data.removed === null &&
    data.removedCount !== null &&
    hasNoValues([data.tag, data.deletedTagId, data.migratedCount])
  );
}

function isRenameTagSuccess(data: BlacklistRpcData): boolean {
  return (
    data.removed === null &&
    data.tag !== null &&
    hasNoValues([data.removedCount, data.deletedTagId, data.migratedCount])
  );
}

function isDeleteTagSuccess(data: BlacklistRpcData): boolean {
  return (
    data.removed === null &&
    data.deletedTagId !== null &&
    data.migratedCount !== null &&
    hasNoValues([data.removedCount, data.tag])
  );
}

const MUTATION_SUCCESS_VALIDATORS: Record<MutationOperation, MutationSuccessValidator> = {
  "remove-one": isRemoveOneSuccess,
  "restore-one": isRestoreOneSuccess,
  "remove-many": isRemoveManySuccess,
  "rename-tag": isRenameTagSuccess,
  "delete-tag": isDeleteTagSuccess,
};

function isMutationError(operation: MutationOperation, error: BlacklistRpcError | null): boolean {
  if (error === null) return false;
  if (COMMON_MUTATION_ERRORS.includes(error)) return true;
  return OPERATION_MUTATION_ERRORS[operation].includes(error);
}

function hasValidMutationShape(
  operation: MutationOperation,
  ok: boolean,
  data: BlacklistRpcData,
  error: BlacklistRpcError | null,
): boolean {
  if (data.status !== null || data.count !== null) return false;
  if (!ok) {
    return data.removed === null && hasNoMutationDelta(data) && isMutationError(operation, error);
  }
  if (error !== null) return false;
  if (!hasMutationSummary(data)) return false;
  return MUTATION_SUCCESS_VALIDATORS[operation](data);
}

function hasValidStatusShape(
  ok: boolean,
  data: BlacklistRpcData,
  error: BlacklistRpcError | null,
): boolean {
  if (!ok || error !== null) return false;
  if (data.status === null || data.count === null) return false;
  if (data.removed !== null || !hasNoMutationDelta(data)) return false;
  return data.status !== "unsupported" || data.count === 0;
}

function isCurrentPageStatus(value: unknown): value is CurrentPageStatus | null {
  return (
    value === null || value === "running" || value === "unsupported" || value === "connection-error"
  );
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function hasValidDataScalars(value: Record<string, unknown>): boolean {
  if (!isCurrentPageStatus(value.status)) return false;
  const counts = [
    value.count,
    value.revision,
    value.authorCount,
    value.tagCount,
    value.removedCount,
    value.migratedCount,
  ];
  if (!counts.every(isNullableCount)) return false;
  return (
    value.removedCount === null ||
    (value.removedCount as number) <= MAX_BLACKLIST_MUTATION_IDENTITIES
  );
}

function hasValidDataObjects(value: Record<string, unknown>): boolean {
  if (value.removed !== null && parseBlacklistAuthorDto(value.removed) === null) return false;
  if (value.tag !== null && parseBlacklistTagDto(value.tag) === null) return false;
  return value.deletedTagId === null || isBlacklistTagId(value.deletedTagId);
}

function parseRpcData(value: unknown): BlacklistRpcData | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, RPC_DATA_KEYS)) return null;
  if (!hasValidDataScalars(value)) return null;
  if (!hasValidDataObjects(value)) return null;
  return value as unknown as BlacklistRpcData;
}

function isRpcError(value: unknown): value is BlacklistRpcError | null {
  return (
    value === null || (typeof value === "string" && ERRORS.includes(value as BlacklistRpcError))
  );
}

function parseResponseRecord(
  value: unknown,
  expectedOperation: BlacklistRpcOperation,
): Record<string, unknown> | null {
  if (!isWithinBlacklistManagementRpcLimit(value)) return null;
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["version", "type", "operation", "ok", "data", "error"])) {
    return null;
  }
  if (value.version !== BLACKLIST_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_RPC_RESPONSE_TYPE) return null;
  if (value.operation !== expectedOperation) return null;
  if (typeof value.ok !== "boolean") return null;
  return value;
}

export function parseBlacklistRpcResponse(
  value: unknown,
  expectedOperation: BlacklistRpcOperation,
): BlacklistRpcResponse | null {
  const response = parseResponseRecord(value, expectedOperation);
  if (!response) return null;
  const data = parseRpcData(response.data);
  if (!data || !isRpcError(response.error)) return null;
  const valid = isBlacklistManagementMutationOperation(expectedOperation)
    ? hasValidMutationShape(expectedOperation, response.ok as boolean, data, response.error)
    : hasValidStatusShape(response.ok as boolean, data, response.error);
  return valid ? (response as unknown as BlacklistRpcResponse) : null;
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
      status: valueOrNull(data.status),
      count: valueOrNull(data.count),
      removed: valueOrNull(data.removed),
      revision: valueOrNull(data.revision),
      authorCount: valueOrNull(data.authorCount),
      tagCount: valueOrNull(data.tagCount),
      removedCount: valueOrNull(data.removedCount),
      tag: valueOrNull(data.tag),
      deletedTagId: valueOrNull(data.deletedTagId),
      migratedCount: valueOrNull(data.migratedCount),
    },
    error,
  };
}
