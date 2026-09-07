import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE,
  BLACKLIST_TRANSFER_FILE_BYTES,
  BLACKLIST_TRANSFER_RPC_BYTES,
  BLACKLIST_TRANSFER_TAG_CHUNK_SIZE,
  createBlacklistTransferFileMetadata,
  parseBlacklistTransferFileJson,
  serializeBlacklistTransferFile,
  type BlacklistTransferAuthorDto,
  type BlacklistTransferEnvelopeV1,
} from "./blacklist-transfer-values.ts";
import {
  createBlacklistTransferRequest,
  createBlacklistTransferResponse,
  parseBlacklistTransferRequest,
  parseBlacklistTransferResponse,
  type BlacklistImportSessionDto,
} from "./blacklist-transfer-rpc-contract.ts";

const EXPORTED_AT = "2026-08-25T10:00:00.000Z";
const SESSION_ID = "a".repeat(32);

function author(index: number, overrides: Partial<BlacklistTransferAuthorDto> = {}) {
  return {
    platformId: "zhihu",
    userId: `synthetic-${index}`,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${index}`,
    tagId: "default",
    blacklistedAt: EXPORTED_AT,
    blockSource: "direct" as const,
    ...overrides,
  };
}

function envelope(
  authors: readonly BlacklistTransferAuthorDto[] = [author(0)],
): BlacklistTransferEnvelopeV1 {
  return {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    schemaVersion: 5,
    authors,
    tags: [{ tagId: "default", name: "default" }],
  };
}

function session(): BlacklistImportSessionDto {
  const transfer = envelope();
  const sourceBytes = new TextEncoder().encode(JSON.stringify(transfer)).byteLength;
  return {
    sessionId: SESSION_ID,
    metadata: createBlacklistTransferFileMetadata(transfer, sourceBytes),
    status: "receiving",
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 2_000,
    received: {
      authors: { chunks: 0, count: 0, bytes: 2 },
      tags: { chunks: 0, count: 0, bytes: 2 },
    },
  };
}

function beginForScale(authorCount: number, canonicalBytes: number) {
  const tagsBytes = new TextEncoder().encode(
    JSON.stringify([{ tagId: "default", name: "default" }]),
  ).byteLength;
  const empty = createBlacklistTransferFileMetadata(envelope([]), canonicalBytes);
  const authorsBytes = canonicalBytes - empty.canonicalBytes + empty.authorsBytes;
  return createBlacklistTransferRequest("import-begin", {
    metadata: {
      ...empty,
      sourceBytes: canonicalBytes,
      canonicalBytes,
      authorsBytes,
      authorCount,
      authorChunkCount: Math.ceil(authorCount / BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE),
      tagsBytes,
      tagCount: 1,
      tagChunkCount: 1,
    },
  });
}

test("BUG-016/AC-099 format v1/schema v5 round-trips without the old 8 MiB/count limits", () => {
  const transfer = envelope([
    author(0, { memberHashId: "b".repeat(32) }),
    author(1, { platformId: "youtube", tagId: "reading" }),
  ]);
  const withTag = {
    ...transfer,
    tags: [
      { tagId: "default", name: "default" },
      { tagId: "reading", name: "Reading" },
    ],
  };
  const json = serializeBlacklistTransferFile(withTag);
  strictEqual(typeof json, "string");
  if (json === null) throw new Error("Expected a serialized transfer file.");
  deepStrictEqual(parseBlacklistTransferFileJson(json), {
    status: "valid",
    transfer: withTag,
    metadata: createBlacklistTransferFileMetadata(
      withTag,
      new TextEncoder().encode(json).byteLength,
    ),
  });
});

test("BUG-016/AC-099 begin accepts 33,524 and 100,000 declared authors by bytes, not count", () => {
  for (const [count, bytes] of [
    [33_524, 7_670_490],
    [100_000, 22_880_066],
  ] as const) {
    const request = beginForScale(count, bytes);
    strictEqual(parseBlacklistTransferRequest(request), request);
  }
});

test("BUG-016/AC-099 import requests enforce exact shape, chunk count, field and byte limits", () => {
  const begin = beginForScale(100_000, 22_880_066);
  strictEqual(
    parseBlacklistTransferRequest({ ...begin, input: { ...begin.input, extra: true } }),
    null,
  );
  const emptyMetadata = createBlacklistTransferFileMetadata(
    envelope([]),
    new TextEncoder().encode(JSON.stringify(envelope([]))).byteLength,
  );
  strictEqual(
    parseBlacklistTransferRequest(
      createBlacklistTransferRequest("import-begin", {
        metadata: {
          ...emptyMetadata,
          sourceBytes: emptyMetadata.sourceBytes + 1,
          canonicalBytes: emptyMetadata.canonicalBytes + 1,
          authorsBytes: 3,
        },
      }),
    ),
    null,
  );
  strictEqual(
    parseBlacklistTransferRequest(beginForScale(100_000, BLACKLIST_TRANSFER_FILE_BYTES + 1)),
    null,
  );

  const validChunk = createBlacklistTransferRequest("import-authors-chunk", {
    sessionId: SESSION_ID,
    chunkIndex: 0,
    startIndex: 0,
    authors: [author(0)],
  });
  strictEqual(parseBlacklistTransferRequest(validChunk), validChunk);
  strictEqual(
    parseBlacklistTransferRequest({
      ...validChunk,
      input: { ...validChunk.input, authors: [] },
    }),
    null,
  );
  strictEqual(
    parseBlacklistTransferRequest({
      ...validChunk,
      input: {
        ...validChunk.input,
        authors: Array.from({ length: BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE + 1 }, (_, index) =>
          author(index),
        ),
      },
    }),
    null,
  );

  const oversized = createBlacklistTransferRequest("import-authors-chunk", {
    sessionId: SESSION_ID,
    chunkIndex: 0,
    startIndex: 0,
    authors: Array.from({ length: BLACKLIST_TRANSFER_AUTHOR_CHUNK_SIZE }, (_, index) =>
      author(index, {
        userId: `synthetic-${index}-${"u".repeat(400)}`,
        authorNameAtCapture: "n".repeat(500),
        tagId: "t".repeat(500),
      }),
    ),
  });
  strictEqual(JSON.stringify(oversized).length > BLACKLIST_TRANSFER_RPC_BYTES, true);
  strictEqual(parseBlacklistTransferRequest(oversized), null);

  const tags = createBlacklistTransferRequest("import-tags-chunk", {
    sessionId: SESSION_ID,
    chunkIndex: 0,
    startIndex: 0,
    tags: Array.from({ length: BLACKLIST_TRANSFER_TAG_CHUNK_SIZE }, (_, index) => ({
      tagId: index === 0 ? "default" : `tag-${index}`,
      name: index === 0 ? "default" : `Tag ${index}`,
    })),
  });
  strictEqual(parseBlacklistTransferRequest(tags), tags);
});

test("BUG-016/AC-099 transfer operations stay bound to their exact input and response parser", () => {
  const begin = beginForScale(33_524, 7_670_490);
  const finish = createBlacklistTransferRequest("export-finish", { revision: 4 });
  const inspect = createBlacklistTransferRequest("import-inspect", { sessionId: SESSION_ID });

  for (const invalid of [
    { ...begin, operation: "export-begin" },
    { ...finish, operation: "import-abort" },
    { ...inspect, operation: "export-finish" },
  ]) {
    strictEqual(parseBlacklistTransferRequest(invalid), null);
  }

  const beginResponse = createBlacklistTransferResponse("import-begin", true, session());
  strictEqual(parseBlacklistTransferResponse(beginResponse, "import-inspect"), null);
});

test("BUG-016/AC-099 export page requests are revision-pinned with bounded cursors", () => {
  const page = createBlacklistTransferRequest("export-authors-page", {
    revision: 7,
    cursor: null,
    limit: 500,
  });
  strictEqual(parseBlacklistTransferRequest(page), page);
  strictEqual(
    parseBlacklistTransferRequest({
      ...page,
      input: { ...page.input, cursor: "x".repeat(2_049) },
    }),
    null,
  );
  strictEqual(
    parseBlacklistTransferRequest({
      ...page,
      input: { ...page.input, revision: null },
    }),
    null,
  );
});

test("BUG-016/AC-099 strict responses expose only session/progress, pages, or summaries", () => {
  const begin = createBlacklistTransferResponse("import-begin", true, session());
  strictEqual(parseBlacklistTransferResponse(begin, "import-begin"), begin);
  strictEqual(
    parseBlacklistTransferResponse(
      { ...begin, data: { ...begin.data, extra: true } },
      "import-begin",
    ),
    null,
  );
  strictEqual(
    parseBlacklistTransferResponse(
      {
        ...begin,
        data: {
          ...session(),
          received: {
            authors: { chunks: 0, count: 1, bytes: 2 },
            tags: { chunks: 0, count: 0, bytes: 2 },
          },
        },
      },
      "import-begin",
    ),
    null,
  );

  const page = createBlacklistTransferResponse("export-authors-page", true, {
    revision: 4,
    items: [author(0)],
    nextCursor: JSON.stringify({ version: 1, operation: "export-authors", revision: 4, order: 0 }),
  });
  strictEqual(parseBlacklistTransferResponse(page, "export-authors-page"), page);
  strictEqual("authors" in (page.data as object), false);
  strictEqual(
    parseBlacklistTransferResponse(
      {
        ...page,
        data: { revision: 4, items: [author(0), author(0)], nextCursor: null },
      },
      "export-authors-page",
    ),
    null,
  );

  const oversizedSummary = createBlacklistTransferResponse("import-finalize", true, {
    revision: 5,
    authorCount: 100_000,
    tagCount: 2_001,
  });
  strictEqual(parseBlacklistTransferResponse(oversizedSummary, "import-finalize"), null);

  const failed = createBlacklistTransferResponse(
    "import-finalize",
    false,
    null,
    "transfer-conflict",
  );
  strictEqual(parseBlacklistTransferResponse(failed, "import-finalize"), failed);
});
