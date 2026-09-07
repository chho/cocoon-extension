import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistTransferResponse,
  type BlacklistTransferRequest,
} from "../core/blacklist-transfer-rpc-contract.ts";
import {
  createBlacklistTransferFileMetadata,
  type BlacklistTransferEnvelopeV1,
} from "../core/blacklist-transfer-values.ts";
import {
  BlacklistTransferRpcClientError,
  createBlacklistTransferRpcClient,
} from "./blacklist-transfer-rpc.ts";

const EXPORTED_AT = "2026-08-25T12:34:56.789Z";
const SESSION_ID = "1".repeat(32);
const transfer: BlacklistTransferEnvelopeV1 = {
  product: "cocoon-blacklist",
  formatVersion: 1,
  exportedAt: EXPORTED_AT,
  schemaVersion: 5,
  authors: [],
  tags: [{ tagId: "default", name: "default" }],
};
const metadata = createBlacklistTransferFileMetadata(
  transfer,
  new TextEncoder().encode(JSON.stringify(transfer)).byteLength,
);

function successFor(message: unknown) {
  const request = message as BlacklistTransferRequest;
  switch (request.operation) {
    case "import-begin":
    case "import-inspect":
      return createBlacklistTransferResponse(request.operation, true, {
        sessionId: SESSION_ID,
        metadata,
        status: "receiving",
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
        received: {
          authors: { chunks: 0, count: 0, bytes: 2 },
          tags: { chunks: 0, count: 0, bytes: 2 },
        },
      });
    case "import-authors-chunk":
    case "import-tags-chunk":
      return createBlacklistTransferResponse(request.operation, false, null, "incomplete-import");
    case "import-finalize":
      return createBlacklistTransferResponse(request.operation, true, {
        revision: 2,
        authorCount: 0,
        tagCount: 1,
      });
    case "import-abort":
      return createBlacklistTransferResponse(request.operation, true, { sessionId: SESSION_ID });
    case "export-begin":
      return createBlacklistTransferResponse(request.operation, true, {
        product: "cocoon-blacklist",
        formatVersion: 1,
        exportedAt: EXPORTED_AT,
        schemaVersion: 5,
        revision: 2,
        authorCount: 0,
        tagCount: 1,
      });
    case "export-authors-page":
      return createBlacklistTransferResponse(request.operation, true, {
        revision: 2,
        items: [],
        nextCursor: null,
      });
    case "export-tags-page":
      return createBlacklistTransferResponse(request.operation, true, {
        revision: 2,
        items: transfer.tags,
        nextCursor: null,
      });
    case "export-finish":
      return createBlacklistTransferResponse(request.operation, true, { revision: 2 });
  }
}

test("BUG-016 strict transfer UI client exposes only controller operations", async () => {
  const sent: unknown[] = [];
  const client = createBlacklistTransferRpcClient(async (message) => {
    sent.push(message);
    return successFor(message);
  });
  const author = {
    platformId: "zhihu",
    userId: "synthetic",
    memberHashId: null,
    authorNameAtCapture: "Synthetic",
    tagId: "default",
    blacklistedAt: EXPORTED_AT,
    blockSource: "direct",
  } as const;

  await client.beginImport(metadata);
  await client.stageAuthorsChunk({
    sessionId: SESSION_ID,
    chunkIndex: 0,
    startIndex: 0,
    authors: [author],
  });
  await client.stageTagsChunk({
    sessionId: SESSION_ID,
    chunkIndex: 0,
    startIndex: 0,
    tags: transfer.tags,
  });
  await client.inspectImport(SESSION_ID);
  await client.finalizeImport(SESSION_ID, "merge");
  await client.finalizeImport(SESSION_ID, "replace");
  await client.abortImport(SESSION_ID);
  await client.beginExport();
  await client.exportAuthorsPage({ revision: 2, cursor: null, limit: 50 });
  await client.exportTagsPage({ revision: 2, cursor: null, limit: 50 });
  await client.finishExport(2);

  deepStrictEqual(
    sent.map((message) => (message as { operation: string }).operation),
    [
      "import-begin",
      "import-authors-chunk",
      "import-tags-chunk",
      "import-inspect",
      "import-finalize",
      "import-finalize",
      "import-abort",
      "export-begin",
      "export-authors-page",
      "export-tags-page",
      "export-finish",
    ],
  );
});

test("BUG-016 strict transfer UI client rejects invalid input before transport", async () => {
  let calls = 0;
  const client = createBlacklistTransferRpcClient(async () => {
    calls += 1;
    return null;
  });

  await rejects(
    client.beginImport({ ...metadata, extra: true } as typeof metadata),
    BlacklistTransferRpcClientError,
  );
  await rejects(client.inspectImport("not-a-session"), BlacklistTransferRpcClientError);
  strictEqual(calls, 0);
});

test("BUG-016 strict transfer UI client rejects malformed and operation-mismatched responses", async () => {
  const malformed = createBlacklistTransferRpcClient(async () => ({ ok: true }));
  await rejects(malformed.beginExport(), BlacklistTransferRpcClientError);

  const mismatched = createBlacklistTransferRpcClient(async () =>
    createBlacklistTransferResponse("export-finish", true, { revision: 2 }),
  );
  await rejects(mismatched.beginExport(), BlacklistTransferRpcClientError);
});

test("BUG-016 strict transfer UI client preserves explicit background errors", async () => {
  const client = createBlacklistTransferRpcClient(async () =>
    createBlacklistTransferResponse("export-authors-page", false, null, "stale-export"),
  );
  const response = await client.exportAuthorsPage({ revision: 2, cursor: null, limit: 50 });
  strictEqual(response.ok, false);
  strictEqual(response.error, "stale-export");
});
