import {
  contractCodePointLength as codePointLength,
  contractJsonByteLength,
  contractTextByteLength,
  hasExactContractKeys,
  isContractRecord,
  isNonNegativeSafeInteger,
} from "./blacklist-contract-validation.ts";
import {
  parseBlacklistAuthorDto,
  parseBlacklistTagDto,
  type BlacklistAuthorDto,
  type BlacklistTagDto,
} from "./blacklist-rpc-contract.ts";

export const BLACKLIST_QUERY_RPC_VERSION = 1 as const;
export const BLACKLIST_QUERY_REQUEST_TYPE = "cocoon.blacklist.query.request" as const;
export const BLACKLIST_QUERY_RESPONSE_TYPE = "cocoon.blacklist.query.response" as const;
export const BLACKLIST_QUERY_PAGE_SIZE = 50;
export const BLACKLIST_TAG_PAGE_SIZE = 100;
export const BLACKLIST_PLATFORM_PAGE_SIZE = 100;
export const BLACKLIST_IDENTITY_BATCH_SIZE = 200;
export const MAX_BLACKLIST_QUERY_RPC_BYTES = 256 * 1024;
export const MAX_BLACKLIST_QUERY_CODE_POINTS = 100;
export const MAX_BLACKLIST_QUERY_CURSOR_BYTES = 2_048;

const MAX_STABLE_ID_CODE_POINTS = 512;
const PLATFORM_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export type BlacklistQueryOperation =
  "summary" | "authors-page" | "tags-page" | "platforms-page" | "identity-match";

export type BlacklistTimeDirection = "asc" | "desc";
export type BlacklistSearchScope = "author" | "author-or-tag";

export interface BlacklistSummaryDto {
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

export interface BlacklistAuthorListItemDto {
  readonly author: BlacklistAuthorDto;
  readonly tag: BlacklistTagDto;
}

export interface BlacklistTagUsageDto extends BlacklistTagDto {
  readonly authorCount: number;
}

export interface BlacklistIdentityQueryDto {
  readonly platformId: string;
  readonly identifier: string;
}

interface QueryRequest<Operation extends BlacklistQueryOperation, Input> {
  readonly version: typeof BLACKLIST_QUERY_RPC_VERSION;
  readonly type: typeof BLACKLIST_QUERY_REQUEST_TYPE;
  readonly operation: Operation;
  readonly input: Input;
}

interface RevisionPageInput {
  readonly revision: number | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export type BlacklistQueryRequest =
  | QueryRequest<"summary", Record<string, never>>
  | QueryRequest<
      "authors-page",
      RevisionPageInput & {
        readonly search: string;
        readonly searchScope: BlacklistSearchScope;
        readonly tagId: string | null;
        readonly platformId: string | null;
        readonly direction: BlacklistTimeDirection;
      }
    >
  | QueryRequest<"tags-page", RevisionPageInput>
  | QueryRequest<"platforms-page", RevisionPageInput>
  | QueryRequest<
      "identity-match",
      {
        readonly revision: number | null;
        readonly identities: readonly BlacklistIdentityQueryDto[];
      }
    >;

export type BlacklistQueryError = "storage-unreadable" | "stale-cursor" | "invalid-query";

interface QueryResponse<Operation extends BlacklistQueryOperation, Data> {
  readonly version: typeof BLACKLIST_QUERY_RPC_VERSION;
  readonly type: typeof BLACKLIST_QUERY_RESPONSE_TYPE;
  readonly operation: Operation;
  readonly ok: boolean;
  readonly data: Data | null;
  readonly error: BlacklistQueryError | null;
}

export type BlacklistQueryResponse =
  | QueryResponse<"summary", BlacklistSummaryDto>
  | QueryResponse<
      "authors-page",
      BlacklistSummaryDto & {
        readonly items: readonly BlacklistAuthorListItemDto[];
        readonly nextCursor: string | null;
        readonly totalCount: number;
      }
    >
  | QueryResponse<
      "tags-page",
      BlacklistSummaryDto & {
        readonly tags: readonly BlacklistTagUsageDto[];
        readonly nextCursor: string | null;
      }
    >
  | QueryResponse<
      "platforms-page",
      BlacklistSummaryDto & {
        readonly platforms: readonly string[];
        readonly nextCursor: string | null;
      }
    >
  | QueryResponse<
      "identity-match",
      {
        readonly revision: number;
        readonly matches: readonly BlacklistIdentityQueryDto[];
      }
    >;

const OPERATIONS: readonly BlacklistQueryOperation[] = [
  "summary",
  "authors-page",
  "tags-page",
  "platforms-page",
  "identity-match",
];
const ERRORS: readonly BlacklistQueryError[] = [
  "storage-unreadable",
  "stale-cursor",
  "invalid-query",
];

type QueryInputParser = (value: unknown) => BlacklistQueryRequest["input"] | null;
type QueryDataParser = (value: unknown) => BlacklistQueryResponse["data"] | null;

function isOperation(value: unknown): value is BlacklistQueryOperation {
  return typeof value === "string" && OPERATIONS.includes(value as BlacklistQueryOperation);
}

function isRevision(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function isCursor(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length === 0) return false;
  return contractTextByteLength(value) <= MAX_BLACKLIST_QUERY_CURSOR_BYTES;
}

function isStableId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value !== value.trim()) return false;
  return codePointLength(value) <= MAX_STABLE_ID_CODE_POINTS;
}

function isPlatform(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.length <= 64 && PLATFORM_ID_PATTERN.test(value);
}

function isIdentity(value: unknown): value is BlacklistIdentityQueryDto {
  if (!isContractRecord(value)) return false;
  if (!hasExactContractKeys(value, ["platformId", "identifier"])) return false;
  return isPlatform(value.platformId) && isStableId(value.identifier);
}

function hasUniqueIdentities(values: readonly BlacklistIdentityQueryDto[]): boolean {
  const keys = values.map(({ platformId, identifier }) => JSON.stringify([platformId, identifier]));
  return new Set(keys).size === keys.length;
}

function isWithinRpcLimit(value: unknown): boolean {
  const size = contractJsonByteLength(value);
  return size !== null && size <= MAX_BLACKLIST_QUERY_RPC_BYTES;
}

function hasValidRevisionPageFields(value: Record<string, unknown>, maximum: number): boolean {
  if (!isRevision(value.revision)) return false;
  if (!isCursor(value.cursor)) return false;
  if (value.cursor !== null && value.revision === null) return false;
  if (!Number.isSafeInteger(value.limit)) return false;
  if ((value.limit as number) < 1) return false;
  return (value.limit as number) <= maximum;
}

function parseSummaryInput(value: unknown): Record<string, never> | null {
  if (!isContractRecord(value)) return null;
  return hasExactContractKeys(value, []) ? (value as Record<string, never>) : null;
}

function parseRevisionPageInput(
  value: unknown,
  maximum: number,
): BlacklistQueryRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["revision", "cursor", "limit"])) return null;
  return hasValidRevisionPageFields(value, maximum)
    ? (value as unknown as BlacklistQueryRequest["input"])
    : null;
}

function parseTagsPageInput(value: unknown): BlacklistQueryRequest["input"] | null {
  return parseRevisionPageInput(value, BLACKLIST_TAG_PAGE_SIZE);
}

function parsePlatformsPageInput(value: unknown): BlacklistQueryRequest["input"] | null {
  return parseRevisionPageInput(value, BLACKLIST_PLATFORM_PAGE_SIZE);
}

function hasValidSearch(value: Record<string, unknown>): boolean {
  if (typeof value.search !== "string") return false;
  if (value.search !== value.search.trim()) return false;
  if (codePointLength(value.search) > MAX_BLACKLIST_QUERY_CODE_POINTS) return false;
  return value.searchScope === "author" || value.searchScope === "author-or-tag";
}

function hasValidAuthorFilters(value: Record<string, unknown>): boolean {
  if (!hasValidSearch(value)) return false;
  if (value.tagId !== null && !isStableId(value.tagId)) return false;
  if (value.platformId !== null && !isPlatform(value.platformId)) return false;
  return value.direction === "asc" || value.direction === "desc";
}

function parseAuthorsPageInput(value: unknown): BlacklistQueryRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (
    !hasExactContractKeys(value, [
      "revision",
      "cursor",
      "limit",
      "search",
      "searchScope",
      "tagId",
      "platformId",
      "direction",
    ])
  ) {
    return null;
  }
  if (!hasValidRevisionPageFields(value, BLACKLIST_QUERY_PAGE_SIZE)) return null;
  return hasValidAuthorFilters(value) ? (value as unknown as BlacklistQueryRequest["input"]) : null;
}

function parseIdentityMatchInput(value: unknown): BlacklistQueryRequest["input"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["revision", "identities"])) return null;
  if (!isRevision(value.revision)) return null;
  if (!Array.isArray(value.identities)) return null;
  if (value.identities.length < 1 || value.identities.length > BLACKLIST_IDENTITY_BATCH_SIZE) {
    return null;
  }
  if (!value.identities.every(isIdentity)) return null;
  return hasUniqueIdentities(value.identities)
    ? (value as unknown as BlacklistQueryRequest["input"])
    : null;
}

const REQUEST_INPUT_PARSERS: Record<BlacklistQueryOperation, QueryInputParser> = {
  summary: parseSummaryInput,
  "authors-page": parseAuthorsPageInput,
  "tags-page": parseTagsPageInput,
  "platforms-page": parsePlatformsPageInput,
  "identity-match": parseIdentityMatchInput,
};

function parseRequestRecord(value: unknown): Record<string, unknown> | null {
  if (!isWithinRpcLimit(value)) return null;
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["version", "type", "operation", "input"])) return null;
  if (value.version !== BLACKLIST_QUERY_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_QUERY_REQUEST_TYPE) return null;
  return isOperation(value.operation) ? value : null;
}

export function parseBlacklistQueryRequest(value: unknown): BlacklistQueryRequest | null {
  const request = parseRequestRecord(value);
  if (!request) return null;
  const operation = request.operation as BlacklistQueryOperation;
  return REQUEST_INPUT_PARSERS[operation](request.input)
    ? (request as unknown as BlacklistQueryRequest)
    : null;
}

function parseSummary(value: unknown): BlacklistSummaryDto | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["revision", "authorCount", "tagCount"])) return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!isNonNegativeSafeInteger(value.authorCount)) return null;
  if (!isNonNegativeSafeInteger(value.tagCount) || value.tagCount < 1) return null;
  return value as unknown as BlacklistSummaryDto;
}

function parseListItem(value: unknown): BlacklistAuthorListItemDto | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["author", "tag"])) return null;
  const author = parseBlacklistAuthorDto(value.author);
  const tag = parseBlacklistTagDto(value.tag);
  if (!author || !tag) return null;
  return author.tagId === tag.tagId ? { author, tag } : null;
}

function parseTagUsage(value: unknown): BlacklistTagUsageDto | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["tagId", "name", "isDefault", "authorCount"])) return null;
  if (!isNonNegativeSafeInteger(value.authorCount)) return null;
  const tag = parseBlacklistTagDto({
    tagId: value.tagId,
    name: value.name,
    isDefault: value.isDefault,
  });
  return tag ? { ...tag, authorCount: value.authorCount } : null;
}

function parsePagedSummary(value: Record<string, unknown>): BlacklistSummaryDto | null {
  return parseSummary({
    revision: value.revision,
    authorCount: value.authorCount,
    tagCount: value.tagCount,
  });
}

function hasValidPageEnvelope(value: Record<string, unknown>): boolean {
  return parsePagedSummary(value) !== null && isCursor(value.nextCursor);
}

function parseIdentityMatchData(value: unknown): BlacklistQueryResponse["data"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["revision", "matches"])) return null;
  if (!isNonNegativeSafeInteger(value.revision)) return null;
  if (!Array.isArray(value.matches)) return null;
  if (value.matches.length > BLACKLIST_IDENTITY_BATCH_SIZE) return null;
  if (!value.matches.every(isIdentity)) return null;
  return hasUniqueIdentities(value.matches)
    ? (value as unknown as BlacklistQueryResponse["data"])
    : null;
}

function parseAuthorsPageData(value: unknown): BlacklistQueryResponse["data"] | null {
  if (!isContractRecord(value)) return null;
  if (
    !hasExactContractKeys(value, [
      "revision",
      "authorCount",
      "tagCount",
      "items",
      "nextCursor",
      "totalCount",
    ])
  ) {
    return null;
  }
  if (!hasValidPageEnvelope(value)) return null;
  if (!Array.isArray(value.items) || value.items.length > BLACKLIST_QUERY_PAGE_SIZE) return null;
  if (!value.items.every((item) => parseListItem(item) !== null)) return null;
  if (!isNonNegativeSafeInteger(value.totalCount)) return null;
  return value as unknown as BlacklistQueryResponse["data"];
}

function parseTagsPageData(value: unknown): BlacklistQueryResponse["data"] | null {
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["revision", "authorCount", "tagCount", "tags", "nextCursor"])) {
    return null;
  }
  if (!hasValidPageEnvelope(value)) return null;
  if (!Array.isArray(value.tags) || value.tags.length > BLACKLIST_TAG_PAGE_SIZE) return null;
  if (!value.tags.every((tag) => parseTagUsage(tag) !== null)) return null;
  return value as unknown as BlacklistQueryResponse["data"];
}

function parsePlatformsPageData(value: unknown): BlacklistQueryResponse["data"] | null {
  if (!isContractRecord(value)) return null;
  if (
    !hasExactContractKeys(value, ["revision", "authorCount", "tagCount", "platforms", "nextCursor"])
  ) {
    return null;
  }
  if (!hasValidPageEnvelope(value)) return null;
  if (!Array.isArray(value.platforms)) return null;
  if (value.platforms.length > BLACKLIST_PLATFORM_PAGE_SIZE) return null;
  if (!value.platforms.every(isPlatform)) return null;
  if (new Set(value.platforms).size !== value.platforms.length) return null;
  return value as unknown as BlacklistQueryResponse["data"];
}

const SUCCESS_DATA_PARSERS: Record<BlacklistQueryOperation, QueryDataParser> = {
  summary: parseSummary,
  "authors-page": parseAuthorsPageData,
  "tags-page": parseTagsPageData,
  "platforms-page": parsePlatformsPageData,
  "identity-match": parseIdentityMatchData,
};

function parseResponseRecord(
  value: unknown,
  expectedOperation: BlacklistQueryOperation,
): Record<string, unknown> | null {
  if (!isWithinRpcLimit(value)) return null;
  if (!isContractRecord(value)) return null;
  if (!hasExactContractKeys(value, ["version", "type", "operation", "ok", "data", "error"])) {
    return null;
  }
  if (value.version !== BLACKLIST_QUERY_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_QUERY_RESPONSE_TYPE) return null;
  if (value.operation !== expectedOperation) return null;
  return typeof value.ok === "boolean" ? value : null;
}

function isQueryError(value: unknown): value is BlacklistQueryError {
  return typeof value === "string" && ERRORS.includes(value as BlacklistQueryError);
}

export function parseBlacklistQueryResponse(
  value: unknown,
  expectedOperation: BlacklistQueryOperation,
): BlacklistQueryResponse | null {
  const response = parseResponseRecord(value, expectedOperation);
  if (!response) return null;
  if (response.ok) {
    const data = SUCCESS_DATA_PARSERS[expectedOperation](response.data);
    return response.error === null && data ? (response as unknown as BlacklistQueryResponse) : null;
  }
  return response.data === null && isQueryError(response.error)
    ? (response as unknown as BlacklistQueryResponse)
    : null;
}

export function createBlacklistQueryRequest<Operation extends BlacklistQueryRequest["operation"]>(
  operation: Operation,
  input: Extract<BlacklistQueryRequest, { operation: Operation }>["input"],
): Extract<BlacklistQueryRequest, { operation: Operation }> {
  return {
    version: BLACKLIST_QUERY_RPC_VERSION,
    type: BLACKLIST_QUERY_REQUEST_TYPE,
    operation,
    input,
  } as Extract<BlacklistQueryRequest, { operation: Operation }>;
}

export function createBlacklistQueryResponse<Operation extends BlacklistQueryResponse["operation"]>(
  operation: Operation,
  ok: boolean,
  data: Extract<BlacklistQueryResponse, { operation: Operation }>["data"] = null,
  error: BlacklistQueryError | null = null,
): Extract<BlacklistQueryResponse, { operation: Operation }> {
  return {
    version: BLACKLIST_QUERY_RPC_VERSION,
    type: BLACKLIST_QUERY_RESPONSE_TYPE,
    operation,
    ok,
    data,
    error,
  } as Extract<BlacklistQueryResponse, { operation: Operation }>;
}
