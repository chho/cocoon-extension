import type * as TransferContractModule from "../core/blacklist-transfer-rpc-contract.ts";
import type {
  BlacklistTransferError,
  BlacklistTransferOperation,
  BlacklistTransferRequest,
  BlacklistTransferResponse,
} from "../core/blacklist-transfer-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundTransferContract from "../core/blacklist-transfer-rpc-contract.ts?background-copy";
import {
  ImportChunkConflictError,
  ImportSessionExpiredError,
  ImportSessionNotFoundError,
  IncompleteBlacklistImportError,
  StaleBlacklistExportError,
  TransferFinalizeConflictError,
} from "./blacklist-transfer-repository-errors.ts";
import type { BlacklistTransferRepository } from "./blacklist-transfer-repository-types.ts";

const { createBlacklistTransferResponse } =
  backgroundTransferContract as typeof TransferContractModule;

export type BlacklistTransferControllerRepository = BlacklistTransferRepository;

export interface BlacklistTransferController {
  handleTransfer(request: BlacklistTransferRequest): Promise<BlacklistTransferResponse>;
}

function isQuotaError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "QuotaExceededError"
  );
}

function fallbackError(operation: BlacklistTransferOperation): BlacklistTransferError {
  switch (operation) {
    case "import-begin":
    case "import-authors-chunk":
    case "import-tags-chunk":
    case "import-finalize":
    case "import-abort":
      return "save-failed";
    case "import-inspect":
    case "export-begin":
    case "export-authors-page":
    case "export-tags-page":
    case "export-finish":
      return "storage-unreadable";
  }
}

export function mapBlacklistTransferError(
  operation: BlacklistTransferOperation,
  error: unknown,
): BlacklistTransferError {
  if (error instanceof ImportSessionNotFoundError) return "session-not-found";
  if (error instanceof ImportSessionExpiredError) return "session-expired";
  if (error instanceof ImportChunkConflictError) return "chunk-conflict";
  if (error instanceof IncompleteBlacklistImportError) return "incomplete-import";
  if (error instanceof TransferFinalizeConflictError) return "transfer-conflict";
  if (error instanceof StaleBlacklistExportError) return "stale-export";
  if (isQuotaError(error)) return "save-failed";
  return fallbackError(operation);
}

function failureResponse(
  operation: BlacklistTransferOperation,
  error: unknown,
): BlacklistTransferResponse {
  return createBlacklistTransferResponse(
    operation,
    false,
    null,
    mapBlacklistTransferError(operation, error),
  );
}

type ImportTransferRequest = Extract<
  BlacklistTransferRequest,
  { readonly operation: `import-${string}` }
>;
type ExportTransferRequest = Exclude<BlacklistTransferRequest, ImportTransferRequest>;

function isImportTransferRequest(
  request: BlacklistTransferRequest,
): request is ImportTransferRequest {
  return request.operation.startsWith("import-");
}

async function runImportTransfer(
  repository: BlacklistTransferControllerRepository,
  request: ImportTransferRequest,
): Promise<BlacklistTransferResponse> {
  switch (request.operation) {
    case "import-begin":
      await repository.cleanupExpiredImports();
      return createBlacklistTransferResponse(
        "import-begin",
        true,
        await repository.beginImport(request.input.metadata),
      );
    case "import-authors-chunk":
      return createBlacklistTransferResponse(
        "import-authors-chunk",
        true,
        await repository.stageAuthorsChunk(request.input),
      );
    case "import-tags-chunk":
      return createBlacklistTransferResponse(
        "import-tags-chunk",
        true,
        await repository.stageTagsChunk(request.input),
      );
    case "import-inspect": {
      const session = await repository.inspectImport(request.input.sessionId);
      if (!session) throw new ImportSessionNotFoundError();
      return createBlacklistTransferResponse("import-inspect", true, session);
    }
    case "import-finalize": {
      const result =
        request.input.mode === "merge"
          ? await repository.finalizeMerge(request.input.sessionId)
          : await repository.finalizeReplace(request.input.sessionId);
      return createBlacklistTransferResponse("import-finalize", true, result);
    }
    case "import-abort": {
      const aborted = await repository.abortImport(request.input.sessionId);
      if (!aborted) throw new ImportSessionNotFoundError();
      return createBlacklistTransferResponse("import-abort", true, {
        sessionId: request.input.sessionId,
      });
    }
  }
}

async function runExportTransfer(
  repository: BlacklistTransferControllerRepository,
  request: ExportTransferRequest,
): Promise<BlacklistTransferResponse> {
  switch (request.operation) {
    case "export-begin":
      return createBlacklistTransferResponse("export-begin", true, await repository.beginExport());
    case "export-authors-page":
      return createBlacklistTransferResponse(
        "export-authors-page",
        true,
        await repository.exportAuthorsPage(request.input),
      );
    case "export-tags-page":
      return createBlacklistTransferResponse(
        "export-tags-page",
        true,
        await repository.exportTagsPage(request.input),
      );
    case "export-finish":
      return createBlacklistTransferResponse(
        "export-finish",
        true,
        await repository.finishExport(request.input.revision),
      );
  }
}

async function handleTransfer(
  repository: BlacklistTransferControllerRepository,
  request: BlacklistTransferRequest,
): Promise<BlacklistTransferResponse> {
  try {
    return isImportTransferRequest(request)
      ? await runImportTransfer(repository, request)
      : await runExportTransfer(repository, request);
  } catch (error) {
    return failureResponse(request.operation, error);
  }
}

export function createBlacklistTransferController(
  repository: BlacklistTransferControllerRepository,
): BlacklistTransferController {
  return { handleTransfer: (request) => handleTransfer(repository, request) };
}
