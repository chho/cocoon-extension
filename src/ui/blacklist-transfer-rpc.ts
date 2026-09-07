import {
  BLACKLIST_TRANSFER_REQUEST_TYPE,
  BLACKLIST_TRANSFER_RPC_VERSION,
  parseBlacklistTransferRequest,
  parseBlacklistTransferResponse,
  type BlacklistExportPageInput,
  type BlacklistImportAuthorsChunkInput,
  type BlacklistImportMode,
  type BlacklistImportTagsChunkInput,
  type BlacklistTransferOperation,
  type BlacklistTransferRequest,
  type BlacklistTransferResponse,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type { BlacklistTransferFileMetadataDto } from "../core/blacklist-transfer-values.ts";

export class BlacklistTransferRpcClientError extends Error {
  constructor() {
    super("Cocoon background returned an invalid transfer response.");
  }
}

type TransferResponseFor<Operation extends BlacklistTransferOperation> = Extract<
  BlacklistTransferResponse,
  { readonly operation: Operation }
>;

export interface BlacklistTransferRpcClient {
  beginImport(
    metadata: BlacklistTransferFileMetadataDto,
  ): Promise<TransferResponseFor<"import-begin">>;
  stageAuthorsChunk(
    input: BlacklistImportAuthorsChunkInput,
  ): Promise<TransferResponseFor<"import-authors-chunk">>;
  stageTagsChunk(
    input: BlacklistImportTagsChunkInput,
  ): Promise<TransferResponseFor<"import-tags-chunk">>;
  inspectImport(sessionId: string): Promise<TransferResponseFor<"import-inspect">>;
  finalizeImport(
    sessionId: string,
    mode: BlacklistImportMode,
  ): Promise<TransferResponseFor<"import-finalize">>;
  abortImport(sessionId: string): Promise<TransferResponseFor<"import-abort">>;
  beginExport(): Promise<TransferResponseFor<"export-begin">>;
  exportAuthorsPage(
    input: BlacklistExportPageInput,
  ): Promise<TransferResponseFor<"export-authors-page">>;
  exportTagsPage(input: BlacklistExportPageInput): Promise<TransferResponseFor<"export-tags-page">>;
  finishExport(revision: number): Promise<TransferResponseFor<"export-finish">>;
}

class RuntimeBlacklistTransferRpcClient implements BlacklistTransferRpcClient {
  private readonly sendMessage: (message: unknown) => Promise<unknown>;

  constructor(sendMessage: (message: unknown) => Promise<unknown>) {
    this.sendMessage = sendMessage;
  }

  beginImport(metadata: BlacklistTransferFileMetadataDto) {
    return this.request("import-begin", { metadata });
  }

  stageAuthorsChunk(input: BlacklistImportAuthorsChunkInput) {
    return this.request("import-authors-chunk", input);
  }

  stageTagsChunk(input: BlacklistImportTagsChunkInput) {
    return this.request("import-tags-chunk", input);
  }

  inspectImport(sessionId: string) {
    return this.request("import-inspect", { sessionId });
  }

  finalizeImport(sessionId: string, mode: BlacklistImportMode) {
    return this.request("import-finalize", { sessionId, mode });
  }

  abortImport(sessionId: string) {
    return this.request("import-abort", { sessionId });
  }

  beginExport() {
    return this.request("export-begin", {});
  }

  exportAuthorsPage(input: BlacklistExportPageInput) {
    return this.request("export-authors-page", input);
  }

  exportTagsPage(input: BlacklistExportPageInput) {
    return this.request("export-tags-page", input);
  }

  finishExport(revision: number) {
    return this.request("export-finish", { revision });
  }

  private async request<Operation extends BlacklistTransferOperation>(
    operation: Operation,
    input: Extract<BlacklistTransferRequest, { operation: Operation }>["input"],
  ): Promise<TransferResponseFor<Operation>> {
    const candidate: unknown = {
      version: BLACKLIST_TRANSFER_RPC_VERSION,
      type: BLACKLIST_TRANSFER_REQUEST_TYPE,
      operation,
      input,
    };
    const parsedRequest = parseBlacklistTransferRequest(candidate);
    if (!parsedRequest || parsedRequest.operation !== operation) {
      throw new BlacklistTransferRpcClientError();
    }
    const response = await this.sendMessage(parsedRequest);
    const parsedResponse = parseBlacklistTransferResponse(response, operation);
    if (!parsedResponse || parsedResponse.operation !== operation) {
      throw new BlacklistTransferRpcClientError();
    }
    return parsedResponse as TransferResponseFor<Operation>;
  }
}

export function createBlacklistTransferRpcClient(
  sendMessage: (message: unknown) => Promise<unknown>,
): BlacklistTransferRpcClient {
  return new RuntimeBlacklistTransferRpcClient(sendMessage);
}
