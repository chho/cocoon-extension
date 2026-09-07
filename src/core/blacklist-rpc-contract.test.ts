import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  BLACKLIST_RPC_REQUEST_TYPE,
  BLACKLIST_RPC_VERSION,
  MAX_BLACKLIST_MANAGEMENT_RPC_BYTES,
  MAX_BLACKLIST_MUTATION_IDENTITIES,
  createBlacklistRpcRequest,
  createBlacklistRpcResponse,
  isWithinBlacklistManagementRpcLimit,
  parseBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  type BlacklistAuthorDto,
} from "./blacklist-rpc-contract.ts";

const TIME = "2026-08-21T10:00:00.000Z";
const HASH = "a".repeat(32);

function author(overrides: Partial<BlacklistAuthorDto> = {}): BlacklistAuthorDto {
  return {
    platformId: "zhihu",
    userId: "author-token",
    memberHashId: null,
    authorName: "Author",
    tagId: "default",
    blacklistedAt: TIME,
    source: "direct",
    ...overrides,
  };
}

test("POPUP-009 status request and response keep an exact bounded contract", () => {
  const request = createBlacklistRpcRequest("status", {});
  strictEqual(parseBlacklistRpcRequest(request), request);
  for (const invalid of [
    { ...request, extra: true },
    { ...request, version: BLACKLIST_RPC_VERSION + 1 },
    { ...request, type: "other" },
    { ...request, input: { extra: true } },
  ]) {
    strictEqual(parseBlacklistRpcRequest(invalid), null);
  }

  for (const [status, count] of [
    ["running", 12],
    ["unsupported", 0],
    ["connection-error", 0],
  ] as const) {
    const response = createBlacklistRpcResponse("status", true, { status, count });
    strictEqual(parseBlacklistRpcResponse(response, "status"), response);
  }

  const unsupportedWithCount = createBlacklistRpcResponse("status", true, {
    status: "unsupported",
    count: 1,
  });
  strictEqual(parseBlacklistRpcResponse(unsupportedWithCount, "status"), null);
  strictEqual(
    parseBlacklistRpcResponse(createBlacklistRpcResponse("status", false), "status"),
    null,
  );
  strictEqual(
    parseBlacklistRpcResponse(
      {
        ...createBlacklistRpcResponse("status", true, { status: "running", count: 1 }),
        extra: true,
      },
      "status",
    ),
    null,
  );
});

test("BUG-016 management mutation requests enforce exact inputs and compound identities", () => {
  const requests = [
    createBlacklistRpcRequest("remove-one", {
      identity: { platformId: "zhihu", userId: "one" },
    }),
    createBlacklistRpcRequest("restore-one", { author: author() }),
    createBlacklistRpcRequest("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "same" },
        { platformId: "youtube", userId: "same" },
      ],
    }),
    createBlacklistRpcRequest("rename-tag", { tagId: "reading", name: "Research" }),
    createBlacklistRpcRequest("delete-tag", { tagId: "reading" }),
  ] as const;
  for (const request of requests) strictEqual(parseBlacklistRpcRequest(request), request);

  for (const invalid of [
    {
      ...requests[0],
      input: { identity: { platformId: "zhihu", userId: "one" }, extra: true },
    },
    createBlacklistRpcRequest("remove-one", {
      identity: { platformId: "zhihu", userId: "x".repeat(513) },
    }),
    createBlacklistRpcRequest("remove-many", {
      identities: [
        { platformId: "zhihu", userId: "same" },
        { platformId: "zhihu", userId: "same" },
      ],
    }),
    createBlacklistRpcRequest("restore-one", {
      author: author({ memberHashId: "A".repeat(32) }),
    }),
    createBlacklistRpcRequest("rename-tag", { tagId: "reading", name: "x".repeat(31) }),
    createBlacklistRpcRequest("delete-tag", { tagId: "" }),
  ]) {
    strictEqual(parseBlacklistRpcRequest(invalid), null);
  }
});

test("BUG-016 management operations stay bound to their exact input and response shape", () => {
  const remove = createBlacklistRpcRequest("remove-one", {
    identity: { platformId: "zhihu", userId: "one" },
  });
  const rename = createBlacklistRpcRequest("rename-tag", { tagId: "reading", name: "Research" });
  for (const invalid of [
    { ...remove, operation: "delete-tag" },
    { ...rename, operation: "restore-one" },
  ]) {
    strictEqual(parseBlacklistRpcRequest(invalid), null);
  }

  const response = createBlacklistRpcResponse("remove-many", true, {
    revision: 1,
    authorCount: 0,
    tagCount: 1,
    removedCount: 1,
  });
  strictEqual(parseBlacklistRpcResponse(response, "remove-one"), null);
});

test("BUG-016 mutation batch and JSON byte limits are enforced at their exact boundaries", () => {
  const identities = Array.from({ length: MAX_BLACKLIST_MUTATION_IDENTITIES }, (_, index) => ({
    platformId: "p",
    userId: `u${index}`,
  }));
  const exactBatch = createBlacklistRpcRequest("remove-many", { identities });
  strictEqual(parseBlacklistRpcRequest(exactBatch), exactBatch);
  strictEqual(
    parseBlacklistRpcRequest(
      createBlacklistRpcRequest("remove-many", {
        identities: [...identities, { platformId: "p", userId: "overflow" }],
      }),
    ),
    null,
  );

  const exactBytes = "x".repeat(MAX_BLACKLIST_MANAGEMENT_RPC_BYTES - 2);
  strictEqual(isWithinBlacklistManagementRpcLimit(exactBytes), true);
  strictEqual(isWithinBlacklistManagementRpcLimit(`${exactBytes}x`), false);
  const oversizedRequest = {
    version: BLACKLIST_RPC_VERSION,
    type: BLACKLIST_RPC_REQUEST_TYPE,
    operation: "status",
    input: {},
    padding: "x".repeat(MAX_BLACKLIST_MANAGEMENT_RPC_BYTES),
  };
  strictEqual(parseBlacklistRpcRequest(oversizedRequest), null);
});

test("BUG-014/AC-085 mutation DTOs accept null aliases and reject cross-field invalid data", () => {
  const nullableAlias = createBlacklistRpcRequest("restore-one", { author: author() });
  strictEqual(parseBlacklistRpcRequest(nullableAlias), nullableAlias);
  for (const invalidAuthor of [
    author({ userId: HASH, memberHashId: HASH }),
    author({ platformId: "youtube", memberHashId: HASH }),
    author({ source: "upvoter", blacklistedAt: null }),
    { ...author(), extra: true },
  ]) {
    strictEqual(
      parseBlacklistRpcRequest(createBlacklistRpcRequest("restore-one", { author: invalidAuthor })),
      null,
    );
  }
});

test("BUG-016 management mutations accept only operation-specific bounded deltas", () => {
  const removed = author();
  const responses = [
    createBlacklistRpcResponse("remove-one", true, {
      removed,
      revision: 8,
      authorCount: 33_524,
      tagCount: 3,
    }),
    createBlacklistRpcResponse("restore-one", true, {
      revision: 9,
      authorCount: 33_525,
      tagCount: 3,
    }),
    createBlacklistRpcResponse("remove-many", true, {
      revision: 10,
      authorCount: 33_523,
      tagCount: 3,
      removedCount: 2,
    }),
    createBlacklistRpcResponse("rename-tag", true, {
      revision: 11,
      authorCount: 33_523,
      tagCount: 3,
      tag: { tagId: "reading", name: "Research", isDefault: false },
    }),
    createBlacklistRpcResponse("delete-tag", true, {
      revision: 12,
      authorCount: 33_523,
      tagCount: 2,
      deletedTagId: "reading",
      migratedCount: 7,
    }),
  ] as const;
  for (const response of responses) {
    strictEqual(parseBlacklistRpcResponse(response, response.operation), response);
  }

  deepStrictEqual(responses[0].data, {
    status: null,
    count: null,
    removed,
    revision: 8,
    authorCount: 33_524,
    tagCount: 3,
    removedCount: null,
    tag: null,
    deletedTagId: null,
    migratedCount: null,
  });

  for (const invalid of [
    createBlacklistRpcResponse("remove-one", true, {
      revision: 8,
      authorCount: 1,
      tagCount: 1,
    }),
    createBlacklistRpcResponse("remove-many", true, {
      revision: 9,
      authorCount: 1,
      tagCount: 1,
    }),
    createBlacklistRpcResponse("rename-tag", true, {
      revision: 10,
      authorCount: 1,
      tagCount: 1,
    }),
    createBlacklistRpcResponse("delete-tag", true, {
      revision: 11,
      authorCount: 1,
      tagCount: 1,
      deletedTagId: "reading",
    }),
    {
      ...responses[1],
      data: { ...responses[1].data, extra: true },
    },
  ]) {
    strictEqual(parseBlacklistRpcResponse(invalid, invalid.operation), null);
  }
});

test("BUG-016 mutation failures allow only operation-appropriate errors and no delta", () => {
  for (const [operation, error] of [
    ["remove-one", "not-found"],
    ["restore-one", "conflict"],
    ["restore-one", "invalid-tag"],
    ["remove-many", "not-found"],
    ["rename-tag", "invalid-tag"],
    ["delete-tag", "save-failed"],
  ] as const) {
    const failure = createBlacklistRpcResponse(operation, false, {}, error);
    strictEqual(parseBlacklistRpcResponse(failure, operation), failure);
    strictEqual(
      parseBlacklistRpcResponse(
        createBlacklistRpcResponse(operation, false, { revision: 1 }, error),
        operation,
      ),
      null,
    );
  }

  strictEqual(
    parseBlacklistRpcResponse(
      createBlacklistRpcResponse("restore-one", false, {}, "not-found"),
      "restore-one",
    ),
    null,
  );
  strictEqual(
    parseBlacklistRpcResponse(
      { ...createBlacklistRpcResponse("remove-one", false, {}, "not-found"), extra: true },
      "remove-one",
    ),
    null,
  );
});
