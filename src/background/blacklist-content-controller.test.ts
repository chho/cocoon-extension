import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BlacklistContentRequest } from "../core/blacklist-content-rpc-contract.ts";
import { createBlacklistContentController } from "./blacklist-content-controller.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";

function request(
  operation: BlacklistContentRequest["operation"],
  input: unknown,
): BlacklistContentRequest {
  return {
    version: 3,
    type: "cocoon.blacklist.content.request",
    operation,
    input,
  } as unknown as BlacklistContentRequest;
}

test("POST-002 post persistence runs inside the lock and global failures are sanitized", async () => {
  const post = {
    postId: "zhihu:article:2",
    platformId: "zhihu",
    kind: "article",
    contentId: "2",
    title: "Title",
    url: "https://zhuanlan.zhihu.com/p/2",
  } as const;
  let locked = false;
  let fail = false;
  const controller = createBlacklistContentController(
    {
      async ensurePost(input: unknown) {
        strictEqual(locked, true);
        deepStrictEqual(input, post);
        if (fail) throw new DOMException("Do not expose storage details", "QuotaExceededError");
        return { post, revision: 2 };
      },
      async commitUpvoter() {
        throw new Error("Do not expose storage details");
      },
    } as unknown as BlacklistRepository,
    {
      async runExclusive(operation) {
        locked = true;
        try {
          return await operation();
        } finally {
          locked = false;
        }
      },
    },
  );
  deepStrictEqual(await controller.handle(request("ensure-post", { post })), { post, revision: 2 });
  fail = true;
  deepStrictEqual(await controller.handle(request("ensure-post", { post })), {
    status: "global-failure",
  });
  deepStrictEqual(await controller.handle(request("commit-upvoter", { input: {} })), {
    status: "global-failure",
  });
  strictEqual(locked, false);
});

test("BUG-016 content initialization and identity checks use bounded queries, never repository hydration", async () => {
  let hydrateCalls = 0;
  const identityBatches: number[] = [];
  const repository = {
    async hydrate() {
      hydrateCalls += 1;
      throw new Error("Content must not hydrate authors.");
    },
    async querySummary() {
      return { revision: 9, authorCount: 100_000, tagCount: 3 };
    },
    async queryTagsPage() {
      return {
        revision: 9,
        authorCount: 100_000,
        tagCount: 3,
        tags: [
          { tagId: "default", name: "default", isDefault: true, authorCount: 99_998 },
          { tagId: "reading", name: "Reading", isDefault: false, authorCount: 2 },
        ],
        nextCursor: "next-tags",
      };
    },
    async queryIdentityMatches(input: { readonly identities: readonly unknown[] }) {
      identityBatches.push(input.identities.length);
      return {
        revision: 9,
        matches: [{ platformId: "zhihu", identifier: "blocked-visible" }],
      };
    },
  } as unknown as BlacklistRepository;
  const controller = createBlacklistContentController(repository, {
    async runExclusive(operation) {
      return operation();
    },
  });

  const initialization = await controller.handle(request("initialize", {}));
  deepStrictEqual(initialization, {
    revision: 9,
    authorCount: 100_000,
    tagCount: 3,
  });
  strictEqual("authors" in (initialization as Record<string, unknown>), false);
  const tags = await controller.handle(
    request("tags-page", { revision: 9, cursor: null, limit: 100 }),
  );
  deepStrictEqual(tags, {
    revision: 9,
    tags: [
      { tagId: "default", name: "default" },
      { tagId: "reading", name: "Reading" },
    ],
    nextCursor: "next-tags",
  });

  const matched = await controller.handle(
    request("identity-match", {
      revision: 9,
      identities: [
        { platformId: "zhihu", identifier: "blocked-visible" },
        { platformId: "zhihu", identifier: "visible" },
      ],
    }),
  );
  deepStrictEqual(matched, {
    revision: 9,
    matches: [{ platformId: "zhihu", identifier: "blocked-visible" }],
  });
  deepStrictEqual(identityBatches, [2]);
  strictEqual(hydrateCalls, 0);
});
