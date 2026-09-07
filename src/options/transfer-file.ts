import {
  BLACKLIST_TRANSFER_REQUEST_TYPE,
  BLACKLIST_TRANSFER_RPC_VERSION,
} from "../core/blacklist-transfer-rpc-contract.ts";
import {
  BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE,
  BLACKLIST_TRANSFER_FILE_BYTES,
  BLACKLIST_TRANSFER_RPC_BYTES,
  BLACKLIST_TRANSFER_TAG_CHUNK_SIZE,
  blacklistTransferJsonBytes,
  createBlacklistTransferFileMetadata,
  parseBlacklistTransferFileJson,
  type BlacklistTransferAuthorDto,
  type BlacklistTransferFileMetadataDto,
  type BlacklistTransferTagDto,
} from "../core/blacklist-transfer-values.ts";

const SESSION_ID_SIZE_PLACEHOLDER = "0".repeat(32);

type ImportChunkKind = "authors" | "tags";

export interface PreparedTransferChunk<Item> {
  readonly chunkIndex: number;
  readonly startIndex: number;
  readonly items: readonly Item[];
}

export interface PreparedBlacklistImport {
  readonly metadata: BlacklistTransferFileMetadataDto;
  readonly authorChunks: readonly PreparedTransferChunk<BlacklistTransferAuthorDto>[];
  readonly tagChunks: readonly PreparedTransferChunk<BlacklistTransferTagDto>[];
}

export type PreparedBlacklistImportResult =
  | { readonly status: "valid"; readonly prepared: PreparedBlacklistImport }
  | { readonly status: "invalid" | "too-large" };

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

function importChunkRequestBytes(
  kind: ImportChunkKind,
  chunkIndex: number,
  startIndex: number,
  items: readonly unknown[],
): number {
  const operation = kind === "authors" ? "import-authors-chunk" : "import-tags-chunk";
  const input = {
    sessionId: SESSION_ID_SIZE_PLACEHOLDER,
    chunkIndex,
    startIndex,
    [kind]: items,
  };
  return (
    blacklistTransferJsonBytes({
      version: BLACKLIST_TRANSFER_RPC_VERSION,
      type: BLACKLIST_TRANSFER_REQUEST_TYPE,
      operation,
      input,
    }) ?? Infinity
  );
}

function splitImportChunks<Item>(
  kind: ImportChunkKind,
  items: readonly Item[],
  maximumCount: number,
): readonly PreparedTransferChunk<Item>[] {
  const chunks: PreparedTransferChunk<Item>[] = [];
  let startIndex = 0;
  while (startIndex < items.length) {
    const chunkIndex = chunks.length;
    const emptyRequestBytes = importChunkRequestBytes(kind, chunkIndex, startIndex, []);
    let collectionBytes = 2;
    let endIndex = startIndex;
    while (endIndex < items.length && endIndex - startIndex < maximumCount) {
      const itemBytes = blacklistTransferJsonBytes(items[endIndex]);
      if (itemBytes === null) throw new Error("Transfer item is not serializable.");
      const nextCollectionBytes = collectionBytes + itemBytes + (endIndex === startIndex ? 0 : 1);
      if (emptyRequestBytes - 2 + nextCollectionBytes > BLACKLIST_TRANSFER_RPC_BYTES) break;
      collectionBytes = nextCollectionBytes;
      endIndex += 1;
    }
    if (endIndex === startIndex) {
      throw new Error("One transfer item exceeds the bounded RPC size.");
    }
    chunks.push({
      chunkIndex,
      startIndex,
      items: items.slice(startIndex, endIndex),
    });
    startIndex = endIndex;
  }
  return chunks;
}

export function prepareBlacklistTransferJson(json: string): PreparedBlacklistImportResult {
  const parsed = parseBlacklistTransferFileJson(json);
  if (parsed.status !== "valid") return parsed;
  try {
    const authorChunks = splitImportChunks(
      "authors",
      parsed.transfer.authors,
      BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE,
    );
    const tagChunks = splitImportChunks(
      "tags",
      parsed.transfer.tags,
      BLACKLIST_TRANSFER_TAG_CHUNK_SIZE,
    );
    const metadata = {
      ...createBlacklistTransferFileMetadata(parsed.transfer, parsed.metadata.sourceBytes),
      authorChunkCount: authorChunks.length,
      tagChunkCount: tagChunks.length,
    };
    return { status: "valid", prepared: { metadata, authorChunks, tagChunks } };
  } catch {
    return { status: "invalid" };
  }
}

export async function readFileText(file: File): Promise<string> {
  return await file.text();
}

export async function readBlacklistTransferFile(
  file: File,
  reader: (file: File) => Promise<string> = readFileText,
): Promise<PreparedBlacklistImportResult> {
  if (!Number.isSafeInteger(file.size) || file.size < 0) return { status: "invalid" };
  if (file.size > BLACKLIST_TRANSFER_FILE_BYTES) return { status: "too-large" };
  return prepareBlacklistTransferJson(await reader(file));
}

export function downloadJsonBlob(
  document: Document,
  objectUrls: ObjectUrlApi,
  parts: readonly BlobPart[],
  filename: string,
  scheduleCleanup: (callback: () => void) => void,
): void {
  const blob = new Blob([...parts], { type: "application/json;charset=utf-8" });
  const url = objectUrls.createObjectURL(blob);
  let link: HTMLAnchorElement | null = null;
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    objectUrls.revokeObjectURL(url);
  };

  try {
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
  } finally {
    link?.remove();
    try {
      scheduleCleanup(revoke);
    } catch (error) {
      revoke();
      throw error;
    }
  }
}
