import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  BENCHMARK_LIMIT_DECISIONS,
  createSyntheticTransfer,
  formatBenchmarkReport,
  splitAuthorChunks,
  utf8Bytes,
  validateSyntheticTransfer,
} from "./blacklist-scale-benchmark.mjs";

test("BUG-016 benchmark fixtures use valid deterministic synthetic fields and reject identity conflicts", () => {
  const transfer = createSyntheticTransfer(8);
  deepStrictEqual(validateSyntheticTransfer(transfer), {
    valid: true,
    authorCount: 8,
    identifierCount: 9,
  });
  strictEqual(JSON.stringify(transfer), JSON.stringify(createSyntheticTransfer(8)));

  const duplicate = {
    ...transfer,
    authors: [...transfer.authors, { ...transfer.authors[0] }],
  };
  deepStrictEqual(validateSyntheticTransfer(duplicate), {
    valid: false,
    authorCount: 0,
    identifierCount: 0,
  });
  deepStrictEqual(validateSyntheticTransfer({ ...transfer, extra: true }), {
    valid: false,
    authorCount: 0,
    identifierCount: 0,
  });
});

test("BUG-016 chunk prototype honors both author-count and UTF-8 byte boundaries", () => {
  const transfer = createSyntheticTransfer(1_001);
  const chunks = splitAuthorChunks(transfer.authors);
  deepStrictEqual(
    chunks.map(({ authors }) => authors.length),
    [500, 500, 1],
  );
  strictEqual(
    chunks.every(
      ({ authors, bytes }) =>
        authors.length <= BENCHMARK_LIMIT_DECISIONS.transferChunkAuthors &&
        bytes <= BENCHMARK_LIMIT_DECISIONS.transferChunkBytes &&
        bytes === utf8Bytes(JSON.stringify(authors)),
    ),
    true,
  );
});

test("BUG-016 memory-only benchmark reports full synthetic scale without waiting for fake IndexedDB", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      new URL("../benchmark-blacklist-scale.mjs", import.meta.url).pathname,
      "--scale",
      "33524",
      "--memory-only",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  strictEqual(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  strictEqual(metrics.scale, 33_524);
  strictEqual(metrics.utf8Bytes, 7_670_490);
  strictEqual(metrics.result, "memory-completed");
  strictEqual(result.stdout.includes("synthetic-user-"), false);
});

test("BUG-016 report exposes only bounded measurements, counts, decisions, and prototype caveat", () => {
  const report = formatBenchmarkReport([
    {
      scale: 33_524,
      utf8Bytes: 7_000_000,
      generationMs: 1.25,
      fileTextMs: 2.25,
      jsonParseMs: 3.25,
      strictValidationMs: 4.25,
      peakRssBytes: 200 * 1024 * 1024,
      peakHeapBytes: 100 * 1024 * 1024,
      idbV1SeedMs: 5.25,
      idbUpgradeMs: 6.25,
      authorPageMs: 7.25,
      substringQueryMs: 8.25,
      identityBatchMs: 9.25,
      stagingPrototypeMs: 10.25,
      finalizePrototypeMs: 11.25,
      pageCount: 50,
      substringCount: 1,
      identityRequestCount: 200,
      identityMatchCount: 100,
      chunkCount: 68,
      maxChunkBytes: 120_000,
      stagedAuthorCount: 33_524,
      finalAuthorCount: 33_524,
      result: "completed",
      ignoredAuthorValue: "must-not-appear",
    },
  ]);

  match(report, /scale=33524 utf8Bytes=7000000 generationMs=1\.3/);
  match(report, /singleFileBytes=33554432/);
  match(report, /not production transfer validation/);
  strictEqual(report.includes("must-not-appear"), false);
  strictEqual(report.includes("synthetic-user-"), false);
  strictEqual(report.includes("Synthetic Author"), false);
});
