import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  type BlacklistState,
} from "../content/blacklist-state.ts";
import type {
  BlacklistTransferAuthor,
  BlacklistTransferEnvelope,
} from "../core/blacklist-rpc-contract.ts";
import {
  createBlacklistTransferEnvelope,
  planBlacklistTransferMerge,
  planBlacklistTransferReplace,
} from "./blacklist-transfer-planner.ts";

const EXPORTED_AT = "2026-08-22T10:00:00.000Z";
const BLACKLISTED_AT = "2026-08-21T09:08:07.006Z";
const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);

function transferAuthor(
  platformId: string,
  userId: string,
  overrides: Partial<BlacklistTransferAuthor> = {},
): BlacklistTransferAuthor {
  return {
    platformId,
    userId,
    memberHashId: null,
    authorNameAtCapture: `Author ${userId}`,
    tagId: "default",
    blacklistedAt: BLACKLISTED_AT,
    blockSource: "direct",
    ...overrides,
  };
}

function envelope(
  authors: readonly BlacklistTransferAuthor[] = [],
  tags: BlacklistTransferEnvelope["tags"] = [
    { tagId: "default", name: "default" },
  ],
): BlacklistTransferEnvelope {
  return {
    product: "cocoon-blacklist",
    formatVersion: 1,
    exportedAt: EXPORTED_AT,
    schemaVersion: 5,
    authors,
    tags,
  };
}

function storedAuthor(
  platformId: string,
  userId: string,
  overrides: Partial<BlacklistState["authors"][number]> = {},
): BlacklistState["authors"][number] {
  return {
    platformId,
    userId,
    memberHashId: null,
    authorNameAtCapture: `Stored ${userId}`,
    tagId: "default",
    blacklistedAt: BLACKLISTED_AT,
    blockSource: "direct",
    ...overrides,
  };
}

test("AC-089 export creates only the exact v5 envelope and detached ordered records", () => {
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "reading", name: "Reading" },
    ],
    authors: [
      storedAuthor("zhihu", "z-user", { memberHashId: HASH_A }),
      storedAuthor("youtube", "z-user", { tagId: "reading" }),
    ],
  };

  const result = createBlacklistTransferEnvelope(state, EXPORTED_AT);

  deepStrictEqual(Object.keys(result), [
    "product",
    "formatVersion",
    "exportedAt",
    "schemaVersion",
    "authors",
    "tags",
  ]);
  deepStrictEqual(result, envelope(state.authors, state.tags));
  notStrictEqual(result.authors[0], state.authors[0]);
  notStrictEqual(result.tags[0], state.tags[0]);
});

test("AC-089 merge preserves local duplicate authors, remaps same-name tags, accepts cross-platform IDs, and orders deterministically", () => {
  const localDuplicate = storedAuthor("zhihu", "shared", {
    authorNameAtCapture: "Original name",
    tagId: "local-reading",
    blacklistedAt: "2020-01-02T03:04:05.006Z",
    blockSource: "upvoter",
  });
  const local: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "local-reading", name: "Reading" },
    ],
    authors: [localDuplicate],
  };
  const imported = envelope(
    [
      transferAuthor("zhihu", "shared", {
        authorNameAtCapture: "Must not overwrite",
        tagId: "import-reading",
        blacklistedAt: EXPORTED_AT,
      }),
      transferAuthor("youtube", "shared", { tagId: "import-reading" }),
      transferAuthor("zhihu", "new-user", {
        memberHashId: HASH_A,
        tagId: "new-tag",
      }),
    ],
    [
      { tagId: "default", name: "default" },
      { tagId: "import-reading", name: "READING" },
      { tagId: "new-tag", name: "New tag" },
    ],
  );

  const first = planBlacklistTransferMerge(local, imported);
  const second = planBlacklistTransferMerge(local, imported);

  strictEqual(first.status, "ready");
  deepStrictEqual(second, first);
  deepStrictEqual(first.state.tags, [
    ...local.tags,
    { tagId: "new-tag", name: "New tag" },
  ]);
  strictEqual(first.state.authors[0], localDuplicate);
  deepStrictEqual(first.state.authors, [
    localDuplicate,
    storedAuthor("youtube", "shared", {
      authorNameAtCapture: "Author shared",
      tagId: "local-reading",
    }),
    storedAuthor("zhihu", "new-user", {
      memberHashId: HASH_A,
      authorNameAtCapture: "Author new-user",
      tagId: "new-tag",
    }),
  ]);
  deepStrictEqual(local.authors, [localDuplicate]);
  strictEqual(imported.authors[1]?.tagId, "import-reading");
});

test("AC-089 merge rejects tag ID/name conflicts and every new same-platform identifier/alias collision without mutation", () => {
  const local: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "local-tag", name: "Local" },
    ],
    authors: [storedAuthor("zhihu", "local-user", { memberHashId: HASH_A })],
  };
  const cases: readonly BlacklistTransferEnvelope[] = [
    envelope([], [
      { tagId: "default", name: "default" },
      { tagId: "local-tag", name: "Different" },
    ]),
    envelope([transferAuthor("zhihu", HASH_A)]),
    envelope([transferAuthor("zhihu", "new-user", { memberHashId: HASH_A })]),
  ];

  for (const transfer of cases) {
    const result = planBlacklistTransferMerge(local, transfer);
    strictEqual(result.status, "conflict");
    strictEqual(result.state, local);
  }
});

test("AC-089 a duplicate local identity wins unchanged even when imported mutable fields and alias differ", () => {
  const existing = storedAuthor("zhihu", "same", { memberHashId: HASH_A });
  const local: BlacklistState = {
    ...createInitialState(),
    authors: [existing, storedAuthor("zhihu", "alias-owner", { memberHashId: HASH_B })],
  };
  const result = planBlacklistTransferMerge(local, envelope([
    transferAuthor("zhihu", "same", {
      memberHashId: HASH_B,
      authorNameAtCapture: "Changed",
      blacklistedAt: EXPORTED_AT,
      blockSource: "upvoter",
    }),
  ]));

  strictEqual(result.status, "unchanged");
  strictEqual(result.state, local);
  strictEqual(result.state.authors[0], existing);
});

test("AC-089 merge accepts cross-platform equal stable IDs while retaining same-platform isolation", () => {
  const local: BlacklistState = {
    ...createInitialState(),
    authors: [storedAuthor("zhihu", "same-id", { memberHashId: HASH_A })],
  };
  const result = planBlacklistTransferMerge(local, envelope([
    transferAuthor("youtube", "same-id"),
    transferAuthor("youtube", HASH_A),
  ]));

  strictEqual(result.status, "ready");
  deepStrictEqual(result.state.authors.map(({ platformId, userId }) => ({
    platformId,
    userId,
  })), [
    { platformId: "zhihu", userId: "same-id" },
    { platformId: "youtube", userId: "same-id" },
    { platformId: "youtube", userId: HASH_A },
  ]);
});

test("AC-089 replace is a pure exact ordered v5 projection and never retains local state", () => {
  const transfer = envelope(
    [
      transferAuthor("youtube", "second", { tagId: "work" }),
      transferAuthor("zhihu", "first", { memberHashId: HASH_A }),
    ],
    [
      { tagId: "default", name: "default" },
      { tagId: "work", name: "Work" },
    ],
  );

  const result = planBlacklistTransferReplace(transfer);

  deepStrictEqual(result, {
    schemaVersion: 5,
    tags: transfer.tags,
    authors: transfer.authors,
  });
  notStrictEqual(result.tags, transfer.tags);
  notStrictEqual(result.authors, transfer.authors);
  notStrictEqual(result.tags[0], transfer.tags[0]);
  notStrictEqual(result.authors[0], transfer.authors[0]);
});
