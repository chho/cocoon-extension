import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  BLACKLIST_IDENTITY_BATCH_SIZE,
  BLACKLIST_QUERY_PAGE_SIZE,
  MAX_BLACKLIST_QUERY_CODE_POINTS,
  MAX_BLACKLIST_QUERY_CURSOR_BYTES,
  createBlacklistQueryRequest,
  createBlacklistQueryResponse,
  parseBlacklistQueryRequest,
  parseBlacklistQueryResponse,
  type BlacklistAuthorListItemDto,
} from "./blacklist-query-rpc-contract.ts";

const TIME = "2026-08-25T12:34:56.789Z";

function pageInput() {
  return {
    revision: null,
    cursor: null,
    limit: BLACKLIST_QUERY_PAGE_SIZE,
    search: "synthetic",
    searchScope: "author" as const,
    tagId: null,
    platformId: "zhihu",
    direction: "desc" as const,
  };
}

function item(userId: string, tagId = "default"): BlacklistAuthorListItemDto {
  return {
    author: {
      platformId: "zhihu",
      userId,
      memberHashId: null,
      authorName: `Synthetic ${userId}`,
      tagId,
      blacklistedAt: TIME,
      source: "direct",
    },
    tag: {
      tagId,
      name: tagId === "default" ? "default" : "Reading",
      isDefault: tagId === "default",
    },
  };
}

test("BUG-016 query requests enforce exact operation-specific fields and cursor bounds", () => {
  const request = createBlacklistQueryRequest("authors-page", pageInput());
  deepStrictEqual(parseBlacklistQueryRequest(request), request);

  for (const invalid of [
    { ...request, extra: true },
    { ...request, input: { ...request.input, extra: true } },
    { ...request, input: { ...request.input, limit: 0 } },
    { ...request, input: { ...request.input, limit: BLACKLIST_QUERY_PAGE_SIZE + 1 } },
    {
      ...request,
      input: { ...request.input, search: "x".repeat(MAX_BLACKLIST_QUERY_CODE_POINTS + 1) },
    },
    { ...request, input: { ...request.input, tagId: " x " } },
    { ...request, input: { ...request.input, platformId: "Zhihu" } },
    { ...request, input: { ...request.input, cursor: "opaque", revision: null } },
    {
      ...request,
      input: {
        ...request.input,
        cursor: "界".repeat(Math.ceil(MAX_BLACKLIST_QUERY_CURSOR_BYTES / 3) + 1),
        revision: 1,
      },
    },
  ]) {
    strictEqual(parseBlacklistQueryRequest(invalid), null);
  }
});

test("BUG-016 author queries distinguish Popup author/tag search from options author-only search", () => {
  const popupRequest = createBlacklistQueryRequest("authors-page", {
    ...pageInput(),
    searchScope: "author-or-tag",
  });
  deepStrictEqual(parseBlacklistQueryRequest(popupRequest), popupRequest);
  const optionsRequest = createBlacklistQueryRequest("authors-page", {
    ...pageInput(),
    searchScope: "author",
  });
  deepStrictEqual(parseBlacklistQueryRequest(optionsRequest), optionsRequest);
  strictEqual(
    parseBlacklistQueryRequest({
      ...optionsRequest,
      input: { ...optionsRequest.input, searchScope: "tag" },
    }),
    null,
  );
});

test("BUG-016 query request operations stay bound to their exact input parser", () => {
  const authorsPage = createBlacklistQueryRequest("authors-page", pageInput());
  const identityMatch = createBlacklistQueryRequest("identity-match", {
    revision: 7,
    identities: [{ platformId: "zhihu", identifier: "token" }],
  });

  for (const invalid of [
    { ...authorsPage, operation: "summary" },
    { ...authorsPage, operation: "tags-page" },
    { ...identityMatch, operation: "authors-page" },
    { ...identityMatch, operation: "platforms-page" },
  ]) {
    strictEqual(parseBlacklistQueryRequest(invalid), null);
  }
});

test("BUG-016 identity match batches are bounded, unique, platform-scoped, and exact", () => {
  const identities = [
    { platformId: "zhihu", identifier: "token" },
    { platformId: "youtube", identifier: "token" },
  ];
  const request = createBlacklistQueryRequest("identity-match", {
    revision: 7,
    identities,
  });
  deepStrictEqual(parseBlacklistQueryRequest(request), request);

  for (const invalidIdentities of [
    [],
    [identities[0], identities[0]],
    [{ platformId: "zhihu", identifier: " token " }],
    [{ platformId: "Zhihu", identifier: "token" }],
    Array.from({ length: BLACKLIST_IDENTITY_BATCH_SIZE + 1 }, (_, index) => ({
      platformId: "zhihu",
      identifier: `synthetic-${index}`,
    })),
    Array.from({ length: BLACKLIST_IDENTITY_BATCH_SIZE }, (_, index) => ({
      platformId: "zhihu",
      identifier: `${index}-${"界".repeat(500)}`,
    })),
  ]) {
    strictEqual(
      parseBlacklistQueryRequest({
        ...request,
        input: { revision: 7, identities: invalidIdentities },
      }),
      null,
    );
  }
});

test("BUG-016 summary and pages represent 33,524 and 100,000 authors without full snapshots", () => {
  for (const authorCount of [33_524, 100_000]) {
    const summary = createBlacklistQueryResponse("summary", true, {
      revision: 9,
      authorCount,
      tagCount: 3,
    });
    deepStrictEqual(parseBlacklistQueryResponse(summary, "summary"), summary);

    const page = createBlacklistQueryResponse("authors-page", true, {
      revision: 9,
      authorCount,
      tagCount: 3,
      items: [item(`synthetic-${authorCount}`, "reading")],
      nextCursor: "opaque-cursor",
      totalCount: authorCount,
    });
    deepStrictEqual(parseBlacklistQueryResponse(page, "authors-page"), page);
    strictEqual("authors" in page.data!, false);
  }
});

test("BUG-016 query responses fail closed on extra, oversized, and operation-mismatched data", () => {
  const response = createBlacklistQueryResponse("identity-match", true, {
    revision: 2,
    matches: [{ platformId: "zhihu", identifier: "member-hash" }],
  });
  deepStrictEqual(parseBlacklistQueryResponse(response, "identity-match"), response);
  strictEqual(parseBlacklistQueryResponse(response, "summary"), null);
  strictEqual(parseBlacklistQueryResponse({ ...response, extra: true }, "identity-match"), null);
  strictEqual(
    parseBlacklistQueryResponse(
      {
        ...response,
        data: {
          revision: 2,
          matches: Array.from({ length: BLACKLIST_IDENTITY_BATCH_SIZE + 1 }, (_, index) => ({
            platformId: "zhihu",
            identifier: `synthetic-${index}`,
          })),
        },
      },
      "identity-match",
    ),
    null,
  );
  strictEqual(
    parseBlacklistQueryResponse(
      {
        ...response,
        data: {
          revision: 2,
          matches: Array.from({ length: BLACKLIST_IDENTITY_BATCH_SIZE }, (_, index) => ({
            platformId: "zhihu",
            identifier: `${index}-${"界".repeat(500)}`,
          })),
        },
      },
      "identity-match",
    ),
    null,
  );
  strictEqual(
    parseBlacklistQueryResponse(
      createBlacklistQueryResponse("summary", false, null, "stale-cursor"),
      "summary",
    )?.error,
    "stale-cursor",
  );
});
