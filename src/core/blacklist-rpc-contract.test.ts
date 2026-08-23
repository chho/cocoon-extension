import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  BLACKLIST_RPC_VERSION,
  MAX_BLACKLIST_TRANSFER_AUTHORS,
  MAX_BLACKLIST_TRANSFER_BYTES,
  MAX_BLACKLIST_TRANSFER_TAGS,
  blacklistJsonByteLength,
  createBlacklistRpcRequest,
  createBlacklistRpcResponse,
  createBlacklistTransferFilename,
  parseBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  parseBlacklistTransferEnvelope,
  parseBlacklistTransferJson,
  serializeBlacklistTransfer,
  type BlacklistSnapshotDto,
  type BlacklistTransferAuthor,
  type BlacklistTransferEnvelope,
} from "./blacklist-rpc-contract.ts";

const TIME = "2026-08-21T10:00:00.000Z";
const HASH = "a".repeat(32);

function author(
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
    blacklistedAt: TIME,
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
    exportedAt: TIME,
    schemaVersion: 5,
    authors,
    tags,
  };
}

function changed(
  transfer: BlacklistTransferEnvelope,
  changes: Record<string, unknown>,
): unknown {
  return { ...transfer, ...changes };
}

function withoutKey(value: object, key: string): unknown {
  const clone: Record<string, unknown> = { ...value };
  delete clone[key];
  return clone;
}

const NULL_ALIAS_SNAPSHOT: BlacklistSnapshotDto = {
  authors: [{
    platformId: "zhihu",
    userId: "author-token",
    memberHashId: null,
    authorName: "Author",
    tagId: "default",
    blacklistedAt: TIME,
    source: "direct",
  }],
  tags: [{ tagId: "default", name: "default", isDefault: true }],
};

test("AC-089 parses and serializes only the exact transfer envelope and filename", () => {
  const transfer = envelope([
    author("zhihu", "zhihu-user", { memberHashId: HASH }),
    author("youtube", "zhihu-user"),
  ]);
  deepStrictEqual(parseBlacklistTransferEnvelope(transfer), {
    status: "valid",
    transfer,
  });
  const json = serializeBlacklistTransfer(transfer);
  strictEqual(typeof json, "string");
  deepStrictEqual(parseBlacklistTransferJson(json ?? ""), {
    status: "valid",
    transfer,
  });
  strictEqual(createBlacklistTransferFilename(TIME), "cocoon-blacklist-2026-08-21.json");
  strictEqual(createBlacklistTransferFilename("2026-08-21"), null);

  for (const invalid of [
    changed(transfer, { product: "other" }),
    changed(transfer, { formatVersion: 2 }),
    changed(transfer, { schemaVersion: 4 }),
    changed(transfer, { exportedAt: "2026-08-21T10:00:00Z" }),
    changed(transfer, { exportedAt: "2026-02-30T10:00:00.000Z" }),
    { ...transfer, extra: true },
    { product: transfer.product, formatVersion: 1 },
    null,
    [],
  ]) {
    strictEqual(parseBlacklistTransferEnvelope(invalid).status, "invalid");
  }
  strictEqual(parseBlacklistTransferJson("{").status, "invalid");
});

test("AC-089 strictly validates transfer author/tag fields, limits, default, and tag references", () => {
  const validAuthor = author("zhihu", "user", { memberHashId: HASH });
  const validTag = { tagId: "tag", name: "Tag" };
  const authorCases: readonly unknown[] = [
    { ...validAuthor, extra: true },
    withoutKey(validAuthor, "platformId"),
    withoutKey(validAuthor, "blockSource"),
    { ...validAuthor, platformId: "Zhihu" },
    { ...validAuthor, platformId: `a${"b".repeat(64)}` },
    { ...validAuthor, userId: "x".repeat(513) },
    { ...validAuthor, userId: "A".repeat(32) },
    { ...validAuthor, memberHashId: "A".repeat(32) },
    { ...validAuthor, memberHashId: validAuthor.userId },
    { ...validAuthor, authorNameAtCapture: "😀".repeat(501) },
    { ...validAuthor, tagId: "x".repeat(513) },
    { ...validAuthor, blacklistedAt: "invalid" },
    { ...validAuthor, blockSource: "other" },
    { ...validAuthor, blockSource: "upvoter", blacklistedAt: null },
    { ...author("youtube", "user"), memberHashId: HASH },
  ];
  for (const invalidAuthor of authorCases) {
    strictEqual(
      parseBlacklistTransferEnvelope(envelope([
        invalidAuthor as BlacklistTransferAuthor,
      ])).status,
      "invalid",
    );
  }

  const tagCases: readonly unknown[] = [
    { ...validTag, extra: true },
    withoutKey(validTag, "name"),
    { ...validTag, tagId: "" },
    { ...validTag, tagId: "x".repeat(513) },
    { ...validTag, name: "" },
    { ...validTag, name: "😀".repeat(31) },
  ];
  for (const invalidTag of tagCases) {
    strictEqual(parseBlacklistTransferEnvelope(envelope([], [
      { tagId: "default", name: "default" },
      invalidTag as BlacklistTransferEnvelope["tags"][number],
    ])).status, "invalid");
  }

  const exactLimits = envelope(
    [author(`a${"b".repeat(63)}`, "😀".repeat(512), {
      authorNameAtCapture: "😀".repeat(500),
      tagId: "😀".repeat(512),
    })],
    [
      { tagId: "default", name: "default" },
      { tagId: "😀".repeat(512), name: "😀".repeat(30) },
    ],
  );
  strictEqual(parseBlacklistTransferEnvelope(exactLimits).status, "valid");

  for (const invalid of [
    envelope([], []),
    envelope([], [{ tagId: "default", name: "Default" }]),
    envelope([], [
      { tagId: "default", name: "default" },
      { tagId: "default", name: "Other" },
    ]),
    envelope([], [
      { tagId: "default", name: "default" },
      { tagId: "other", name: "DEFAULT" },
    ]),
    envelope([author("zhihu", "user", { tagId: "missing" })]),
  ]) {
    strictEqual(parseBlacklistTransferEnvelope(invalid).status, "invalid");
  }
});

test("AC-090 transfer collisions are platform-scoped and include user/hash aliases", () => {
  for (const authors of [
    [author("zhihu", "same"), author("zhihu", "same")],
    [
      author("zhihu", "first", { memberHashId: HASH }),
      author("zhihu", HASH),
    ],
    [
      author("zhihu", "first", { memberHashId: HASH }),
      author("zhihu", "second", { memberHashId: HASH }),
    ],
  ]) {
    strictEqual(parseBlacklistTransferEnvelope(envelope(authors)).status, "invalid");
  }

  const crossPlatform = envelope([
    author("zhihu", "same", { memberHashId: HASH }),
    author("youtube", "same"),
    author("youtube", HASH),
  ]);
  strictEqual(parseBlacklistTransferEnvelope(crossPlatform).status, "valid");
  strictEqual(parseBlacklistTransferEnvelope(envelope([
    author("youtube", "A".repeat(32)),
  ])).status, "valid");
});

test("AC-089 author and tag count boundaries use generated compact fixtures", () => {
  const maxAuthors = Array.from(
    { length: MAX_BLACKLIST_TRANSFER_AUTHORS },
    (_, index) => author("p", `u${index}`, { authorNameAtCapture: "" }),
  );
  strictEqual(parseBlacklistTransferEnvelope(envelope(maxAuthors)).status, "valid");
  strictEqual(parseBlacklistTransferEnvelope(envelope([
    ...maxAuthors,
    author("p", "overflow", { authorNameAtCapture: "" }),
  ])).status, "invalid");

  const maxTags = [
    { tagId: "default", name: "default" },
    ...Array.from({ length: MAX_BLACKLIST_TRANSFER_TAGS - 1 }, (_, index) => ({
      tagId: `t${index}`,
      name: `T${index}`,
    })),
  ];
  strictEqual(parseBlacklistTransferEnvelope(envelope([], maxTags)).status, "valid");
  strictEqual(parseBlacklistTransferEnvelope(envelope([], [
    ...maxTags,
    { tagId: "overflow", name: "Overflow" },
  ])).status, "invalid");
});

function exactByteBoundaryTransfer(): BlacklistTransferEnvelope {
  const authors = Array.from(
    { length: MAX_BLACKLIST_TRANSFER_AUTHORS },
    (_, index) => author("p", `u${index}`, { authorNameAtCapture: "" }),
  );
  const transfer = envelope(authors);
  let remaining = MAX_BLACKLIST_TRANSFER_BYTES - blacklistJsonByteLength(
    JSON.stringify(transfer),
  );
  if (remaining < 0 || remaining > authors.length * 500) {
    throw new Error("Generated transfer cannot reach the byte boundary.");
  }
  for (let index = authors.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const current = authors[index];
    if (!current) throw new Error("Missing generated author.");
    const length = Math.min(500, remaining);
    authors[index] = { ...current, authorNameAtCapture: "x".repeat(length) };
    remaining -= length;
  }
  strictEqual(blacklistJsonByteLength(JSON.stringify(transfer)), MAX_BLACKLIST_TRANSFER_BYTES);
  return transfer;
}

test("AC-089 accepts an exact 8 MiB file envelope and rejects one byte over", () => {
  const transfer = exactByteBoundaryTransfer();
  const json = JSON.stringify(transfer);
  strictEqual(parseBlacklistTransferEnvelope(transfer).status, "valid");
  strictEqual(parseBlacklistTransferJson(json).status, "valid");
  strictEqual(serializeBlacklistTransfer(transfer), json);
  strictEqual(parseBlacklistTransferJson(`${json} `).status, "too-large");
});

test("AC-089 damaged non-serializable envelopes are invalid rather than misclassified as oversized", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  strictEqual(parseBlacklistTransferEnvelope(cyclic).status, "invalid");
});

test("AC-090 strict requests use compound identities and platform-scoped duplicate checks", () => {
  const validCrossPlatform = createBlacklistRpcRequest("remove-many", {
    identities: [
      { platformId: "zhihu", userId: "same" },
      { platformId: "youtube", userId: "same" },
    ],
  });
  strictEqual(parseBlacklistRpcRequest(validCrossPlatform), validCrossPlatform);

  for (const invalid of [
    createBlacklistRpcRequest("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "same" },
        { platformId: "zhihu", userId: "same" },
      ],
    }),
    {
      ...createBlacklistRpcRequest("remove-one", {
        identity: { platformId: "zhihu", userId: "user" },
      }),
      input: {
        identity: { platformId: "zhihu", userId: "user" },
        extra: true,
      },
    },
    createBlacklistRpcRequest("remove-one", {
      identity: { platformId: "zhihu", userId: "x".repeat(513) },
    }),
  ]) {
    strictEqual(parseBlacklistRpcRequest(invalid), null);
  }
});

test("AC-089 transfer requests/responses enforce exact shape and the full 8 MiB RPC cap", () => {
  const transfer = envelope([author("zhihu", "user")]);
  const request = createBlacklistRpcRequest("import-merge", { transfer });
  strictEqual(parseBlacklistRpcRequest(request), request);
  strictEqual(parseBlacklistRpcRequest({
    ...request,
    input: { transfer, extra: true },
  }), null);
  strictEqual(parseBlacklistRpcRequest({
    ...request,
    input: { transfer: changed(transfer, { schemaVersion: 4 }) },
  }), null);

  const oversizedRpcTransfer = exactByteBoundaryTransfer();
  strictEqual(parseBlacklistRpcRequest(createBlacklistRpcRequest(
    "import-replace",
    { transfer: oversizedRpcTransfer },
  )), null);
  strictEqual(parseBlacklistRpcResponse(createBlacklistRpcResponse(
    "export-json",
    true,
    { transfer: oversizedRpcTransfer },
  ), "export-json"), null);
});

test("AC-090 snapshot response collisions are scoped by platform and DTO fields remain strict", () => {
  const crossPlatform = createBlacklistRpcResponse("snapshot", true, {
    snapshot: {
      ...NULL_ALIAS_SNAPSHOT,
      authors: [
        NULL_ALIAS_SNAPSHOT.authors[0]!,
        {
          ...NULL_ALIAS_SNAPSHOT.authors[0]!,
          platformId: "youtube",
        },
      ],
    },
  });
  strictEqual(parseBlacklistRpcResponse(crossPlatform, "snapshot"), crossPlatform);

  const collision = createBlacklistRpcResponse("snapshot", true, {
    snapshot: {
      ...NULL_ALIAS_SNAPSHOT,
      authors: [
        {
          ...NULL_ALIAS_SNAPSHOT.authors[0]!,
          userId: HASH,
        },
        {
          ...NULL_ALIAS_SNAPSHOT.authors[0]!,
          userId: "other",
          memberHashId: HASH,
        },
      ],
    },
  });
  strictEqual(parseBlacklistRpcResponse(collision, "snapshot"), null);

  const oversizedId = createBlacklistRpcResponse("snapshot", true, {
    snapshot: {
      ...NULL_ALIAS_SNAPSHOT,
      authors: [{
        ...NULL_ALIAS_SNAPSHOT.authors[0]!,
        userId: "x".repeat(513),
      }],
    },
  });
  strictEqual(parseBlacklistRpcResponse(oversizedId, "snapshot"), null);
});

test("AC-089 response parsing rejects operation-inappropriate errors and extra fields", () => {
  const invalidError = createBlacklistRpcResponse(
    "import-merge",
    false,
    { snapshot: NULL_ALIAS_SNAPSHOT },
    "not-found",
  );
  strictEqual(parseBlacklistRpcResponse(invalidError, "import-merge"), null);
  strictEqual(parseBlacklistRpcResponse({
    ...createBlacklistRpcResponse("snapshot", true, {
      snapshot: NULL_ALIAS_SNAPSHOT,
    }),
    extra: true,
  }, "snapshot"), null);
  strictEqual(parseBlacklistRpcResponse({
    ...createBlacklistRpcResponse("snapshot", true, {
      snapshot: NULL_ALIAS_SNAPSHOT,
    }),
    version: BLACKLIST_RPC_VERSION + 1,
  }, "snapshot"), null);
});

test("BUG-014/AC-085 strict snapshot responses accept a nullable member hash alias", () => {
  const response = createBlacklistRpcResponse("snapshot", true, {
    snapshot: NULL_ALIAS_SNAPSHOT,
  });
  strictEqual(parseBlacklistRpcResponse(response, "snapshot"), response);
});
