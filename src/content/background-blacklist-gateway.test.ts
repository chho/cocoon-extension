import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createBackgroundBlacklistGateway } from "./background-blacklist-gateway.ts";
import { createBlacklistContentResponse } from "../core/blacklist-content-rpc-contract.ts";

test("BUG-016 gateway initializes with summary metadata and reads bounded tag pages", async () => {
  const messages: unknown[] = [];
  const gateway = createBackgroundBlacklistGateway({
    async sendMessage(message) {
      messages.push(message);
      const operation = (message as { readonly operation: string }).operation;
      if (operation === "initialize") {
        return createBlacklistContentResponse("initialize", true, {
          revision: 3,
          authorCount: 100_000,
          tagCount: 1,
        });
      }
      return createBlacklistContentResponse("tags-page", true, {
        revision: 3,
        tags: [{ tagId: "default", name: "default" }],
        nextCursor: null,
      });
    },
  });

  deepStrictEqual(await gateway.initialize(), {
    revision: 3,
    authorCount: 100_000,
    tagCount: 1,
  });
  deepStrictEqual(await gateway.queryTagsPage({ revision: 3, cursor: null, limit: 100 }), {
    revision: 3,
    tags: [{ tagId: "default", name: "default" }],
    nextCursor: null,
  });
  strictEqual(messages.length, 2);
});

test("AC-095 gateway requires the exact tag deletion migration count", async () => {
  const result = {
    status: "persisted" as const,
    deletedTagId: "reading",
    migratedCount: 7,
    baseRevision: 3,
    revision: 4,
    authorCount: 10,
    tagCount: 2,
  };
  const gateway = createBackgroundBlacklistGateway({
    async sendMessage() {
      return createBlacklistContentResponse("delete-tag", true, result);
    },
  });
  deepStrictEqual(await gateway.deleteTag("reading"), result);

  const missingCount = createBackgroundBlacklistGateway({
    async sendMessage() {
      return createBlacklistContentResponse("delete-tag", true, {
        status: result.status,
        deletedTagId: result.deletedTagId,
        baseRevision: result.baseRevision,
        revision: result.revision,
        authorCount: result.authorCount,
        tagCount: result.tagCount,
      });
    },
  });
  await rejects(missingCount.deleteTag("reading"));
});

test("AC-094 gateway rejects malformed, failed, and operation-mismatched responses", async () => {
  for (const response of [
    null,
    createBlacklistContentResponse("initialize", false),
    createBlacklistContentResponse("delete-tag", true, {}),
    createBlacklistContentResponse("initialize", true, {
      revision: 0,
      authorCount: 0,
      tagCount: 1,
      authors: [],
    }),
  ]) {
    const gateway = createBackgroundBlacklistGateway({
      async sendMessage() {
        return response;
      },
    });
    await rejects(gateway.initialize());
  }
});

test("BUG-016 gateway binds identity matches to the requested revision and identities", async () => {
  const requested = [{ platformId: "zhihu", identifier: "visible-author" }] as const;
  const gateway = createBackgroundBlacklistGateway({
    async sendMessage() {
      return createBlacklistContentResponse("identity-match", true, {
        revision: 7,
        matches: requested,
      });
    },
  });
  deepStrictEqual(await gateway.queryIdentityMatches({ revision: 7, identities: requested }), {
    revision: 7,
    matches: requested,
  });

  const stale = createBackgroundBlacklistGateway({
    async sendMessage() {
      return createBlacklistContentResponse("identity-match", true, {
        revision: 6,
        matches: requested,
      });
    },
  });
  await rejects(stale.queryIdentityMatches({ revision: 7, identities: requested }));
});
