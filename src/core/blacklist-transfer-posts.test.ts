import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import {
  BLACKLIST_TRANSFER_FILE_BYTES,
  canonicalTransferBytes,
  parseBlacklistTransferFileJson,
  serializeBlacklistTransferFile,
} from "./blacklist-transfer-values.ts";
import { parseBlacklistTransferFileMetadata } from "./blacklist-transfer-rpc-contract.ts";

const post = {
  postId: "zhihu:answer:2",
  platformId: "zhihu",
  kind: "answer",
  contentId: "2",
  title: "Synthetic title",
  url: "https://www.zhihu.com/question/1/answer/2",
};
const author = {
  platformId: "zhihu",
  userId: "synthetic",
  memberHashId: null,
  authorNameAtCapture: "Synthetic",
  tagId: "default",
  blacklistedAt: null,
  blockSource: "direct",
  sourcePostId: post.postId,
};
const envelope = {
  product: "cocoon-blacklist",
  formatVersion: 2,
  schemaVersion: 6,
  exportedAt: "2026-08-25T12:34:56.789Z",
  authors: [author, { ...author, userId: "synthetic-other" }],
  tags: [{ tagId: "default", name: "default" }],
  posts: [post],
};

test("POST-005 format2 roundtrip preserves one shared post and both author references", () => {
  const result = parseBlacklistTransferFileJson(JSON.stringify(envelope));
  strictEqual(result.status, "valid");
  if (result.status !== "valid") return;
  deepStrictEqual(result.transfer, envelope);
  ok(parseBlacklistTransferFileMetadata(result.metadata));
  strictEqual(
    parseBlacklistTransferFileJson(serializeBlacklistTransferFile(result.transfer)!).status,
    "valid",
  );
});

test("POST-005 accepts a maximum-size legacy file even when normalized bytes exceed 32 MiB", () => {
  const legacyAuthor = {
    ...author,
    sourcePostId: undefined,
    userId: "synthetic-000000",
    authorNameAtCapture: "x".repeat(500),
  };
  const base = { ...envelope, posts: undefined, formatVersion: 1, schemaVersion: 5, authors: [] };
  const emptyBytes = JSON.stringify(base).length;
  const authorBytes = JSON.stringify(legacyAuthor).length;
  const count = Math.floor((BLACKLIST_TRANSFER_FILE_BYTES - emptyBytes + 1) / (authorBytes + 1));
  const json = JSON.stringify({
    ...base,
    authors: Array.from({ length: count }, (_, index) => ({
      ...legacyAuthor,
      userId: `synthetic-${String(index).padStart(6, "0")}`,
    })),
  });
  const padded = json.padEnd(BLACKLIST_TRANSFER_FILE_BYTES, " ");
  strictEqual(padded.length, BLACKLIST_TRANSFER_FILE_BYTES);
  const result = parseBlacklistTransferFileJson(padded);
  strictEqual(result.status, "valid");
  if (result.status !== "valid") return;
  ok(result.metadata.canonicalBytes > BLACKLIST_TRANSFER_FILE_BYTES);
  strictEqual(result.metadata.canonicalBytes, json.length + count * 20 + 11);
  ok(parseBlacklistTransferFileMetadata(result.metadata));
  strictEqual(
    parseBlacklistTransferFileMetadata({ ...result.metadata, sourceFormatVersion: 2 }),
    null,
  );
  strictEqual(parseBlacklistTransferFileJson(`${padded} `).status, "too-large");
});

test("POST-005 forged legacy author counts cannot manufacture unbounded normalization allowance", () => {
  const result = parseBlacklistTransferFileJson(JSON.stringify(envelope));
  if (result.status !== "valid") throw new Error("Expected valid fixture");
  const authorCount = 10_000_000;
  const forged = {
    ...result.metadata,
    sourceFormatVersion: 1,
    sourceBytes: BLACKLIST_TRANSFER_FILE_BYTES,
    postCount: 0,
    postsBytes: 2,
    postChunkCount: 0,
    authorCount,
    authorChunkCount: Math.ceil(authorCount / 500),
    authorsBytes: 200_000_000,
  };
  strictEqual(
    parseBlacklistTransferFileMetadata({
      ...forged,
      canonicalBytes: canonicalTransferBytes(forged),
    }),
    null,
  );
});

test("POST-005 new-format metadata permits no normalization byte expansion", () => {
  const result = parseBlacklistTransferFileJson(JSON.stringify(envelope));
  if (result.status !== "valid") throw new Error("Expected a valid file");
  strictEqual(
    parseBlacklistTransferFileMetadata({
      ...result.metadata,
      sourceBytes: result.metadata.sourceBytes - 1,
    }),
    null,
  );
  strictEqual(
    parseBlacklistTransferFileMetadata({ ...result.metadata, sourceFormatVersion: 1 }),
    null,
  );
});

test("POST-005 rejects absent, cross-platform, duplicate and malformed source posts", () => {
  for (const invalid of [
    { ...envelope, posts: [] },
    { ...envelope, authors: [{ ...author, platformId: "youtube" }] },
    { ...envelope, posts: [post, post] },
    { ...envelope, posts: [{ ...post, url: "https://evil.test/" }] },
    { ...envelope, posts: [{ ...post, title: "x".repeat(501) }] },
    { ...envelope, authors: [{ ...author, sourcePostId: undefined }] },
    { ...envelope, extra: true },
  ])
    strictEqual(parseBlacklistTransferFileJson(JSON.stringify(invalid)).status, "invalid");
});

test("POST-005 legacy files normalize to null refs with honest expanded canonical bytes", () => {
  const legacyAuthor = { ...author, sourcePostId: undefined };
  const legacy = {
    ...envelope,
    posts: undefined,
    formatVersion: 1,
    schemaVersion: 5,
    authors: [legacyAuthor],
  };
  const json = JSON.stringify(legacy);
  const result = parseBlacklistTransferFileJson(json);
  strictEqual(result.status, "valid");
  if (result.status !== "valid") return;
  strictEqual(result.transfer.formatVersion, 2);
  strictEqual(result.transfer.schemaVersion, 6);
  deepStrictEqual(result.transfer.posts, []);
  strictEqual(result.transfer.authors[0]?.sourcePostId, null);
  strictEqual(result.metadata.sourceBytes, new TextEncoder().encode(json).byteLength);
  ok(result.metadata.canonicalBytes > result.metadata.sourceBytes);
  ok(parseBlacklistTransferFileMetadata(result.metadata));
  strictEqual(
    parseBlacklistTransferFileMetadata({
      ...result.metadata,
      sourceBytes: result.metadata.sourceBytes - 1,
    }),
    null,
  );
  strictEqual(
    parseBlacklistTransferFileMetadata({ ...result.metadata, sourceFormatVersion: 2 }),
    null,
  );
  strictEqual(
    parseBlacklistTransferFileJson(JSON.stringify({ ...legacy, authors: [author] })).status,
    "invalid",
  );
});
