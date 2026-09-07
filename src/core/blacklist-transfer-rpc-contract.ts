import { isNonNegativeSafeInteger } from "./blacklist-contract-validation.ts";
import {
  parseBlacklistExportAuthorsPage,
  parseBlacklistExportBegin,
  parseBlacklistExportPageInput,
  parseBlacklistExportTagsPage,
  parseBlacklistImportAuthorsChunkInput,
  parseBlacklistImportSessionDto,
  parseBlacklistImportTagsChunkInput,
  parseBlacklistTransferFileMetadata,
  parseBlacklistTransferSummary,
  isBlacklistTransferSessionId,
  type BlacklistExportAuthorsPageDto,
  type BlacklistExportBeginDto,
  type BlacklistExportPageInput,
  type BlacklistExportTagsPageDto,
  type BlacklistImportAuthorsChunkInput,
  type BlacklistImportSessionDto,
  type BlacklistImportStatus,
  type BlacklistImportTagsChunkInput,
  type BlacklistTransferProgressDto,
  type BlacklistTransferSummaryDto,
} from "./blacklist-transfer-rpc-values.ts";
import {
  BLACKLIST_TRANSFER_RPC_BYTES,
  blacklistTransferJsonBytes,
  hasExactBlacklistTransferKeys,
  isBlacklistTransferRecord,
  type BlacklistTransferFileMetadataDto,
} from "./blacklist-transfer-values.ts";

export const BLACKLIST_TRANSFER_RPC_VERSION = 1 as const;
export const BLACKLIST_TRANSFER_REQUEST_TYPE = "cocoon.blacklist.transfer.request" as const;
export const BLACKLIST_TRANSFER_RESPONSE_TYPE = "cocoon.blacklist.transfer.response" as const;

export type BlacklistTransferOperation =
  | "import-begin"
  | "import-authors-chunk"
  | "import-tags-chunk"
  | "import-inspect"
  | "import-finalize"
  | "import-abort"
  | "export-begin"
  | "export-authors-page"
  | "export-tags-page"
  | "export-finish";

export type BlacklistImportMode = "merge" | "replace";

export type {
  BlacklistExportAuthorsPageDto,
  BlacklistExportBeginDto,
  BlacklistExportPageInput,
  BlacklistExportTagsPageDto,
  BlacklistImportAuthorsChunkInput,
  BlacklistImportSessionDto,
  BlacklistImportStatus,
  BlacklistImportTagsChunkInput,
  BlacklistTransferProgressDto,
  BlacklistTransferSummaryDto,
};

export {
  parseBlacklistImportAuthorsChunkInput,
  parseBlacklistImportSessionDto,
  parseBlacklistImportTagsChunkInput,
  parseBlacklistTransferFileMetadata,
};

interface TransferRequest<Operation extends BlacklistTransferOperation, Input> {
  readonly version: typeof BLACKLIST_TRANSFER_RPC_VERSION;
  readonly type: typeof BLACKLIST_TRANSFER_REQUEST_TYPE;
  readonly operation: Operation;
  readonly input: Input;
}

export type BlacklistTransferRequest =
  | TransferRequest<"import-begin", { readonly metadata: BlacklistTransferFileMetadataDto }>
  | TransferRequest<"import-authors-chunk", BlacklistImportAuthorsChunkInput>
  | TransferRequest<"import-tags-chunk", BlacklistImportTagsChunkInput>
  | TransferRequest<"import-inspect", { readonly sessionId: string }>
  | TransferRequest<
      "import-finalize",
      { readonly sessionId: string; readonly mode: BlacklistImportMode }
    >
  | TransferRequest<"import-abort", { readonly sessionId: string }>
  | TransferRequest<"export-begin", Record<string, never>>
  | TransferRequest<"export-authors-page", BlacklistExportPageInput>
  | TransferRequest<"export-tags-page", BlacklistExportPageInput>
  | TransferRequest<"export-finish", { readonly revision: number }>;

export type BlacklistTransferError =
  | "storage-unreadable"
  | "save-failed"
  | "session-not-found"
  | "session-expired"
  | "chunk-conflict"
  | "incomplete-import"
  | "transfer-conflict"
  | "stale-export";

export interface BlacklistImportChunkResultDto {
  readonly status: "staged" | "duplicate";
  readonly session: BlacklistImportSessionDto;
}

type TransferResponse<Operation extends BlacklistTransferOperation, Data> = {
  readonly version: typeof BLACKLIST_TRANSFER_RPC_VERSION;
  readonly type: typeof BLACKLIST_TRANSFER_RESPONSE_TYPE;
  readonly operation: Operation;
  readonly ok: boolean;
  readonly data: Data | null;
  readonly error: BlacklistTransferError | null;
};

export type BlacklistTransferResponse =
  | TransferResponse<"import-begin", BlacklistImportSessionDto>
  | TransferResponse<"import-authors-chunk", BlacklistImportChunkResultDto>
  | TransferResponse<"import-tags-chunk", BlacklistImportChunkResultDto>
  | TransferResponse<"import-inspect", BlacklistImportSessionDto>
  | TransferResponse<"import-finalize", BlacklistTransferSummaryDto>
  | TransferResponse<"import-abort", { readonly sessionId: string }>
  | TransferResponse<"export-begin", BlacklistExportBeginDto>
  | TransferResponse<"export-authors-page", BlacklistExportAuthorsPageDto>
  | TransferResponse<"export-tags-page", BlacklistExportTagsPageDto>
  | TransferResponse<"export-finish", { readonly revision: number }>;

const OPERATIONS: readonly BlacklistTransferOperation[] = [
  "import-begin",
  "import-authors-chunk",
  "import-tags-chunk",
  "import-inspect",
  "import-finalize",
  "import-abort",
  "export-begin",
  "export-authors-page",
  "export-tags-page",
  "export-finish",
];
const ERRORS: readonly BlacklistTransferError[] = [
  "storage-unreadable",
  "save-failed",
  "session-not-found",
  "session-expired",
  "chunk-conflict",
  "incomplete-import",
  "transfer-conflict",
  "stale-export",
];

type TransferInputParser = (value: unknown) => BlacklistTransferRequest["input"] | null;
type TransferDataParser = (value: unknown) => BlacklistTransferResponse["data"] | null;

function isOperation(value: unknown): value is BlacklistTransferOperation {
  return typeof value === "string" && OPERATIONS.includes(value as BlacklistTransferOperation);
}

function isWithinTransferRpcLimit(value: unknown): boolean {
  const bytes = blacklistTransferJsonBytes(value);
  return bytes !== null && bytes <= BLACKLIST_TRANSFER_RPC_BYTES;
}

function parseImportBeginInput(value: unknown): BlacklistTransferRequest["input"] | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["metadata"])) return null;
  return parseBlacklistTransferFileMetadata(value.metadata)
    ? (value as unknown as BlacklistTransferRequest["input"])
    : null;
}

function parseEmptyInput(value: unknown): Record<string, never> | null {
  if (!isBlacklistTransferRecord(value)) return null;
  return hasExactBlacklistTransferKeys(value, []) ? (value as Record<string, never>) : null;
}

function parseSessionInput(value: unknown): BlacklistTransferRequest["input"] | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["sessionId"])) return null;
  return isBlacklistTransferSessionId(value.sessionId)
    ? (value as unknown as BlacklistTransferRequest["input"])
    : null;
}

function parseFinalizeInput(value: unknown): BlacklistTransferRequest["input"] | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["sessionId", "mode"])) return null;
  if (!isBlacklistTransferSessionId(value.sessionId)) return null;
  if (value.mode !== "merge" && value.mode !== "replace") return null;
  return value as unknown as BlacklistTransferRequest["input"];
}

function parseRevisionInput(value: unknown): BlacklistTransferRequest["input"] | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["revision"])) return null;
  return isNonNegativeSafeInteger(value.revision)
    ? (value as unknown as BlacklistTransferRequest["input"])
    : null;
}

const REQUEST_INPUT_PARSERS: Record<BlacklistTransferOperation, TransferInputParser> = {
  "import-begin": parseImportBeginInput,
  "import-authors-chunk": parseBlacklistImportAuthorsChunkInput,
  "import-tags-chunk": parseBlacklistImportTagsChunkInput,
  "import-inspect": parseSessionInput,
  "import-finalize": parseFinalizeInput,
  "import-abort": parseSessionInput,
  "export-begin": parseEmptyInput,
  "export-authors-page": parseBlacklistExportPageInput,
  "export-tags-page": parseBlacklistExportPageInput,
  "export-finish": parseRevisionInput,
};

function parseRequestRecord(value: unknown): Record<string, unknown> | null {
  if (!isWithinTransferRpcLimit(value)) return null;
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["version", "type", "operation", "input"])) {
    return null;
  }
  if (value.version !== BLACKLIST_TRANSFER_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_TRANSFER_REQUEST_TYPE) return null;
  return isOperation(value.operation) ? value : null;
}

export function parseBlacklistTransferRequest(value: unknown): BlacklistTransferRequest | null {
  const request = parseRequestRecord(value);
  if (!request) return null;
  const operation = request.operation as BlacklistTransferOperation;
  return REQUEST_INPUT_PARSERS[operation](request.input)
    ? (request as unknown as BlacklistTransferRequest)
    : null;
}

function parseChunkResult(value: unknown): BlacklistImportChunkResultDto | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["status", "session"])) return null;
  if (value.status !== "staged" && value.status !== "duplicate") return null;
  return parseBlacklistImportSessionDto(value.session)
    ? (value as unknown as BlacklistImportChunkResultDto)
    : null;
}

function parseSessionResult(value: unknown): BlacklistImportSessionDto | null {
  return parseBlacklistImportSessionDto(value);
}

function parseAbortResult(value: unknown): { readonly sessionId: string } | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["sessionId"])) return null;
  return isBlacklistTransferSessionId(value.sessionId)
    ? (value as { readonly sessionId: string })
    : null;
}

function parseFinishResult(value: unknown): { readonly revision: number } | null {
  if (!isBlacklistTransferRecord(value)) return null;
  if (!hasExactBlacklistTransferKeys(value, ["revision"])) return null;
  return isNonNegativeSafeInteger(value.revision) ? (value as { readonly revision: number }) : null;
}

const SUCCESS_DATA_PARSERS: Record<BlacklistTransferOperation, TransferDataParser> = {
  "import-begin": parseSessionResult,
  "import-authors-chunk": parseChunkResult,
  "import-tags-chunk": parseChunkResult,
  "import-inspect": parseSessionResult,
  "import-finalize": parseBlacklistTransferSummary,
  "import-abort": parseAbortResult,
  "export-begin": parseBlacklistExportBegin,
  "export-authors-page": parseBlacklistExportAuthorsPage,
  "export-tags-page": parseBlacklistExportTagsPage,
  "export-finish": parseFinishResult,
};

function parseResponseRecord(
  value: unknown,
  expectedOperation: BlacklistTransferOperation,
): Record<string, unknown> | null {
  if (!isWithinTransferRpcLimit(value)) return null;
  if (!isBlacklistTransferRecord(value)) return null;
  if (
    !hasExactBlacklistTransferKeys(value, ["version", "type", "operation", "ok", "data", "error"])
  ) {
    return null;
  }
  if (value.version !== BLACKLIST_TRANSFER_RPC_VERSION) return null;
  if (value.type !== BLACKLIST_TRANSFER_RESPONSE_TYPE) return null;
  if (value.operation !== expectedOperation) return null;
  return typeof value.ok === "boolean" ? value : null;
}

function isTransferError(value: unknown): value is BlacklistTransferError {
  return typeof value === "string" && ERRORS.includes(value as BlacklistTransferError);
}

export function parseBlacklistTransferResponse(
  value: unknown,
  expectedOperation: BlacklistTransferOperation,
): BlacklistTransferResponse | null {
  const response = parseResponseRecord(value, expectedOperation);
  if (!response) return null;
  if (response.ok) {
    const data = SUCCESS_DATA_PARSERS[expectedOperation](response.data);
    return response.error === null && data
      ? (response as unknown as BlacklistTransferResponse)
      : null;
  }
  return response.data === null && isTransferError(response.error)
    ? (response as unknown as BlacklistTransferResponse)
    : null;
}

export function createBlacklistTransferRequest<
  Operation extends BlacklistTransferRequest["operation"],
>(
  operation: Operation,
  input: Extract<BlacklistTransferRequest, { operation: Operation }>["input"],
): Extract<BlacklistTransferRequest, { operation: Operation }> {
  return {
    version: BLACKLIST_TRANSFER_RPC_VERSION,
    type: BLACKLIST_TRANSFER_REQUEST_TYPE,
    operation,
    input,
  } as Extract<BlacklistTransferRequest, { operation: Operation }>;
}

export function createBlacklistTransferResponse<
  Operation extends BlacklistTransferResponse["operation"],
>(
  operation: Operation,
  ok: boolean,
  data: Extract<BlacklistTransferResponse, { operation: Operation }>["data"] = null,
  error: BlacklistTransferError | null = null,
): Extract<BlacklistTransferResponse, { operation: Operation }> {
  return {
    version: BLACKLIST_TRANSFER_RPC_VERSION,
    type: BLACKLIST_TRANSFER_RESPONSE_TYPE,
    operation,
    ok,
    data,
    error,
  } as Extract<BlacklistTransferResponse, { operation: Operation }>;
}
