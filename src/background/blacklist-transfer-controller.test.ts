import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { IDBKeyRange as FakeIDBKeyRange, indexedDB } from "fake-indexeddb";

import {
  createBlacklistTransferRequest,
  parseBlacklistTransferResponse,
  type BlacklistImportSessionDto,
} from "../core/blacklist-transfer-rpc-contract.ts";
import {
  createBlacklistTransferFileMetadata,
  type BlacklistTransferEnvelopeV1,
} from "../core/blacklist-transfer-values.ts";
import {
  createBlacklistTransferController,
  type BlacklistTransferControllerRepository,
} from "./blacklist-transfer-controller.ts";
import {
  ImportChunkConflictError,
  ImportSessionExpiredError,
  ImportSessionNotFoundError,
  IncompleteBlacklistImportError,
  StaleBlacklistExportError,
  TransferFinalizeConflictError,
} from "./blacklist-transfer-repository-errors.ts";
import { createBlacklistRepository } from "./blacklist-repository.ts";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: FakeIDBKeyRange,
});

const SESSION_ID = "1".repeat(32);
const EXPORTED_AT = "2026-08-25T12:34:56.789Z";
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
const session: BlacklistImportSessionDto = {
  sessionId: SESSION_ID,
  metadata,
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
  received: {
    authors: { chunks: 0, count: 0, bytes: 2 },
    tags: { chunks: 1, count: 1, bytes: metadata.tagsBytes },
  },
};
const summary = { revision: 2, authorCount: 0, tagCount: 1 };
const exportBegin = {
  product: "cocoon-blacklist",
  formatVersion: 1,
  exportedAt: EXPORTED_AT,
  schemaVersion: 5,
  revision: 2,
  authorCount: 0,
  tagCount: 1,
} as const;

function repository(overrides: Partial<BlacklistTransferControllerRepository> = {}) {
  const calls: string[] = [];
  const value: BlacklistTransferControllerRepository = {
    async beginImport() {
      calls.push("beginImport");
      return session;
    },
    async stageAuthorsChunk() {
      calls.push("stageAuthorsChunk");
      return { status: "staged", session };
    },
    async stageTagsChunk() {
      calls.push("stageTagsChunk");
      return { status: "staged", session };
    },
    async inspectImport() {
      calls.push("inspectImport");
      return session;
    },
    async abortImport() {
      calls.push("abortImport");
      return true;
    },
    async cleanupExpiredImports() {
      calls.push("cleanupExpiredImports");
      return 0;
    },
    async finalizeMerge() {
      calls.push("finalizeMerge");
      return summary;
    },
    async finalizeReplace() {
      calls.push("finalizeReplace");
      return summary;
    },
    async beginExport() {
      calls.push("beginExport");
      return exportBegin;
    },
    async exportAuthorsPage() {
      calls.push("exportAuthorsPage");
      return { revision: 2, items: [], nextCursor: null };
    },
    async exportTagsPage() {
      calls.push("exportTagsPage");
      return {
        revision: 2,
        items: [{ tagId: "default", name: "default" }],
        nextCursor: null,
      };
    },
    async finishExport() {
      calls.push("finishExport");
      return { revision: 2 };
    },
    ...overrides,
  };
  return { calls, value };
}

function requests() {
  return [
    createBlacklistTransferRequest("import-begin", { metadata }),
    createBlacklistTransferRequest("import-authors-chunk", {
      sessionId: SESSION_ID,
      chunkIndex: 0,
      startIndex: 0,
      authors: [
        {
          platformId: "zhihu",
          userId: "synthetic",
          memberHashId: null,
          authorNameAtCapture: "Synthetic",
          tagId: "default",
          blacklistedAt: EXPORTED_AT,
          blockSource: "direct",
        },
      ],
    }),
    createBlacklistTransferRequest("import-tags-chunk", {
      sessionId: SESSION_ID,
      chunkIndex: 0,
      startIndex: 0,
      tags: transfer.tags,
    }),
    createBlacklistTransferRequest("import-inspect", { sessionId: SESSION_ID }),
    createBlacklistTransferRequest("import-abort", { sessionId: SESSION_ID }),
    createBlacklistTransferRequest("import-finalize", {
      sessionId: SESSION_ID,
      mode: "merge",
    }),
    createBlacklistTransferRequest("import-finalize", {
      sessionId: SESSION_ID,
      mode: "replace",
    }),
    createBlacklistTransferRequest("export-begin", {}),
    createBlacklistTransferRequest("export-authors-page", {
      revision: 2,
      cursor: null,
      limit: 50,
    }),
    createBlacklistTransferRequest("export-tags-page", {
      revision: 2,
      cursor: null,
      limit: 50,
    }),
    createBlacklistTransferRequest("export-finish", { revision: 2 }),
  ] as const;
}

test("BUG-016/AC-099 transfer controller dispatches every strict operation", async () => {
  const harness = repository();
  const controller = createBlacklistTransferController(harness.value);

  for (const request of requests()) {
    const response = await controller.handleTransfer(request);
    strictEqual(parseBlacklistTransferResponse(response, request.operation), response);
    strictEqual(response.ok, true);
  }

  deepStrictEqual(harness.calls, [
    "cleanupExpiredImports",
    "beginImport",
    "stageAuthorsChunk",
    "stageTagsChunk",
    "inspectImport",
    "abortImport",
    "finalizeMerge",
    "finalizeReplace",
    "beginExport",
    "exportAuthorsPage",
    "exportTagsPage",
    "finishExport",
  ]);
});

test("BUG-016/AC-099 transfer controller maps domain, quota, and storage errors explicitly", async () => {
  const cases = [
    ["import-authors-chunk", new ImportChunkConflictError(), "chunk-conflict"],
    ["import-authors-chunk", new ImportSessionExpiredError(), "session-expired"],
    ["import-finalize", new ImportSessionNotFoundError(), "session-not-found"],
    ["import-finalize", new IncompleteBlacklistImportError(), "incomplete-import"],
    ["import-finalize", new TransferFinalizeConflictError(), "transfer-conflict"],
    ["export-authors-page", new StaleBlacklistExportError(), "stale-export"],
    ["import-finalize", new DOMException("quota", "QuotaExceededError"), "save-failed"],
    ["import-begin", new Error("write failed"), "save-failed"],
    ["import-inspect", new Error("read failed"), "storage-unreadable"],
    ["export-begin", new Error("read failed"), "storage-unreadable"],
  ] as const;

  for (const [operation, error, expected] of cases) {
    const request = requests().find((candidate) => candidate.operation === operation)!;
    const method =
      operation === "import-authors-chunk"
        ? "stageAuthorsChunk"
        : operation === "import-finalize"
          ? "finalizeMerge"
          : operation === "import-inspect"
            ? "inspectImport"
            : operation === "import-begin"
              ? "beginImport"
              : operation === "export-begin"
                ? "beginExport"
                : "exportAuthorsPage";
    const harness = repository({
      [method]: async () => {
        throw error;
      },
    });
    const response = await createBlacklistTransferController(harness.value).handleTransfer(request);
    strictEqual(response.ok, false, operation);
    strictEqual(response.error, expected, operation);
    strictEqual(response.data, null, operation);
  }
});

test("BUG-016/AC-099 missing inspect and abort sessions are explicit", async () => {
  const harness = repository({
    async inspectImport() {
      return null;
    },
    async abortImport() {
      return false;
    },
  });
  const controller = createBlacklistTransferController(harness.value);
  const inspect = await controller.handleTransfer(
    createBlacklistTransferRequest("import-inspect", { sessionId: SESSION_ID }),
  );
  const abort = await controller.handleTransfer(
    createBlacklistTransferRequest("import-abort", { sessionId: SESSION_ID }),
  );
  strictEqual(inspect.error, "session-not-found");
  strictEqual(abort.error, "session-not-found");
});

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.values.get(key) };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

test("BUG-016/AC-099 rebuilt worker controller inspects persisted staging", async () => {
  const databaseName = `transfer-controller-restart-${crypto.randomUUID()}`;
  const storage = new MemoryStorage();
  const options = {
    indexedDB,
    databaseName,
    storage,
    clock: () => 1_000,
    randomSessionId: () => SESSION_ID,
  };
  const first = createBlacklistTransferController(createBlacklistRepository(options));
  const begun = await first.handleTransfer(
    createBlacklistTransferRequest("import-begin", { metadata }),
  );
  strictEqual(begun.ok, true);
  await first.handleTransfer(
    createBlacklistTransferRequest("import-tags-chunk", {
      sessionId: SESSION_ID,
      chunkIndex: 0,
      startIndex: 0,
      tags: transfer.tags,
    }),
  );

  const restarted = createBlacklistTransferController(createBlacklistRepository(options));
  const inspected = await restarted.handleTransfer(
    createBlacklistTransferRequest("import-inspect", { sessionId: SESSION_ID }),
  );
  strictEqual(inspected.ok, true);
  strictEqual(inspected.operation, "import-inspect");
  if (inspected.operation !== "import-inspect") throw new Error("Unexpected operation.");
  strictEqual(inspected.data?.sessionId, SESSION_ID);
  strictEqual("received" in inspected.data!, true);
});
