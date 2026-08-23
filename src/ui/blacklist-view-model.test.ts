import { deepStrictEqual, doesNotMatch, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type {
  BlacklistAuthorDto,
  BlacklistSnapshotDto,
} from "../core/blacklist-rpc-contract.ts";
import {
  formatLocalTime,
  formatSource,
  managementResults,
  popupResults,
  summarizeBlacklist,
  virtualRange,
} from "./blacklist-view-model.ts";

const INTERNAL_HASH = "a".repeat(32);

function author(
  userId: string,
  authorName: string,
  tagId: string,
  blacklistedAt: string | null,
  source: BlacklistAuthorDto["source"] = "direct",
): BlacklistAuthorDto {
  return {
    userId,
    memberHashId: userId === "internal-newest" ? INTERNAL_HASH : null,
    authorName,
    tagId,
    blacklistedAt,
    source,
  };
}

const snapshot: BlacklistSnapshotDto = {
  tags: [
    { tagId: "default", name: "default", isDefault: true },
    { tagId: "reading", name: "Reading", isDefault: false },
    { tagId: "work", name: "WoRk", isDefault: false },
  ],
  authors: [
    author("internal-unknown-z", "Zulu", "default", null),
    author("internal-oldest", "Alice", "reading", "2024-01-01T00:00:00.000Z"),
    author("internal-newest", "Bravo", "work", "2026-01-01T00:00:00.000Z", "upvoter"),
    author("internal-middle", "CHARLIE", "reading", "2025-01-01T00:00:00.000Z"),
    author("internal-unknown-a", "Delta", "work", null),
    author("internal-fourth", "Echo", "default", "2024-06-01T00:00:00.000Z"),
  ],
};

function names(items: ReturnType<typeof popupResults>): string[] {
  return items.map(({ author: value }) => value.authorName);
}

test("POPUP-004 recent results return five valid/null records with deterministic unknown times", () => {
  deepStrictEqual(names(popupResults(snapshot, "")), [
    "Bravo",
    "CHARLIE",
    "Echo",
    "Alice",
    "Delta",
  ]);
});

test("POPUP-004 author and tag search are local and case-insensitive", () => {
  deepStrictEqual(names(popupResults(snapshot, "  char  ")), ["CHARLIE"]);
  deepStrictEqual(names(popupResults(snapshot, "READING")), ["Alice", "CHARLIE"]);
  deepStrictEqual(names(popupResults(snapshot, "work")), ["Bravo", "Delta"]);
});

test("MANAGE-001 tag filtering composes with case-insensitive author search", () => {
  deepStrictEqual(
    names(managementResults(snapshot, "li", "reading", "desc")),
    ["CHARLIE", "Alice"],
  );
  deepStrictEqual(names(managementResults(snapshot, "", "work", "desc")), [
    "Bravo",
    "Delta",
  ]);
});

test("MANAGE-001 timestamp ascending and descending keep null times last deterministically", () => {
  deepStrictEqual(names(managementResults(snapshot, "", null, "asc")), [
    "Alice",
    "Echo",
    "CHARLIE",
    "Bravo",
    "Delta",
    "Zulu",
  ]);
  deepStrictEqual(names(managementResults(snapshot, "", null, "desc")), [
    "Bravo",
    "CHARLIE",
    "Echo",
    "Alice",
    "Delta",
    "Zulu",
  ]);
});

test("POPUP-003/004 source labels, count summaries, and times are display-safe", () => {
  strictEqual(formatSource("direct"), "手动屏蔽");
  strictEqual(formatSource("upvoter"), "来自点赞者");
  strictEqual(formatLocalTime(null), "时间未知");
  strictEqual(formatLocalTime("not-a-time"), "时间未知");
  const validTime = formatLocalTime("2026-01-01T00:00:00.000Z", "zh-CN");
  strictEqual(validTime === "时间未知", false);
  deepStrictEqual(summarizeBlacklist(snapshot), {
    authorCount: 6,
    tagCount: 3,
  });

  const displayOutput = JSON.stringify({
    direct: formatSource("direct"),
    upvoter: formatSource("upvoter"),
    time: validTime,
    summary: summarizeBlacklist(snapshot),
  });
  doesNotMatch(displayOutput, /internal-newest/);
  doesNotMatch(displayOutput, new RegExp(INTERNAL_HASH));
});

test("MANAGE-001 virtual range clamps an overscrolled viewport to loaded rows", () => {
  deepStrictEqual(virtualRange(100_000, 500, 50), {
    start: 50,
    end: 50,
    offset: 3_200,
    totalHeight: 3_200,
  });
});
