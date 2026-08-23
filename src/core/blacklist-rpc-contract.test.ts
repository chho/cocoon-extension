import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistRpcRequest,
  createBlacklistRpcResponse,
  parseBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  type BlacklistSnapshotDto,
} from "./blacklist-rpc-contract.ts";

const TIME = "2026-08-21T10:00:00.000Z";
const HASH = "a".repeat(32);

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

test("BUG-014/AC-085 strict snapshot responses accept a nullable member hash alias", () => {
  const response = createBlacklistRpcResponse("snapshot", true, {
    snapshot: NULL_ALIAS_SNAPSHOT,
  });
  strictEqual(parseBlacklistRpcResponse(response, "snapshot"), response);
});
