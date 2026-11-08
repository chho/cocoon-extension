import { strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { createZhihuRemoteCoordinator } from "./remote-block-runtime.ts";

for (const blockOnPlatform of [false, true]) {
  test(`VOTER-015 plugin wiring persists before a bounded voter POST (opt-in=${blockOnPlatform})`, async () => {
    let saved = false;
    let posts = 0;
    let preflights = 0;
    const coordinator = createZhihuRemoteCoordinator({
      async withCrossContextLock(_name, operation) {
        return operation();
      },
      async tryWithCrossContextUserLock() {
        throw new Error("No direct lock for voters");
      },
      client: {
        async preflightDirect() {
          throw new Error("No direct preflight for voters");
        },
        async preflightUpvoter(identity, expected) {
          strictEqual(identity.platformId, "zhihu");
          strictEqual(identity.userId, "synthetic-voter");
          ok(expected);
          preflights++;
          return { status: "ready" };
        },
        async commitUpvoter(input) {
          saved = true;
          return {
            status: "persisted",
            author: { ...input, memberHashId: null, blockSource: "upvoter" },
            tag: null,
            baseRevision: 0,
            revision: 1,
            authorCount: 1,
            tagCount: 1,
          };
        },
      },
      readCookie: () => "_xsrf=synthetic-csrf",
      async fetchImpl(input, init) {
        strictEqual(saved, true);
        strictEqual(
          String(input),
          "https://www.zhihu.com/api/v4/members/synthetic-voter/actions/block",
        );
        strictEqual(init?.method, "POST");
        strictEqual(init?.credentials, "same-origin");
        strictEqual(init?.redirect, "error");
        ok(init?.signal instanceof AbortSignal);
        posts++;
        return new Response(null, { status: 200 });
      },
    });
    const result = await coordinator.block({
      source: "upvoter",
      userId: "synthetic-voter",
      authorName: "Synthetic",
      tagId: "default",
      sourcePostId: null,
      blockOnPlatform,
    });
    strictEqual(result.status, "success");
    strictEqual(saved, true);
    strictEqual(posts, blockOnPlatform ? 1 : 0);
    strictEqual(preflights, posts);
  });
}
