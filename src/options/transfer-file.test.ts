import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  BLACKLIST_TRANSFER_FILE_BYTES,
  BLACKLIST_TRANSFER_RPC_BYTES,
  blacklistTransferJsonBytes,
} from "../core/blacklist-transfer-values.ts";
import { createBlacklistTransferRequest } from "../core/blacklist-transfer-rpc-contract.ts";
import {
  downloadJsonBlob,
  prepareBlacklistTransferJson,
  readBlacklistTransferFile,
  readFileText,
  type ObjectUrlApi,
} from "./transfer-file.ts";

const JSON_CONTENT = JSON.stringify({
  product: "cocoon-blacklist",
  formatVersion: 1,
});
const FILENAME = "cocoon-blacklist-2026-08-22.json";

function fixture(): JSDOM {
  return new JSDOM("<!doctype html><body></body>", {
    url: "chrome-extension://runtime/options/options.html",
  });
}

test("MANAGE-004/AC-089 real Blob download uses exact JSON metadata and a temporary clicked anchor", async () => {
  const dom = fixture();
  const createdBlobs: Blob[] = [];
  const revokedUrls: string[] = [];
  const cleanupCallbacks: Array<() => void> = [];
  const objectUrls: ObjectUrlApi = {
    createObjectURL(blob) {
      createdBlobs.push(blob);
      return "blob:cocoon-transfer";
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  const clickedLinks: HTMLAnchorElement[] = [];
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    clickedLinks.push(this);
    strictEqual(dom.window.document.body.contains(this), true);
  };

  downloadJsonBlob(dom.window.document, objectUrls, [JSON_CONTENT], FILENAME, (callback) =>
    cleanupCallbacks.push(callback),
  );

  strictEqual(createdBlobs.length, 1);
  strictEqual(createdBlobs[0]?.type, "application/json;charset=utf-8");
  strictEqual(await createdBlobs[0]?.text(), JSON_CONTENT);
  const clickedLink = clickedLinks[0];
  if (!clickedLink) throw new Error("download anchor was not clicked");
  strictEqual(clickedLink.download, FILENAME);
  strictEqual(clickedLink.href, "blob:cocoon-transfer");
  strictEqual(clickedLink.hidden, true);
  strictEqual(clickedLink.rel, "noopener");
  strictEqual(dom.window.document.body.contains(clickedLink), false);
  strictEqual(dom.window.document.querySelector("a"), null);
  deepStrictEqual(revokedUrls, []);
  strictEqual(cleanupCallbacks.length, 1);

  cleanupCallbacks[0]?.();
  cleanupCallbacks[0]?.();
  deepStrictEqual(revokedUrls, ["blob:cocoon-transfer"]);
});

test("MANAGE-004/AC-089 Blob URL cleanup survives click and cleanup-scheduler failures", () => {
  const clickDom = fixture();
  const clickError = new Error("click failed");
  const failedLinks: HTMLAnchorElement[] = [];
  const deferredCleanups: Array<() => void> = [];
  const clickRevocations: string[] = [];
  clickDom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    failedLinks.push(this);
    throw clickError;
  };

  throws(
    () =>
      downloadJsonBlob(
        clickDom.window.document,
        {
          createObjectURL: () => "blob:click-failure",
          revokeObjectURL: (url) => clickRevocations.push(url),
        },
        [JSON_CONTENT],
        FILENAME,
        (callback) => deferredCleanups.push(callback),
      ),
    clickError,
  );
  strictEqual(clickDom.window.document.body.contains(failedLinks[0] ?? null), false);
  deepStrictEqual(clickRevocations, []);
  deferredCleanups[0]?.();
  deepStrictEqual(clickRevocations, ["blob:click-failure"]);

  const schedulerDom = fixture();
  schedulerDom.window.HTMLAnchorElement.prototype.click = () => {};
  const schedulerError = new Error("cleanup scheduling failed");
  const schedulerRevocations: string[] = [];
  throws(
    () =>
      downloadJsonBlob(
        schedulerDom.window.document,
        {
          createObjectURL: () => "blob:scheduler-failure",
          revokeObjectURL: (url) => schedulerRevocations.push(url),
        },
        [JSON_CONTENT],
        FILENAME,
        () => {
          throw schedulerError;
        },
      ),
    schedulerError,
  );
  deepStrictEqual(schedulerRevocations, ["blob:scheduler-failure"]);
  strictEqual(schedulerDom.window.document.querySelector("a"), null);
});

test("MANAGE-004/AC-089 production file reader returns text and propagates read failures", async () => {
  let reads = 0;
  const readable = {
    async text() {
      reads += 1;
      return JSON_CONTENT;
    },
  } as File;
  strictEqual(await readFileText(readable), JSON_CONTENT);
  strictEqual(reads, 1);

  const failure = new Error("file unreadable");
  const unreadable = {
    async text(): Promise<string> {
      throw failure;
    },
  } as File;
  await rejects(readFileText(unreadable), failure);
});

const EXPORTED_AT = "2026-08-25T12:34:56.789Z";

function transferJson(authorCount = 2): string {
  return JSON.stringify({
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    schemaVersion: 5,
    authors: Array.from({ length: authorCount }, (_, index) => ({
      platformId: "zhihu",
      userId: `synthetic-${index}`,
      memberHashId: null,
      authorNameAtCapture: `Synthetic ${index}`,
      tagId: "default",
      blacklistedAt: EXPORTED_AT,
      blockSource: "direct",
    })),
    tags: [{ tagId: "default", name: "default" }],
  });
}

test("BUG-016 transfer file checks the exact 32 MiB boundary before File.text", async () => {
  let reads = 0;
  const reader = async () => {
    reads += 1;
    return transferJson();
  };
  const exact = { size: BLACKLIST_TRANSFER_FILE_BYTES } as File;
  const accepted = await readBlacklistTransferFile(exact, reader);
  strictEqual(accepted.status, "valid");
  strictEqual(reads, 1);

  const oversized = { size: BLACKLIST_TRANSFER_FILE_BYTES + 1 } as File;
  deepStrictEqual(await readBlacklistTransferFile(oversized, reader), { status: "too-large" });
  strictEqual(reads, 1);
});

test("BUG-016 strict file preparation validates default tags, identity aliases, and references", () => {
  const valid = JSON.parse(transferJson()) as {
    authors: Array<Record<string, unknown>>;
    tags: Array<Record<string, unknown>>;
  };
  for (const changed of [
    { ...valid, extra: true },
    { ...valid, tags: [{ tagId: "default", name: "Default" }] },
    { ...valid, authors: [{ ...valid.authors[0], tagId: "missing" }] },
    {
      ...valid,
      authors: [
        { ...valid.authors[0], userId: "same" },
        { ...valid.authors[1], memberHashId: "same" },
      ],
    },
  ]) {
    strictEqual(prepareBlacklistTransferJson(JSON.stringify(changed)).status, "invalid");
  }
});

test("BUG-016 file preparation supports the 33,524 and 100,000 synthetic protocols", () => {
  for (const authorCount of [33_524, 100_000]) {
    const json = JSON.stringify({
      product: "cocoon-blacklist",
      formatVersion: 1,
      exportedAt: EXPORTED_AT,
      schemaVersion: 5,
      authors: Array.from({ length: authorCount }, (_, index) => ({
        platformId: index % 10 === 0 ? "synthetic-platform" : "zhihu",
        userId: `synthetic-user-${String(index).padStart(6, "0")}`,
        memberHashId:
          index % 10 !== 0 && index % 4 === 0 ? index.toString(16).padStart(32, "0") : null,
        authorNameAtCapture: `Synthetic Author ${String(index).padStart(6, "0")} Group ${String(index % 100).padStart(2, "0")}`,
        tagId: "default",
        blacklistedAt: EXPORTED_AT,
        blockSource: "direct",
      })),
      tags: [{ tagId: "default", name: "default" }],
    });
    strictEqual(new TextEncoder().encode(json).byteLength < BLACKLIST_TRANSFER_FILE_BYTES, true);
    const result = prepareBlacklistTransferJson(json);
    strictEqual(result.status, "valid");
    if (result.status !== "valid") throw new Error("Expected scale fixture to be valid.");
    strictEqual(result.prepared.metadata.authorCount, authorCount);
    strictEqual(result.prepared.metadata.authorChunkCount, result.prepared.authorChunks.length);
  }
});

test("BUG-016 prepared chunks obey both 500-item and 256 KiB message bounds", () => {
  const parsed = JSON.parse(transferJson(501)) as {
    authors: Array<Record<string, unknown>>;
  };
  parsed.authors = Array.from({ length: 501 }, (_, index) => ({
    ...parsed.authors[index % 2],
    userId: `synthetic-${index}-${"u".repeat(400)}`,
    authorNameAtCapture: "n".repeat(500),
    tagId: "default",
  }));
  const result = prepareBlacklistTransferJson(JSON.stringify(parsed));
  strictEqual(result.status, "valid");
  if (result.status !== "valid") throw new Error("Expected a prepared import.");
  strictEqual(result.prepared.authorChunks.length > 1, true);
  strictEqual(result.prepared.metadata.authorChunkCount, result.prepared.authorChunks.length);
  for (const chunk of result.prepared.authorChunks) {
    strictEqual(chunk.items.length <= 500, true);
    const request = createBlacklistTransferRequest("import-authors-chunk", {
      sessionId: "1".repeat(32),
      chunkIndex: chunk.chunkIndex,
      startIndex: chunk.startIndex,
      authors: chunk.items,
    });
    strictEqual(
      (blacklistTransferJsonBytes(request) ?? Infinity) <= BLACKLIST_TRANSFER_RPC_BYTES,
      true,
    );
  }
});
