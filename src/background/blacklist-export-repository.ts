import type {
  BlacklistExportAuthorsPageDto,
  BlacklistExportBeginDto,
  BlacklistExportPageInput,
  BlacklistExportTagsPageDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type * as TransferValuesModule from "../core/blacklist-transfer-values.ts";
import type {
  BlacklistTransferAuthorDto,
  BlacklistTransferTagDto,
} from "../core/blacklist-transfer-values.ts";
// @ts-expect-error Vite resolves the background-only dependency graph during bundling.
import * as backgroundTransferValues from "../core/blacklist-transfer-values.ts?background-copy";

const {
  BLACKLIST_TRANSFER_CURSOR_BYTES,
  BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE,
  BLACKLIST_TRANSFER_FORMAT_VERSION,
  BLACKLIST_TRANSFER_PAGE_PAYLOAD_BYTES,
  BLACKLIST_TRANSFER_PRODUCT,
  BLACKLIST_TRANSFER_SCHEMA_VERSION,
  blacklistTransferJsonBytes,
  blacklistTransferTextBytes,
  hasExactBlacklistTransferKeys,
  isBlacklistTransferRecord,
  isValidBlacklistTransferTimestamp,
} = backgroundTransferValues as typeof TransferValuesModule;
import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  parseStoredAuthor,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
  type StoredBlacklistMetadata,
} from "./blacklist-idb-schema.ts";
import { StaleBlacklistExportError } from "./blacklist-transfer-repository-errors.ts";

interface ExportCursor {
  readonly version: 1;
  readonly operation: "export-authors" | "export-tags";
  readonly revision: number;
  readonly order: number;
}

function currentExportedAt(clock: () => number): string {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Export clock is invalid.");
  const exportedAt = new Date(value).toISOString();
  if (!isValidBlacklistTransferTimestamp(exportedAt)) throw new Error("Export clock is invalid.");
  return exportedAt;
}

async function metadataFrom(transaction: IDBTransaction): Promise<StoredBlacklistMetadata> {
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
  );
  const metadata = parseStoredMetadata(raw);
  if (!metadata) throw new Error("IndexedDB blacklist metadata is unreadable.");
  return metadata;
}

function requireRevision(metadata: StoredBlacklistMetadata, revision: number): void {
  if (metadata.revision !== revision) throw new StaleBlacklistExportError();
}

function parsePageInput(input: BlacklistExportPageInput): BlacklistExportPageInput {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > BLACKLIST_TRANSFER_EXPORT_PAGE_SIZE ||
    (input.cursor !== null &&
      (typeof input.cursor !== "string" ||
        input.cursor.length === 0 ||
        blacklistTransferTextBytes(input.cursor) > BLACKLIST_TRANSFER_CURSOR_BYTES))
  ) {
    throw new StaleBlacklistExportError();
  }
  return input;
}

function parseCursor(
  value: string | null,
  operation: ExportCursor["operation"],
  revision: number,
): ExportCursor | null {
  if (value === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    throw new StaleBlacklistExportError();
  }
  if (
    !isBlacklistTransferRecord(raw) ||
    !hasExactBlacklistTransferKeys(raw, ["version", "operation", "revision", "order"]) ||
    raw.version !== 1 ||
    raw.operation !== operation ||
    raw.revision !== revision ||
    !Number.isSafeInteger(raw.order) ||
    (raw.order as number) < 0
  ) {
    throw new StaleBlacklistExportError();
  }
  return raw as unknown as ExportCursor;
}

function encodeCursor(cursor: ExportCursor): string {
  const value = JSON.stringify(cursor);
  if (blacklistTransferTextBytes(value) > BLACKLIST_TRANSFER_CURSOR_BYTES) {
    throw new Error("Export cursor is too large.");
  }
  return value;
}

interface ScanResult<Item> {
  readonly items: readonly Item[];
  readonly lastOrder: number | null;
  readonly hasMore: boolean;
}

function scanExportItems<Item>(options: {
  readonly index: IDBIndex;
  readonly range: IDBKeyRange | null;
  readonly limit: number;
  readonly parse: (value: unknown) => Promise<{ readonly item: Item; readonly order: number }>;
}): Promise<ScanResult<Item>> {
  return new Promise<ScanResult<Item>>((resolve, reject) => {
    const items: Item[] = [];
    let payloadBytes = 2;
    let lastOrder: number | null = null;
    const request = options.index.openCursor(options.range);
    request.onerror = () => reject(request.error ?? new Error("Export page scan failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ items, lastOrder, hasMore: false });
        return;
      }
      void (async () => {
        try {
          const parsed = await options.parse(cursor.value);
          const itemBytes = blacklistTransferJsonBytes(parsed.item);
          if (itemBytes === null) throw new Error("Export item is not serializable.");
          const nextBytes = payloadBytes + itemBytes + (items.length > 0 ? 1 : 0);
          if (items.length >= options.limit || nextBytes > BLACKLIST_TRANSFER_PAGE_PAYLOAD_BYTES) {
            resolve({ items, lastOrder, hasMore: true });
            return;
          }
          items.push(parsed.item);
          payloadBytes = nextBytes;
          lastOrder = parsed.order;
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      })();
    };
  });
}

function pageRange(cursor: ExportCursor | null): IDBKeyRange | null {
  return cursor ? IDBKeyRange.lowerBound(cursor.order, true) : null;
}

async function exportAuthorFrom(
  value: unknown,
  tags: IDBObjectStore,
): Promise<{ readonly item: BlacklistTransferAuthorDto; readonly order: number }> {
  if (!isBlacklistTransferRecord(value) || typeof value.tagId !== "string") {
    throw new Error("IndexedDB export author is unreadable.");
  }
  const rawTag = await requestResult(tags.get(value.tagId));
  const tag = parseStoredTag(rawTag);
  const author = tag ? parseStoredAuthor(value, { tagId: tag.tagId, name: tag.name }) : null;
  if (!author) throw new Error("IndexedDB export author is unreadable.");
  return {
    order: author.order,
    item: {
      platformId: author.platformId,
      userId: author.userId,
      memberHashId: author.memberHashId,
      authorNameAtCapture: author.authorNameAtCapture,
      tagId: author.tagId,
      blacklistedAt: author.blacklistedAt,
      blockSource: author.blockSource,
    },
  };
}

export async function beginBlacklistExport(
  database: IDBDatabase,
  clock: () => number,
): Promise<BlacklistExportBeginDto> {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  const exportedAt = currentExportedAt(clock);
  await done;
  return {
    product: BLACKLIST_TRANSFER_PRODUCT,
    formatVersion: BLACKLIST_TRANSFER_FORMAT_VERSION,
    exportedAt,
    schemaVersion: BLACKLIST_TRANSFER_SCHEMA_VERSION,
    revision: metadata.revision,
    authorCount: metadata.authorCount,
    tagCount: metadata.tagCount,
  };
}

export async function exportBlacklistAuthorsPage(
  database: IDBDatabase,
  untrustedInput: BlacklistExportPageInput,
): Promise<BlacklistExportAuthorsPageDto> {
  const input = parsePageInput(untrustedInput);
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.authors, BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, input.revision);
  const cursor = parseCursor(input.cursor, "export-authors", input.revision);
  const tags = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  const scan = await scanExportItems<BlacklistTransferAuthorDto>({
    index: transaction.objectStore(BLACKLIST_STORE_NAMES.authors).index("by-order"),
    range: pageRange(cursor),
    limit: input.limit,
    parse: (value) => exportAuthorFrom(value, tags),
  });
  await done;
  return {
    revision: metadata.revision,
    items: scan.items,
    nextCursor:
      scan.hasMore && scan.lastOrder !== null
        ? encodeCursor({
            version: 1,
            operation: "export-authors",
            revision: metadata.revision,
            order: scan.lastOrder,
          })
        : null,
  };
}

export async function exportBlacklistTagsPage(
  database: IDBDatabase,
  untrustedInput: BlacklistExportPageInput,
): Promise<BlacklistExportTagsPageDto> {
  const input = parsePageInput(untrustedInput);
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.tags, BLACKLIST_STORE_NAMES.metadata],
    "readonly",
  );
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, input.revision);
  const cursor = parseCursor(input.cursor, "export-tags", input.revision);
  const scan = await scanExportItems<BlacklistTransferTagDto>({
    index: transaction.objectStore(BLACKLIST_STORE_NAMES.tags).index("by-order"),
    range: pageRange(cursor),
    limit: input.limit,
    async parse(value) {
      const tag = parseStoredTag(value);
      if (!tag) throw new Error("IndexedDB export tag is unreadable.");
      return { order: tag.order, item: { tagId: tag.tagId, name: tag.name } };
    },
  });
  await done;
  return {
    revision: metadata.revision,
    items: scan.items,
    nextCursor:
      scan.hasMore && scan.lastOrder !== null
        ? encodeCursor({
            version: 1,
            operation: "export-tags",
            revision: metadata.revision,
            order: scan.lastOrder,
          })
        : null,
  };
}

export async function finishBlacklistExport(
  database: IDBDatabase,
  revision: number,
): Promise<{ readonly revision: number }> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new StaleBlacklistExportError();
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const metadata = await metadataFrom(transaction);
  requireRevision(metadata, revision);
  await done;
  return { revision };
}
