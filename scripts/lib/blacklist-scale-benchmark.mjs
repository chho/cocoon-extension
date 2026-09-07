import { TextEncoder } from "node:util";

const EXPORTED_AT = "2026-08-25T12:34:56.789Z";
const AUTHOR_KEYS = [
  "platformId",
  "userId",
  "memberHashId",
  "authorNameAtCapture",
  "tagId",
  "blacklistedAt",
  "blockSource",
];
const ENVELOPE_KEYS = [
  "product",
  "formatVersion",
  "exportedAt",
  "schemaVersion",
  "authors",
  "tags",
];
const TAG_KEYS = ["tagId", "name"];
const PLATFORM_PATTERN = /^[a-z][a-z0-9-]*$/;
const HASH_PATTERN = /^[0-9a-f]{32}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const encoder = new TextEncoder();

export const SYNTHETIC_TAGS = Object.freeze([
  Object.freeze({ tagId: "default", name: "default" }),
  Object.freeze({ tagId: "synthetic-focus", name: "Synthetic Focus" }),
  Object.freeze({ tagId: "synthetic-muted", name: "Synthetic Muted" }),
]);

export const BENCHMARK_LIMIT_DECISIONS = Object.freeze({
  ordinaryRpcBytes: 256 * 1024,
  authorPageSize: 50,
  tagPageSize: 100,
  identityBatchSize: 200,
  mutationBatchSize: 500,
  cursorBytes: 2_048,
  transferChunkBytes: 256 * 1024,
  transferChunkAuthors: 500,
  singleFileBytes: 32 * 1024 * 1024,
});

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function codePoints(value) {
  return Array.from(value).length;
}

function validTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function syntheticTimestamp(index) {
  return new Date(
    Date.UTC(
      2020 + (index % 7),
      index % 12,
      1 + (index % 28),
      index % 24,
      index % 60,
      index % 60,
      index % 1_000,
    ),
  ).toISOString();
}

export function createSyntheticAuthor(index) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("Synthetic author index is invalid.");
  const token = String(index).padStart(6, "0");
  const platformId = index % 10 === 0 ? "synthetic-platform" : "zhihu";
  const blockSource = index % 5 === 0 ? "upvoter" : "direct";
  return {
    platformId,
    userId: `synthetic-user-${token}`,
    memberHashId:
      platformId === "zhihu" && index % 4 === 0 ? index.toString(16).padStart(32, "0") : null,
    authorNameAtCapture: `Synthetic Author ${token} Group ${String(index % 100).padStart(2, "0")}`,
    tagId: SYNTHETIC_TAGS[index % SYNTHETIC_TAGS.length].tagId,
    blacklistedAt: blockSource === "direct" && index % 17 === 0 ? null : syntheticTimestamp(index),
    blockSource,
  };
}

export function createSyntheticTransfer(authorCount) {
  if (!Number.isSafeInteger(authorCount) || authorCount < 0) {
    throw new Error("Synthetic author count is invalid.");
  }
  return {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    schemaVersion: 5,
    authors: Array.from({ length: authorCount }, (_, index) => createSyntheticAuthor(index)),
    tags: SYNTHETIC_TAGS.map((tag) => ({ ...tag })),
  };
}

export function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

export function createSyntheticIdentityQueries(state) {
  return Array.from({ length: BENCHMARK_LIMIT_DECISIONS.identityBatchSize }, (_, index) =>
    index < 100
      ? {
          platformId: state.authors[index].platformId,
          identifier: state.authors[index].userId,
        }
      : { platformId: "zhihu", identifier: `missing-${index}` },
  );
}

export function createSyntheticAuthorQuery(search) {
  return {
    revision: null,
    cursor: null,
    limit: BENCHMARK_LIMIT_DECISIONS.authorPageSize,
    search,
    searchScope: "author",
    tagId: null,
    platformId: null,
    direction: "desc",
  };
}

export function createDatabaseBenchmarkMetrics(measurements) {
  return {
    idbV1SeedMs: measurements.seeded.duration,
    idbUpgradeMs: measurements.upgraded.duration,
    authorPageMs: measurements.authorPage.duration,
    substringQueryMs: measurements.substring.duration,
    identityBatchMs: measurements.identityBatch.duration,
    stagingPrototypeMs: measurements.staged.duration,
    finalizePrototypeMs: measurements.finalized.duration,
    pageCount: measurements.authorPage.value.items.length,
    substringCount: measurements.substring.value.totalCount,
    identityRequestCount: measurements.identities.length,
    identityMatchCount: measurements.identityBatch.value.matches.length,
    stagedAuthorCount: measurements.stagedAuthorCount,
    finalAuthorCount: measurements.finalAuthorCount,
  };
}

function validTag(value) {
  return (
    exactKeys(value, TAG_KEYS) &&
    typeof value.tagId === "string" &&
    value.tagId.length > 0 &&
    value.tagId === value.tagId.trim() &&
    codePoints(value.tagId) <= 512 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name === value.name.trim() &&
    codePoints(value.name) <= 30
  );
}

function validAuthorTextFields(value) {
  return (
    typeof value.platformId === "string" &&
    value.platformId.length <= 64 &&
    PLATFORM_PATTERN.test(value.platformId) &&
    typeof value.userId === "string" &&
    value.userId.length > 0 &&
    value.userId === value.userId.trim() &&
    codePoints(value.userId) <= 512 &&
    typeof value.authorNameAtCapture === "string" &&
    codePoints(value.authorNameAtCapture) <= 500
  );
}

function validAuthorSemantics(value, tagIds) {
  const sourceValid = value.blockSource === "direct" || value.blockSource === "upvoter";
  const timeValid = value.blacklistedAt === null || validTimestamp(value.blacklistedAt);
  return (
    typeof value.tagId === "string" &&
    tagIds.has(value.tagId) &&
    sourceValid &&
    timeValid &&
    !(value.blockSource === "upvoter" && value.blacklistedAt === null)
  );
}

function validMemberHash(value) {
  if (value.memberHashId === null) return true;
  return (
    value.platformId === "zhihu" &&
    typeof value.memberHashId === "string" &&
    HASH_PATTERN.test(value.memberHashId) &&
    value.memberHashId !== value.userId
  );
}

function validAuthor(value, tagIds) {
  return (
    exactKeys(value, AUTHOR_KEYS) &&
    validAuthorTextFields(value) &&
    validAuthorSemantics(value, tagIds) &&
    validMemberHash(value)
  );
}

function validEnvelopeShape(value) {
  return (
    exactKeys(value, ENVELOPE_KEYS) &&
    value.product === "cocoon-blacklist" &&
    value.formatVersion === 1 &&
    validTimestamp(value.exportedAt) &&
    value.schemaVersion === 5 &&
    Array.isArray(value.authors) &&
    Array.isArray(value.tags)
  );
}

function validateTags(tags) {
  const tagIds = new Set();
  const tagNames = new Set();
  for (const tag of tags) {
    const nameKey = typeof tag?.name === "string" ? tag.name.toLowerCase() : "";
    if (!validTag(tag) || tagIds.has(tag.tagId) || tagNames.has(nameKey)) return null;
    tagIds.add(tag.tagId);
    tagNames.add(nameKey);
  }
  const defaultTag = tags.find((tag) => tag.tagId === "default");
  return tagIds.has("default") && defaultTag?.name === "default" ? tagIds : null;
}

function validateAuthors(authors, tagIds) {
  const identifiers = new Set();
  for (const author of authors) {
    if (!validAuthor(author, tagIds)) return null;
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) continue;
      const key = JSON.stringify([author.platformId, identifier]);
      if (identifiers.has(key)) return null;
      identifiers.add(key);
    }
  }
  return identifiers.size;
}

export function validateSyntheticTransfer(value) {
  if (!validEnvelopeShape(value)) return { valid: false, authorCount: 0, identifierCount: 0 };
  const tagIds = validateTags(value.tags);
  if (!tagIds) return { valid: false, authorCount: 0, identifierCount: 0 };
  const identifierCount = validateAuthors(value.authors, tagIds);
  return identifierCount === null
    ? { valid: false, authorCount: 0, identifierCount: 0 }
    : { valid: true, authorCount: value.authors.length, identifierCount };
}

export function splitAuthorChunks(authors, limits = BENCHMARK_LIMIT_DECISIONS) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const author of authors) {
    const authorBytes = utf8Bytes(JSON.stringify(author));
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (authorBytes + 2 > limits.transferChunkBytes) {
      throw new Error("One synthetic author exceeds the transfer chunk byte limit.");
    }
    if (
      current.length >= limits.transferChunkAuthors ||
      currentBytes + separatorBytes + authorBytes > limits.transferChunkBytes
    ) {
      chunks.push({ authors: current, bytes: currentBytes });
      current = [];
      currentBytes = 2;
    }
    current.push(author);
    currentBytes += (current.length === 1 ? 0 : 1) + authorBytes;
  }
  if (current.length > 0) chunks.push({ authors: current, bytes: currentBytes });
  return chunks;
}

function milliseconds(value) {
  return Number(value.toFixed(1));
}

function mebibytes(value) {
  return Number((value / (1024 * 1024)).toFixed(1));
}

function formatScaleResult(result) {
  return [
    `scale=${result.scale}`,
    `utf8Bytes=${result.utf8Bytes}`,
    `generationMs=${milliseconds(result.generationMs)}`,
    `fileTextMs=${milliseconds(result.fileTextMs)}`,
    `jsonParseMs=${milliseconds(result.jsonParseMs)}`,
    `strictValidationMs=${milliseconds(result.strictValidationMs)}`,
    `peakRssMiB=${mebibytes(result.peakRssBytes)}`,
    `peakHeapMiB=${mebibytes(result.peakHeapBytes)}`,
    `idbV1SeedMs=${milliseconds(result.idbV1SeedMs)}`,
    `idbUpgradeMs=${milliseconds(result.idbUpgradeMs)}`,
    `authorPageMs=${milliseconds(result.authorPageMs)}`,
    `substringQueryMs=${milliseconds(result.substringQueryMs)}`,
    `identityBatchMs=${milliseconds(result.identityBatchMs)}`,
    `stagingPrototypeMs=${milliseconds(result.stagingPrototypeMs)}`,
    `finalizePrototypeMs=${milliseconds(result.finalizePrototypeMs)}`,
    `pageCount=${result.pageCount}`,
    `substringCount=${result.substringCount}`,
    `identityRequestCount=${result.identityRequestCount}`,
    `identityMatchCount=${result.identityMatchCount}`,
    `chunkCount=${result.chunkCount}`,
    `maxChunkBytes=${result.maxChunkBytes}`,
    `stagedAuthorCount=${result.stagedAuthorCount}`,
    `finalAuthorCount=${result.finalAuthorCount}`,
    `result=${result.result}`,
  ].join(" ");
}

function formatLimitDecisions(limits) {
  return [
    "limits",
    `ordinaryRpcBytes=${limits.ordinaryRpcBytes}`,
    `authorPageSize=${limits.authorPageSize}`,
    `tagPageSize=${limits.tagPageSize}`,
    `identityBatchSize=${limits.identityBatchSize}`,
    `mutationBatchSize=${limits.mutationBatchSize}`,
    `cursorBytes=${limits.cursorBytes}`,
    `transferChunkBytes=${limits.transferChunkBytes}`,
    `transferChunkAuthors=${limits.transferChunkAuthors}`,
    `singleFileBytes=${limits.singleFileBytes}`,
  ].join(" ");
}

export function formatBenchmarkReport(results) {
  return [
    "Cocoon synthetic blacklist scale benchmark",
    ...results.map(formatScaleResult),
    formatLimitDecisions(BENCHMARK_LIMIT_DECISIONS),
    "note=staging/finalize measurements are fake-indexeddb prototypes, not production transfer validation",
  ].join("\n");
}
