import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistTransferResponse,
  type BlacklistImportSessionDto,
  type BlacklistTransferError,
} from "../core/blacklist-transfer-rpc-contract.ts";
import type {
  BlacklistTransferAuthorDto,
  BlacklistTransferTagDto,
} from "../core/blacklist-transfer-values.ts";
import type { BlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import {
  abortBlacklistImport,
  OptionsTransferPipelineError,
  runBlacklistExport,
  runBlacklistImport,
} from "./transfer-pipeline.ts";
import { prepareBlacklistTransferJson } from "./transfer-file.ts";

const EXPORTED_AT = "2026-08-25T12:34:56.789Z";
const SESSION_ID = "1".repeat(32);

function author(index: number): BlacklistTransferAuthorDto {
  return {
    platformId: "zhihu",
    userId: `synthetic-${index}`,
    memberHashId: null,
    authorNameAtCapture: `Synthetic ${index}`,
    tagId: "default",
    blacklistedAt: EXPORTED_AT,
    blockSource: "direct",
  };
}

const tags: readonly BlacklistTransferTagDto[] = [{ tagId: "default", name: "default" }];

function prepared(authorCount = 501) {
  const result = prepareBlacklistTransferJson(
    JSON.stringify({
      product: "cocoon-blacklist",
      formatVersion: 1,
      exportedAt: EXPORTED_AT,
      schemaVersion: 5,
      authors: Array.from({ length: authorCount }, (_, index) => author(index)),
      tags,
    }),
  );
  if (result.status !== "valid") throw new Error("Expected prepared transfer fixture.");
  return result.prepared;
}

function session(
  value: ReturnType<typeof prepared>,
  status: BlacklistImportSessionDto["status"],
): BlacklistImportSessionDto {
  const complete = status === "ready";
  return {
    sessionId: SESSION_ID,
    metadata: value.metadata,
    status,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    received: {
      authors: {
        chunks: complete ? value.metadata.authorChunkCount : 0,
        count: complete ? value.metadata.authorCount : 0,
        bytes: complete ? value.metadata.authorsBytes : 2,
      },
      tags: {
        chunks: complete ? value.metadata.tagChunkCount : 0,
        count: complete ? value.metadata.tagCount : 0,
        bytes: complete ? value.metadata.tagsBytes : 2,
      },
    },
  };
}

function unusedClient(): BlacklistTransferRpcClient {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected transfer RPC.");
  };
  return {
    beginImport: unused,
    stageAuthorsChunk: unused,
    stageTagsChunk: unused,
    inspectImport: unused,
    finalizeImport: unused,
    abortImport: unused,
    beginExport: unused,
    exportAuthorsPage: unused,
    exportTagsPage: unused,
    finishExport: unused,
  };
}

test("BUG-016 import resumes a persisted session, accepts duplicate chunks, and finalizes in bounded order", async () => {
  const value = prepared();
  const calls: string[] = [];
  let authorChunks = 0;
  const client: BlacklistTransferRpcClient = {
    ...unusedClient(),
    async inspectImport() {
      calls.push("inspect");
      return createBlacklistTransferResponse("import-inspect", true, session(value, "receiving"));
    },
    async stageTagsChunk(input) {
      calls.push(`tag:${input.chunkIndex}:${input.startIndex}:${input.tags.length}`);
      return createBlacklistTransferResponse("import-tags-chunk", true, {
        status: "duplicate",
        session: session(value, "receiving"),
      });
    },
    async stageAuthorsChunk(input) {
      calls.push(`author:${input.chunkIndex}:${input.startIndex}:${input.authors.length}`);
      authorChunks += 1;
      return createBlacklistTransferResponse("import-authors-chunk", true, {
        status: authorChunks === 1 ? "duplicate" : "staged",
        session: session(value, "receiving"),
      });
    },
    async finalizeImport(sessionId, mode) {
      calls.push(`finalize:${sessionId}:${mode}`);
      return createBlacklistTransferResponse("import-finalize", true, {
        revision: 9,
        authorCount: 33_524,
        tagCount: 3,
      });
    },
  };
  let inspectCalls = 0;
  client.inspectImport = async () => {
    calls.push("inspect");
    inspectCalls += 1;
    return createBlacklistTransferResponse(
      "import-inspect",
      true,
      session(value, inspectCalls === 1 ? "receiving" : "ready"),
    );
  };

  const result = await runBlacklistImport({
    client,
    prepared: value,
    mode: "merge",
    resumeSessionId: SESSION_ID,
  });

  strictEqual(result.summary.authorCount, 33_524);
  strictEqual(calls[0], "inspect");
  strictEqual(calls.includes("begin"), false);
  strictEqual(calls[1]?.startsWith("tag:0:0:"), true);
  deepStrictEqual(
    calls.filter((call) => call.startsWith("author:")),
    value.authorChunks.map(
      (chunk) => `author:${chunk.chunkIndex}:${chunk.startIndex}:${chunk.items.length}`,
    ),
  );
  strictEqual(calls.at(-2), "inspect");
  strictEqual(calls.at(-1), `finalize:${SESSION_ID}:merge`);
});

test("BUG-016 import starts a new session, retains retry identity on storage error, and can abort", async () => {
  const value = prepared(1);
  let aborted = 0;
  const client: BlacklistTransferRpcClient = {
    ...unusedClient(),
    async beginImport() {
      return createBlacklistTransferResponse("import-begin", true, session(value, "receiving"));
    },
    async stageTagsChunk() {
      return createBlacklistTransferResponse("import-tags-chunk", true, {
        status: "staged",
        session: session(value, "receiving"),
      });
    },
    async stageAuthorsChunk() {
      return createBlacklistTransferResponse("import-authors-chunk", false, null, "save-failed");
    },
    async abortImport(sessionId) {
      aborted += 1;
      return createBlacklistTransferResponse("import-abort", true, { sessionId });
    },
  };

  await rejects(
    runBlacklistImport({ client, prepared: value, mode: "replace", resumeSessionId: null }),
    (error: unknown) =>
      error instanceof OptionsTransferPipelineError &&
      error.code === "save-failed" &&
      error.sessionId === SESSION_ID,
  );
  strictEqual(await abortBlacklistImport(client, SESSION_ID), true);
  strictEqual(aborted, 1);
});

test("BUG-016 export assembles exact format-v1 Blob parts only after revision finish", async () => {
  const exportedAuthors = [author(0), author(1)];
  let authorPage = 0;
  const client: BlacklistTransferRpcClient = {
    ...unusedClient(),
    async beginExport() {
      return createBlacklistTransferResponse("export-begin", true, {
        product: "cocoon-blacklist",
        formatVersion: 1,
        exportedAt: EXPORTED_AT,
        schemaVersion: 5,
        revision: 4,
        authorCount: 2,
        tagCount: 1,
      });
    },
    async exportAuthorsPage() {
      authorPage += 1;
      return createBlacklistTransferResponse("export-authors-page", true, {
        revision: 4,
        items: [exportedAuthors[authorPage - 1]!],
        nextCursor: authorPage === 1 ? "next-author" : null,
      });
    },
    async exportTagsPage() {
      return createBlacklistTransferResponse("export-tags-page", true, {
        revision: 4,
        items: tags,
        nextCursor: null,
      });
    },
    async finishExport(revision) {
      return createBlacklistTransferResponse("export-finish", true, { revision });
    },
  };

  const result = await runBlacklistExport({ client });
  const json = await new Blob([...result.parts]).text();
  deepStrictEqual(JSON.parse(json), {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    schemaVersion: 5,
    authors: exportedAuthors,
    tags,
  });
  strictEqual(result.filename, "cocoon-blacklist-2026-08-25.json");
  strictEqual(result.authorCount, 2);
  strictEqual(result.tagCount, 1);
});

test("BUG-016 stale export fails before returning downloadable parts", async () => {
  const client: BlacklistTransferRpcClient = {
    ...unusedClient(),
    async beginExport() {
      return createBlacklistTransferResponse("export-begin", true, {
        product: "cocoon-blacklist",
        formatVersion: 1,
        exportedAt: EXPORTED_AT,
        schemaVersion: 5,
        revision: 4,
        authorCount: 0,
        tagCount: 1,
      });
    },
    async exportAuthorsPage() {
      return createBlacklistTransferResponse("export-authors-page", true, {
        revision: 4,
        items: [],
        nextCursor: null,
      });
    },
    async exportTagsPage() {
      return createBlacklistTransferResponse("export-tags-page", true, {
        revision: 4,
        items: tags,
        nextCursor: null,
      });
    },
    async finishExport() {
      return createBlacklistTransferResponse("export-finish", false, null, "stale-export");
    },
  };

  await rejects(
    runBlacklistExport({ client }),
    (error: unknown) =>
      error instanceof OptionsTransferPipelineError && error.code === "stale-export",
  );
});

test("BUG-016 transfer pipeline exposes explicit background errors", () => {
  const errors: readonly BlacklistTransferError[] = [
    "storage-unreadable",
    "save-failed",
    "session-not-found",
    "session-expired",
    "chunk-conflict",
    "incomplete-import",
    "transfer-conflict",
    "stale-export",
  ];
  deepStrictEqual(errors.length, 8);
});
