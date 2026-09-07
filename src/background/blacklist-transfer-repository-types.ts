import type {
  BlacklistExportAuthorsPageDto,
  BlacklistExportBeginDto,
  BlacklistExportPageInput,
  BlacklistExportTagsPageDto,
  BlacklistImportAuthorsChunkInput,
  BlacklistImportSessionDto,
  BlacklistImportTagsChunkInput,
  BlacklistTransferSummaryDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type { BlacklistTransferFileMetadataDto } from "../core/blacklist-transfer-values.ts";

export interface ImportChunkStageResult {
  readonly status: "staged" | "duplicate";
  readonly session: BlacklistImportSessionDto;
}

export interface BlacklistTransferRepository {
  beginImport(metadata: BlacklistTransferFileMetadataDto): Promise<BlacklistImportSessionDto>;
  stageAuthorsChunk(input: BlacklistImportAuthorsChunkInput): Promise<ImportChunkStageResult>;
  stageTagsChunk(input: BlacklistImportTagsChunkInput): Promise<ImportChunkStageResult>;
  inspectImport(sessionId: string): Promise<BlacklistImportSessionDto | null>;
  abortImport(sessionId: string): Promise<boolean>;
  cleanupExpiredImports(): Promise<number>;
  finalizeMerge(sessionId: string): Promise<BlacklistTransferSummaryDto>;
  finalizeReplace(sessionId: string): Promise<BlacklistTransferSummaryDto>;
  beginExport(): Promise<BlacklistExportBeginDto>;
  exportAuthorsPage(input: BlacklistExportPageInput): Promise<BlacklistExportAuthorsPageDto>;
  exportTagsPage(input: BlacklistExportPageInput): Promise<BlacklistExportTagsPageDto>;
  finishExport(revision: number): Promise<{ readonly revision: number }>;
}
