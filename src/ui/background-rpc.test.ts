import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistQueryRequest,
  createBlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import { BlacklistRpcClientError, createBlacklistRpcClient } from "./background-rpc.ts";

test("BUG-016 strict UI query client sends and accepts only the bounded operation contract", async () => {
  const request = createBlacklistQueryRequest("authors-page", {
    revision: 7,
    cursor: null,
    limit: 5,
    search: "reading",
    searchScope: "author-or-tag",
    tagId: null,
    platformId: null,
    direction: "desc",
  });
  let sent: unknown;
  const client = createBlacklistRpcClient(async (message) => {
    sent = message;
    return createBlacklistQueryResponse("authors-page", true, {
      revision: 7,
      authorCount: 33_524,
      tagCount: 3,
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  const response = await client.query(request);
  deepStrictEqual(sent, request);
  strictEqual(response.operation, "authors-page");
  strictEqual(response.data?.authorCount, 33_524);
});

test("BUG-016 strict UI query client rejects malformed requests before transport", async () => {
  let calls = 0;
  const client = createBlacklistRpcClient(async () => {
    calls += 1;
    return null;
  });
  const malformed = {
    ...createBlacklistQueryRequest("summary", {}),
    extra: true,
  };

  await rejects(
    client.query(malformed as Parameters<typeof client.query>[0]),
    BlacklistRpcClientError,
  );
  strictEqual(calls, 0);
});

test("BUG-016 strict UI query client rejects operation-mismatched responses", async () => {
  const client = createBlacklistRpcClient(async () =>
    createBlacklistQueryResponse("summary", true, {
      revision: 1,
      authorCount: 1,
      tagCount: 1,
    }),
  );

  await rejects(
    client.query(
      createBlacklistQueryRequest("authors-page", {
        revision: 1,
        cursor: null,
        limit: 5,
        search: "",
        searchScope: "author-or-tag",
        tagId: null,
        platformId: null,
        direction: "desc",
      }),
    ),
    BlacklistRpcClientError,
  );
});
