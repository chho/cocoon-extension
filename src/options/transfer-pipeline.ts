import type {
  BlacklistImportMode,
  BlacklistTransferError,
  BlacklistTransferSummaryDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import {
  BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE,
  BLACKLIST_TRANSFER_FILE_BYTES,
  blacklistTransferTextBytes,
} from "../core/blacklist-transfer-values.ts";
import type { BlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import type { PreparedBlacklistImport } from "./transfer-file.ts";

export type OptionsTransferPipelineErrorCode =
  BlacklistTransferError | "invalid-transfer-response" | "transfer-too-large" | "transport-failed";

export class OptionsTransferPipelineError extends Error {
  readonly code: OptionsTransferPipelineErrorCode;
  readonly sessionId: string | null;

  constructor(code: OptionsTransferPipelineErrorCode, sessionId: string | null = null) {
    super(`Cocoon transfer pipeline failed: ${code}`);
    this.code = code;
    this.sessionId = sessionId;
  }
}

export type OptionsTransferProgress =
  | {
      readonly phase: "import-tags" | "import-authors" | "export-tags" | "export-authors";
      readonly completed: number;
      readonly total: number;
    }
  | { readonly phase: "import-inspect" | "import-finalize" | "export-finish" };

interface ImportPipelineOptions {
  readonly client: BlacklistTransferRpcClient;
  readonly prepared: PreparedBlacklistImport;
  readonly mode: BlacklistImportMode;
  readonly resumeSessionId: string | null;
  readonly onSession?: (sessionId: string) => void;
  readonly onProgress?: (progress: OptionsTransferProgress) => void;
}

interface ExportPipelineOptions {
  readonly client: BlacklistTransferRpcClient;
  readonly onProgress?: (progress: OptionsTransferProgress) => void;
}

export interface BlacklistImportPipelineResult {
  readonly sessionId: string;
  readonly summary: BlacklistTransferSummaryDto;
}

export interface BlacklistExportPipelineResult {
  readonly parts: readonly BlobPart[];
  readonly filename: string;
  readonly authorCount: number;
  readonly tagCount: number;
}

interface StartedImport {
  readonly sessionId: string;
  readonly ready: boolean;
}

interface ExportAssembly {
  readonly parts: BlobPart[];
  bytes: number;
}

function pipelineFailure(
  error: BlacklistTransferError | null,
  sessionId: string | null = null,
): OptionsTransferPipelineError {
  return new OptionsTransferPipelineError(error ?? "invalid-transfer-response", sessionId);
}

function sameMetadata(
  left: PreparedBlacklistImport["metadata"],
  right: PreparedBlacklistImport["metadata"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function resumeImport(options: ImportPipelineOptions): Promise<StartedImport | null> {
  const sessionId = options.resumeSessionId;
  if (!sessionId) return null;
  const inspected = await options.client.inspectImport(sessionId);
  if (!inspected.ok || !inspected.data) {
    const missing =
      inspected.error === "session-not-found" || inspected.error === "session-expired";
    if (missing) return null;
    throw pipelineFailure(inspected.error, sessionId);
  }
  if (!sameMetadata(inspected.data.metadata, options.prepared.metadata)) {
    throw new OptionsTransferPipelineError("chunk-conflict", sessionId);
  }
  if (inspected.data.status === "expired") return null;
  options.onSession?.(sessionId);
  return { sessionId, ready: inspected.data.status === "ready" };
}

async function startImport(options: ImportPipelineOptions): Promise<StartedImport> {
  const resumed = await resumeImport(options);
  if (resumed) return resumed;
  const begun = await options.client.beginImport(options.prepared.metadata);
  if (!begun.ok || !begun.data) throw pipelineFailure(begun.error);
  options.onSession?.(begun.data.sessionId);
  return { sessionId: begun.data.sessionId, ready: begun.data.status === "ready" };
}

async function stageTags(options: ImportPipelineOptions, sessionId: string): Promise<void> {
  for (const chunk of options.prepared.tagChunks) {
    const response = await options.client.stageTagsChunk({
      sessionId,
      chunkIndex: chunk.chunkIndex,
      startIndex: chunk.startIndex,
      tags: chunk.items,
    });
    if (!response.ok || !response.data) throw pipelineFailure(response.error, sessionId);
    options.onProgress?.({
      phase: "import-tags",
      completed: chunk.startIndex + chunk.items.length,
      total: options.prepared.metadata.tagCount,
    });
  }
}

async function stageAuthors(options: ImportPipelineOptions, sessionId: string): Promise<void> {
  for (const chunk of options.prepared.authorChunks) {
    const response = await options.client.stageAuthorsChunk({
      sessionId,
      chunkIndex: chunk.chunkIndex,
      startIndex: chunk.startIndex,
      authors: chunk.items,
    });
    if (!response.ok || !response.data) throw pipelineFailure(response.error, sessionId);
    options.onProgress?.({
      phase: "import-authors",
      completed: chunk.startIndex + chunk.items.length,
      total: options.prepared.metadata.authorCount,
    });
  }
}

async function inspectReady(options: ImportPipelineOptions, sessionId: string): Promise<void> {
  options.onProgress?.({ phase: "import-inspect" });
  const response = await options.client.inspectImport(sessionId);
  if (!response.ok || !response.data) throw pipelineFailure(response.error, sessionId);
  const ready =
    response.data.status === "ready" &&
    sameMetadata(response.data.metadata, options.prepared.metadata);
  if (!ready) throw new OptionsTransferPipelineError("incomplete-import", sessionId);
}

export async function runBlacklistImport(
  options: ImportPipelineOptions,
): Promise<BlacklistImportPipelineResult> {
  let sessionId: string | null = options.resumeSessionId;
  try {
    const started = await startImport(options);
    sessionId = started.sessionId;
    if (!started.ready) {
      await stageTags(options, sessionId);
      await stageAuthors(options, sessionId);
      await inspectReady(options, sessionId);
    }
    options.onProgress?.({ phase: "import-finalize" });
    const finalized = await options.client.finalizeImport(sessionId, options.mode);
    if (!finalized.ok || !finalized.data) throw pipelineFailure(finalized.error, sessionId);
    return { sessionId, summary: finalized.data };
  } catch (error) {
    if (error instanceof OptionsTransferPipelineError) throw error;
    throw new OptionsTransferPipelineError("transport-failed", sessionId);
  }
}

export async function abortBlacklistImport(
  client: BlacklistTransferRpcClient,
  sessionId: string,
): Promise<boolean> {
  try {
    const response = await client.abortImport(sessionId);
    if (response.ok) return true;
    if (response.error === "session-not-found" || response.error === "session-expired")
      return false;
    throw pipelineFailure(response.error, sessionId);
  } catch (error) {
    if (error instanceof OptionsTransferPipelineError) throw error;
    throw new OptionsTransferPipelineError("transport-failed", sessionId);
  }
}

function appendExportPart(assembly: ExportAssembly, part: string): void {
  const nextBytes = assembly.bytes + blacklistTransferTextBytes(part);
  if (nextBytes > BLACKLIST_TRANSFER_FILE_BYTES) {
    throw new OptionsTransferPipelineError("transfer-too-large");
  }
  assembly.parts.push(part);
  assembly.bytes = nextBytes;
}

function appendPage<Item>(
  assembly: ExportAssembly,
  items: readonly Item[],
  alreadyHasItems: boolean,
): boolean {
  if (items.length === 0) return alreadyHasItems;
  const pageJson = JSON.stringify(items);
  appendExportPart(assembly, `${alreadyHasItems ? "," : ""}${pageJson.slice(1, -1)}`);
  return true;
}

function nextCursor(current: string | null, next: string | null, seen: Set<string>): string | null {
  if (next === null) return null;
  if (next === current || seen.has(next)) throw new OptionsTransferPipelineError("stale-export");
  seen.add(next);
  return next;
}

async function exportAuthors(
  options: ExportPipelineOptions,
  revision: number,
  expectedCount: number,
  assembly: ExportAssembly,
): Promise<void> {
  let cursor: string | null = null;
  let count = 0;
  let hasItems = false;
  const seen = new Set<string>();
  do {
    const response = await options.client.exportAuthorsPage({
      revision,
      cursor,
      limit: BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE,
    });
    if (!response.ok || !response.data) throw pipelineFailure(response.error);
    if (response.data.revision !== revision) throw new OptionsTransferPipelineError("stale-export");
    count += response.data.items.length;
    if (count > expectedCount) throw new OptionsTransferPipelineError("stale-export");
    hasItems = appendPage(assembly, response.data.items, hasItems);
    options.onProgress?.({ phase: "export-authors", completed: count, total: expectedCount });
    cursor = nextCursor(cursor, response.data.nextCursor, seen);
  } while (cursor !== null);
  if (count !== expectedCount) throw new OptionsTransferPipelineError("stale-export");
}

async function exportTags(
  options: ExportPipelineOptions,
  revision: number,
  expectedCount: number,
  assembly: ExportAssembly,
): Promise<void> {
  let cursor: string | null = null;
  let count = 0;
  let hasItems = false;
  const seen = new Set<string>();
  do {
    const response = await options.client.exportTagsPage({
      revision,
      cursor,
      limit: BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE,
    });
    if (!response.ok || !response.data) throw pipelineFailure(response.error);
    if (response.data.revision !== revision) throw new OptionsTransferPipelineError("stale-export");
    count += response.data.items.length;
    if (count > expectedCount) throw new OptionsTransferPipelineError("stale-export");
    hasItems = appendPage(assembly, response.data.items, hasItems);
    options.onProgress?.({ phase: "export-tags", completed: count, total: expectedCount });
    cursor = nextCursor(cursor, response.data.nextCursor, seen);
  } while (cursor !== null);
  if (count !== expectedCount) throw new OptionsTransferPipelineError("stale-export");
}

function beginExportAssembly(metadata: {
  readonly product: string;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly schemaVersion: number;
}): ExportAssembly {
  const header = JSON.stringify(metadata);
  const assembly: ExportAssembly = { parts: [], bytes: 0 };
  appendExportPart(assembly, `${header.slice(0, -1)},"authors":[`);
  return assembly;
}

export async function runBlacklistExport(
  options: ExportPipelineOptions,
): Promise<BlacklistExportPipelineResult> {
  try {
    const begun = await options.client.beginExport();
    if (!begun.ok || !begun.data) throw pipelineFailure(begun.error);
    const metadata = begun.data;
    const assembly = beginExportAssembly({
      product: metadata.product,
      formatVersion: metadata.formatVersion,
      exportedAt: metadata.exportedAt,
      schemaVersion: metadata.schemaVersion,
    });
    await exportAuthors(options, metadata.revision, metadata.authorCount, assembly);
    appendExportPart(assembly, `],"tags":[`);
    await exportTags(options, metadata.revision, metadata.tagCount, assembly);
    appendExportPart(assembly, "]}");
    options.onProgress?.({ phase: "export-finish" });
    const finished = await options.client.finishExport(metadata.revision);
    if (!finished.ok || !finished.data || finished.data.revision !== metadata.revision) {
      throw pipelineFailure(finished.error ?? "stale-export");
    }
    return {
      parts: assembly.parts,
      filename: `cocoon-blacklist-${metadata.exportedAt.slice(0, 10)}.json`,
      authorCount: metadata.authorCount,
      tagCount: metadata.tagCount,
    };
  } catch (error) {
    if (error instanceof OptionsTransferPipelineError) throw error;
    throw new OptionsTransferPipelineError("transport-failed");
  }
}
