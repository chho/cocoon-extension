import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistRpcResponse,
  parseBlacklistRpcResponse,
  type BlacklistSnapshotDto,
} from "./blacklist-rpc-contract.ts";

const NULL_ALIAS_SNAPSHOT: BlacklistSnapshotDto = {
  authors: [{
    userId: "author-token",
    memberHashId: null,
    authorName: "Author",
    tagId: "default",
    blacklistedAt: "2026-08-21T10:00:00.000Z",
    source: "direct",
  }],
  tags: [{ tagId: "default", name: "default", isDefault: true }],
};

test("BUG-014/AC-085 strict snapshot responses accept a nullable member hash alias", () => {
  const response = createBlacklistRpcResponse("snapshot", true, {
    snapshot: NULL_ALIAS_SNAPSHOT,
  });
  strictEqual(parseBlacklistRpcResponse(response, "snapshot"), response);
});

test("BUG-014/AC-085 strict snapshot responses still reject duplicate non-null identifiers", () => {
  const response = createBlacklistRpcResponse("snapshot", true, {
    snapshot: {
      authors: [
        {
          ...NULL_ALIAS_SNAPSHOT.authors[0]!,
          userId: "abcdef0123456789abcdef0123456789",
        },
        {
          userId: "other-token",
          memberHashId: "abcdef0123456789abcdef0123456789",
          authorName: "Other Author",
          tagId: "default",
          blacklistedAt: "2026-08-21T11:00:00.000Z",
          source: "direct",
        },
      ],
      tags: NULL_ALIAS_SNAPSHOT.tags,
    },
  });
  strictEqual(parseBlacklistRpcResponse(response, "snapshot"), null);
});
