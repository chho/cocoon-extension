import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistQueryRequest,
  parseBlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import { createBlacklistQueryController } from "./blacklist-query-controller.ts";
import { StaleBlacklistCursorError } from "./blacklist-repository-query.ts";

const summary = { revision: 4, authorCount: 33_524, tagCount: 3 };

function queryRepository() {
  return {
    async querySummary() {
      return summary;
    },
    async queryAuthorsPage() {
      return { ...summary, items: [], nextCursor: null, totalCount: 0 };
    },
    async queryTagsPage() {
      return { ...summary, tags: [], nextCursor: null };
    },
    async queryPlatformsPage() {
      return { ...summary, platforms: [], nextCursor: null };
    },
    async queryIdentityMatches() {
      return { revision: summary.revision, matches: [] };
    },
  };
}

test("BUG-016 query controller dispatches every bounded repository query", async () => {
  const controller = createBlacklistQueryController(queryRepository());
  const requests = [
    createBlacklistQueryRequest("summary", {}),
    createBlacklistQueryRequest("authors-page", {
      revision: null,
      cursor: null,
      limit: 50,
      search: "",
      searchScope: "author",
      tagId: null,
      platformId: null,
      direction: "desc",
    }),
    createBlacklistQueryRequest("tags-page", {
      revision: null,
      cursor: null,
      limit: 100,
    }),
    createBlacklistQueryRequest("platforms-page", {
      revision: null,
      cursor: null,
      limit: 100,
    }),
    createBlacklistQueryRequest("identity-match", {
      revision: null,
      identities: [{ platformId: "zhihu", identifier: "author" }],
    }),
  ] as const;

  for (const request of requests) {
    const response = await controller.handleQuery(request);
    strictEqual(parseBlacklistQueryResponse(response, request.operation), response);
  }
});

test("BUG-016 query controller maps stale cursors separately from unreadable storage", async () => {
  const stale = createBlacklistQueryController({
    ...queryRepository(),
    async queryAuthorsPage() {
      throw new StaleBlacklistCursorError();
    },
  });
  const unreadable = createBlacklistQueryController({
    ...queryRepository(),
    async querySummary() {
      throw new Error("unreadable");
    },
  });
  const page = createBlacklistQueryRequest("authors-page", {
    revision: 4,
    cursor: "cursor",
    limit: 50,
    search: "",
    searchScope: "author",
    tagId: null,
    platformId: null,
    direction: "desc",
  });

  strictEqual((await stale.handleQuery(page)).error, "stale-cursor");
  strictEqual(
    (await unreadable.handleQuery(createBlacklistQueryRequest("summary", {}))).error,
    "storage-unreadable",
  );
});
