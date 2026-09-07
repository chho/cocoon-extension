import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { IDBKeyRange as FakeIDBKeyRange, indexedDB } from "fake-indexeddb";

import {
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  authorKey,
  createMetadata,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  openBlacklistDatabase,
  requestResult,
  transactionDone,
} from "../src/background/blacklist-idb-schema.ts";
import {
  queryAuthorsPage,
  queryIdentityMatches,
  querySummary,
} from "../src/background/blacklist-repository-query.ts";
import {
  BENCHMARK_LIMIT_DECISIONS,
  createDatabaseBenchmarkMetrics,
  createSyntheticAuthorQuery,
  createSyntheticIdentityQueries,
  createSyntheticTransfer,
  formatBenchmarkReport,
  splitAuthorChunks,
  utf8Bytes,
  validateSyntheticTransfer,
} from "./lib/blacklist-scale-benchmark.mjs";

Object.defineProperty(globalThis, "IDBKeyRange", {
  configurable: true,
  value: FakeIDBKeyRange,
});

const SCALE_VALUES = [33_524, 100_000];
const SESSION_ID = "synthetic-benchmark-session";
const MAX_PEAK_RSS_BYTES = 1024 * 1024 * 1024;
const MAX_MEMORY_PHASE_MS = 10_000;
const MAX_IDB_PHASE_MS = 120_000;

function trace(phase) {
  if (process.env.COCOON_BENCHMARK_TRACE === "1") process.stderr.write(`phase=${phase}\n`);
}

function sampleMemory(tracker) {
  const memory = process.memoryUsage();
  tracker.peakRssBytes = Math.max(tracker.peakRssBytes, memory.rss);
  tracker.peakHeapBytes = Math.max(tracker.peakHeapBytes, memory.heapUsed);
}

function collectGarbage(tracker) {
  globalThis.gc?.();
  sampleMemory(tracker);
}

function measureSync(tracker, operation) {
  const started = performance.now();
  const value = operation();
  const duration = performance.now() - started;
  sampleMemory(tracker);
  return { value, duration };
}

async function measureAsync(tracker, operation) {
  const started = performance.now();
  const value = await operation();
  const duration = performance.now() - started;
  sampleMemory(tracker);
  return { value, duration };
}

function measureDatabasePhase(scale, phase, tracker, operation) {
  trace(`${phase}-${scale}`);
  return measureAsync(tracker, operation);
}

function createV1Database(databaseName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onerror = () => reject(open.error ?? new Error("Unable to create benchmark database."));
    open.onupgradeneeded = () => {
      const authors = open.result.createObjectStore(BLACKLIST_STORE_NAMES.authors, {
        keyPath: "authorKey",
      });
      authors.createIndex("by-platform-user", ["platformId", "userId"], { unique: true });
      authors.createIndex("by-tag", "tagId", { unique: false });
      authors.createIndex("by-order", "order", { unique: true });
      const identifiers = open.result.createObjectStore(BLACKLIST_STORE_NAMES.identifiers, {
        keyPath: "identifierKey",
      });
      identifiers.createIndex("by-platform-identifier", ["platformId", "identifier"], {
        unique: true,
      });
      identifiers.createIndex("by-author", "authorKey", { unique: false });
      const tags = open.result.createObjectStore(BLACKLIST_STORE_NAMES.tags, { keyPath: "tagId" });
      tags.createIndex("by-name", "nameKey", { unique: true });
      tags.createIndex("by-order", "order", { unique: true });
      open.result.createObjectStore(BLACKLIST_STORE_NAMES.metadata, { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
  });
}

async function seedV1Database(databaseName, state) {
  const database = await createV1Database(databaseName);
  try {
    const transaction = database.transaction(
      [
        BLACKLIST_STORE_NAMES.authors,
        BLACKLIST_STORE_NAMES.identifiers,
        BLACKLIST_STORE_NAMES.tags,
        BLACKLIST_STORE_NAMES.metadata,
      ],
      "readwrite",
    );
    state.tags.forEach((tag, order) => {
      transaction.objectStore(BLACKLIST_STORE_NAMES.tags).add(createStoredTag(tag, order));
    });
    state.authors.forEach((author, order) => {
      transaction.objectStore(BLACKLIST_STORE_NAMES.authors).add({
        authorKey: authorKey(author.platformId, author.userId),
        order,
        ...author,
      });
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.identifiers)
        .add(createStoredIdentifier(author, author.userId));
      if (author.memberHashId !== null) {
        transaction
          .objectStore(BLACKLIST_STORE_NAMES.identifiers)
          .add(createStoredIdentifier(author, author.memberHashId));
      }
    });
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).add(createMetadata(state, 0));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function stagePrototypeHeader(database, transfer) {
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.importSessions, BLACKLIST_STORE_NAMES.importTags],
    "readwrite",
  );
  transaction.objectStore(BLACKLIST_STORE_NAMES.importSessions).put({
    sessionId: SESSION_ID,
    formatVersion: 1,
    schemaVersion: 5,
    authorCount: transfer.authors.length,
    tagCount: transfer.tags.length,
  });
  transfer.tags.forEach((tag, index) => {
    transaction.objectStore(BLACKLIST_STORE_NAMES.importTags).put({
      sessionId: SESSION_ID,
      index,
      nameKey: tag.name.toLowerCase(),
      ...tag,
    });
  });
  await transactionDone(transaction);
}

async function stagePrototypeChunk(database, chunk, chunkIndex, offset) {
  const transaction = database.transaction(
    [
      BLACKLIST_STORE_NAMES.importAuthors,
      BLACKLIST_STORE_NAMES.importIdentifiers,
      BLACKLIST_STORE_NAMES.importChunks,
    ],
    "readwrite",
  );
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.importAuthors);
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.importIdentifiers);
  chunk.authors.forEach((author, localIndex) => {
    const index = offset + localIndex;
    authors.put({ sessionId: SESSION_ID, index, ...author });
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier !== null) {
        identifiers.put({
          sessionId: SESSION_ID,
          platformId: author.platformId,
          identifier,
          index,
        });
      }
    }
  });
  transaction.objectStore(BLACKLIST_STORE_NAMES.importChunks).put({
    sessionId: SESSION_ID,
    kind: "authors",
    chunkIndex,
    authorCount: chunk.authors.length,
    byteLength: chunk.bytes,
  });
  await transactionDone(transaction);
}

async function stagePrototype(database, transfer, chunks) {
  await stagePrototypeHeader(database, transfer);
  let offset = 0;
  for (const [chunkIndex, chunk] of chunks.entries()) {
    await stagePrototypeChunk(database, chunk, chunkIndex, offset);
    offset += chunk.authors.length;
  }
}

function stagedAuthor(record) {
  return {
    platformId: record.platformId,
    userId: record.userId,
    memberHashId: record.memberHashId,
    authorNameAtCapture: record.authorNameAtCapture,
    tagId: record.tagId,
    blacklistedAt: record.blacklistedAt,
    blockSource: record.blockSource,
  };
}

async function readPrototypeTags(database) {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.importTags, "readonly");
  const raw = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importTags)
      .index("by-session")
      .getAll(SESSION_ID),
  );
  await transactionDone(transaction);
  return raw
    .sort((left, right) => left.index - right.index)
    .map(({ tagId, name }) => ({ tagId, name }));
}

function writePrototypeMetadata(transaction, authorCount, tagCount) {
  transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).put({
    key: BLACKLIST_METADATA_KEY,
    migrationComplete: true,
    logicalSchemaVersion: 5,
    revision: 1,
    authorCount,
    tagCount,
    nextAuthorOrder: authorCount,
    nextTagOrder: tagCount,
  });
}

function copyPrototypeAuthors(options) {
  const { transaction, validTagIds, expectedAuthorCount, tagCount } = options;
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.authors);
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  const identityOwners = new Set();
  let authorCount = 0;
  const request = transaction
    .objectStore(BLACKLIST_STORE_NAMES.importAuthors)
    .index("by-session")
    .openCursor(IDBKeyRange.only(SESSION_ID));
  request.onerror = () => transaction.abort();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      if (authorCount === expectedAuthorCount) {
        writePrototypeMetadata(transaction, authorCount, tagCount);
      } else {
        transaction.abort();
      }
      return;
    }
    const record = cursor.value;
    const author = stagedAuthor(record);
    if (!validTagIds.has(author.tagId)) {
      transaction.abort();
      return;
    }
    for (const identifier of [author.userId, author.memberHashId]) {
      if (identifier === null) continue;
      const key = JSON.stringify([author.platformId, identifier]);
      if (identityOwners.has(key)) {
        transaction.abort();
        return;
      }
      identityOwners.add(key);
      identifiers.put(createStoredIdentifier(author, identifier));
    }
    authors.put(createStoredAuthor(author, record.index));
    authorCount += 1;
    cursor.continue();
  };
  return () => authorCount;
}

async function finalizePrototype(database, expectedAuthorCount) {
  const tags = await readPrototypeTags(database);
  const transaction = database.transaction(
    [
      BLACKLIST_STORE_NAMES.authors,
      BLACKLIST_STORE_NAMES.identifiers,
      BLACKLIST_STORE_NAMES.tags,
      BLACKLIST_STORE_NAMES.metadata,
      BLACKLIST_STORE_NAMES.importAuthors,
    ],
    "readwrite",
  );
  transaction.objectStore(BLACKLIST_STORE_NAMES.authors).clear();
  transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers).clear();
  transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).clear();
  const liveTags = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  liveTags.clear();
  tags.forEach((tag, order) => liveTags.put(createStoredTag(tag, order)));
  const authorCount = copyPrototypeAuthors({
    transaction,
    validTagIds: new Set(tags.map(({ tagId }) => tagId)),
    expectedAuthorCount,
    tagCount: tags.length,
  });
  await transactionDone(transaction);
  return authorCount();
}

async function reopenDatabase(database) {
  const databaseName = database.name;
  database.close();
  return openBlacklistDatabase(indexedDB, databaseName);
}

async function stagedCount(database) {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.importAuthors, "readonly");
  const count = await requestResult(
    transaction
      .objectStore(BLACKLIST_STORE_NAMES.importAuthors)
      .index("by-session")
      .count(SESSION_ID),
  );
  await transactionDone(transaction);
  return count;
}

function removeDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to remove benchmark database."));
    request.onsuccess = () => resolve();
  });
}

function benchmarkResult(result) {
  const durations = [result.fileTextMs, result.jsonParseMs, result.strictValidationMs];
  const idbDurations = [
    result.idbV1SeedMs,
    result.idbUpgradeMs,
    result.substringQueryMs,
    result.stagingPrototypeMs,
    result.finalizePrototypeMs,
  ];
  return result.utf8Bytes <= BENCHMARK_LIMIT_DECISIONS.singleFileBytes &&
    result.peakRssBytes <= MAX_PEAK_RSS_BYTES &&
    durations.every((duration) => duration <= MAX_MEMORY_PHASE_MS) &&
    idbDurations.every((duration) => duration <= MAX_IDB_PHASE_MS) &&
    result.pageCount === 50 &&
    result.substringCount === 1 &&
    result.identityMatchCount === 100 &&
    result.stagedAuthorCount === result.scale &&
    result.finalAuthorCount === result.scale
    ? "completed"
    : "stop";
}

async function prepareTransferBenchmark(scale, tracker) {
  const generated = measureSync(tracker, () => createSyntheticTransfer(scale));
  const serialized = measureSync(tracker, () => JSON.stringify(generated.value));
  const byteLength = utf8Bytes(serialized.value);
  const textRead = await measureAsync(tracker, async () => new Blob([serialized.value]).text());
  const parsed = measureSync(tracker, () => JSON.parse(textRead.value));
  collectGarbage(tracker);
  const validated = measureSync(tracker, () => validateSyntheticTransfer(parsed.value));
  if (!validated.value.valid || validated.value.authorCount !== scale) {
    throw new Error("Synthetic transfer strict validation failed.");
  }
  const state = {
    schemaVersion: 5,
    tags: parsed.value.tags,
    authors: parsed.value.authors,
  };
  const chunks = splitAuthorChunks(state.authors);
  return {
    state,
    chunks,
    metrics: {
      utf8Bytes: byteLength,
      generationMs: generated.duration + serialized.duration,
      fileTextMs: textRead.duration,
      jsonParseMs: parsed.duration,
      strictValidationMs: validated.duration,
      chunkCount: chunks.length,
      maxChunkBytes: Math.max(...chunks.map(({ bytes }) => bytes)),
    },
  };
}

async function runDatabaseBenchmark(scale, prepared, tracker) {
  const { state, chunks } = prepared;
  const databaseName = `cocoon-synthetic-benchmark-${scale}`;
  await removeDatabase(databaseName);
  let database = null;
  try {
    const seeded = await measureDatabasePhase(scale, "seed", tracker, () =>
      seedV1Database(databaseName, state),
    );
    const upgraded = await measureDatabasePhase(scale, "upgrade", tracker, () =>
      openBlacklistDatabase(indexedDB, databaseName),
    );
    database = upgraded.value;
    const authorPage = await measureDatabasePhase(scale, "page", tracker, () =>
      queryAuthorsPage(database, createSyntheticAuthorQuery("")),
    );
    const search = `author ${String(scale - 1).padStart(6, "0")}`;
    const substring = await measureDatabasePhase(scale, "substring", tracker, () =>
      queryAuthorsPage(database, createSyntheticAuthorQuery(search)),
    );
    const identities = createSyntheticIdentityQueries(state);
    const identityBatch = await measureDatabasePhase(scale, "identity", tracker, () =>
      queryIdentityMatches(database, { revision: null, identities }),
    );
    const staged = await measureDatabasePhase(scale, "stage", tracker, () =>
      stagePrototype(database, state, chunks),
    );
    database = await reopenDatabase(database);
    const stagedAuthorCount = await stagedCount(database);
    const finalized = await measureDatabasePhase(scale, "finalize", tracker, () =>
      finalizePrototype(database, scale),
    );
    const finalSummary = await querySummary(database);
    return createDatabaseBenchmarkMetrics({
      seeded,
      upgraded,
      authorPage,
      substring,
      identityBatch,
      staged,
      finalized,
      identities,
      stagedAuthorCount,
      finalAuthorCount: finalSummary.authorCount,
    });
  } finally {
    database?.close();
    await removeDatabase(databaseName);
  }
}

async function runScale(scale) {
  const tracker = { peakRssBytes: 0, peakHeapBytes: 0 };
  collectGarbage(tracker);
  trace("prepare");
  const prepared = await prepareTransferBenchmark(scale, tracker);
  trace("database");
  const database = await runDatabaseBenchmark(scale, prepared, tracker);
  trace("complete");
  collectGarbage(tracker);
  const result = {
    scale,
    ...prepared.metrics,
    ...database,
    peakRssBytes: tracker.peakRssBytes,
    peakHeapBytes: tracker.peakHeapBytes,
  };
  return { ...result, result: benchmarkResult(result) };
}

async function runMemoryScale(scale) {
  const tracker = { peakRssBytes: 0, peakHeapBytes: 0 };
  collectGarbage(tracker);
  const prepared = await prepareTransferBenchmark(scale, tracker);
  collectGarbage(tracker);
  return {
    scale,
    ...prepared.metrics,
    peakRssBytes: tracker.peakRssBytes,
    peakHeapBytes: tracker.peakHeapBytes,
    result: "memory-completed",
  };
}

function childArguments(scale, memoryOnly) {
  return [
    "--expose-gc",
    import.meta.filename,
    "--scale",
    String(scale),
    ...(memoryOnly ? ["--memory-only"] : []),
  ];
}

function runParent(memoryOnly) {
  const results = SCALE_VALUES.map((scale) => {
    const child = spawnSync(process.execPath, childArguments(scale, memoryOnly), {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (child.status !== 0) {
      throw new Error(`Synthetic benchmark child failed at scale ${scale}: ${child.stderr.trim()}`);
    }
    return JSON.parse(child.stdout);
  });
  if (memoryOnly) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(formatBenchmarkReport(results));
  if (results.some(({ result }) => result !== "completed")) process.exitCode = 1;
}

const scaleFlag = process.argv.indexOf("--scale");
const memoryOnly = process.argv.includes("--memory-only");
if (scaleFlag >= 0) {
  const scale = Number(process.argv[scaleFlag + 1]);
  if (!SCALE_VALUES.includes(scale)) throw new Error("Unsupported synthetic benchmark scale.");
  const result = memoryOnly ? await runMemoryScale(scale) : await runScale(scale);
  process.stdout.write(JSON.stringify(result));
} else {
  runParent(memoryOnly);
}
