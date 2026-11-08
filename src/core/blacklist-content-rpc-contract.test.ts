import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistContentRequest,
  createBlacklistContentResponse,
  parseBlacklistContentRequest,
  parseBlacklistContentResponseEnvelope,
} from "./blacklist-content-rpc-contract.ts";

const TIMESTAMP = "2026-08-25T12:34:56.789Z";

function contentRequest(operation: string, input: unknown) {
  return {
    version: 3,
    type: "cocoon.blacklist.content.request",
    operation,
    input,
  };
}

test("VOTER-015 upvoter preflight accepts only exact canonical Zhihu identity and timestamp", () => {
  const input = {
    identity: { platformId: "zhihu", userId: "synthetic-voter" },
    expectedBlacklistedAt: TIMESTAMP,
  };
  const request = contentRequest("preflight-upvoter", input);
  deepStrictEqual(parseBlacklistContentRequest(request), request);
  for (const invalid of [
    { ...input, extra: true },
    { ...input, expectedBlacklistedAt: "invalid" },
    { ...input, identity: { ...input.identity, platformId: "youtube" } },
    { ...input, identity: { ...input.identity, userId: "A".repeat(32) } },
    { ...input, identity: { ...input.identity, userId: " voter " } },
    { ...input, identity: { ...input.identity, extra: true } },
  ])
    strictEqual(parseBlacklistContentRequest({ ...request, input: invalid }), null);
});

test("POST-002 ensure-post and user references are strict, bounded and versioned", () => {
  const post = {
    postId: "zhihu:answer:2",
    platformId: "zhihu",
    kind: "answer",
    contentId: "2",
    title: "Title",
    url: "https://www.zhihu.com/question/1/answer/2",
  } as const;
  const request = createBlacklistContentRequest("ensure-post", { post });
  deepStrictEqual(parseBlacklistContentRequest(request), request);
  for (const input of [
    { post, extra: true },
    { post: { ...post, extra: true } },
    { post: { ...post, title: "x".repeat(501) } },
    { post: { ...post, url: post.url + "?tracking=1" } },
  ]) {
    strictEqual(parseBlacklistContentRequest({ ...request, input }), null);
  }
  const input = {
    platformId: "zhihu",
    userId: "voter",
    authorNameAtCapture: "Voter",
    tagId: "default",
    blacklistedAt: TIMESTAMP,
    sourcePostId: post.postId,
  };
  const voter = contentRequest("commit-upvoter", { input });
  deepStrictEqual(parseBlacklistContentRequest(voter), voter);
  for (const sourcePostId of [undefined, "zhihu:answer:02", "youtube:answer:2"]) {
    strictEqual(
      parseBlacklistContentRequest({ ...voter, input: { input: { ...input, sourcePostId } } }),
      null,
    );
  }
  strictEqual(parseBlacklistContentRequest({ ...request, version: 2 }), null);
});

test("BUG-016 private content reads are exact and never expose full hydration", () => {
  const initialize = contentRequest("initialize", {});
  const identities = Array.from({ length: 200 }, (_, index) => ({
    platformId: "zhihu",
    identifier: `visible-${index}`,
  }));
  const identityMatch = contentRequest("identity-match", { revision: 7, identities });
  const tagsPage = contentRequest("tags-page", {
    revision: 7,
    cursor: null,
    limit: 100,
  });

  deepStrictEqual(parseBlacklistContentRequest(initialize), initialize);
  deepStrictEqual(parseBlacklistContentRequest(identityMatch), identityMatch);
  deepStrictEqual(parseBlacklistContentRequest(tagsPage), tagsPage);
  strictEqual(parseBlacklistContentRequest(contentRequest("hydrate", {})), null);
  strictEqual(parseBlacklistContentRequest({ ...identityMatch, extra: true }), null);
  strictEqual(
    parseBlacklistContentRequest(
      contentRequest("identity-match", {
        revision: 7,
        identities: [...identities, { platformId: "zhihu", identifier: "oversize" }],
      }),
    ),
    null,
  );
  strictEqual(
    parseBlacklistContentRequest(
      contentRequest("identity-match", {
        revision: 7,
        identities: [identities[0], identities[0]],
      }),
    ),
    null,
  );
});

test("AC-094 strictly parses targeted content requests without whole-state payloads", () => {
  const request = createBlacklistContentRequest("commit-author", {
    input: {
      platformId: "zhihu",
      userId: "synthetic-user",
      memberHashId: null,
      authorNameAtCapture: "Synthetic author",
      tag: { tagId: "default", name: "default" },
      isNewTag: false,
      sourcePostId: null,
      blacklistedAt: TIMESTAMP,
    },
  });

  deepStrictEqual(parseBlacklistContentRequest(request), request);
  strictEqual(parseBlacklistContentRequest({ ...request, state: {} }), null);
  strictEqual(
    parseBlacklistContentRequest({
      ...request,
      input: { ...request.input, extra: true },
    }),
    null,
  );
  strictEqual(parseBlacklistContentRequest({ ...request, version: 2 }), null);
});

test("AC-094 enforces Zhihu scope, canonical identities, field limits, and timestamps", () => {
  const validInput = {
    platformId: "zhihu",
    userId: "u".repeat(512),
    memberHashId: "a".repeat(32),
    authorNameAtCapture: "A".repeat(500),
    tag: { tagId: "t".repeat(512), name: "T".repeat(30) },
    isNewTag: true,
    sourcePostId: null,
    blacklistedAt: TIMESTAMP,
  } as const;
  const valid = createBlacklistContentRequest("commit-author", { input: validInput });
  strictEqual(parseBlacklistContentRequest(valid)?.operation, "commit-author");
  for (const input of [
    { ...validInput, platformId: "youtube" },
    { ...validInput, userId: "u".repeat(513) },
    { ...validInput, userId: "A".repeat(32) },
    { ...validInput, memberHashId: "A".repeat(32) },
    { ...validInput, authorNameAtCapture: "A".repeat(501) },
    { ...validInput, tag: { ...validInput.tag, tagId: "t".repeat(513) } },
    { ...validInput, tag: { ...validInput.tag, name: "T".repeat(31) } },
    { ...validInput, blacklistedAt: "not-a-timestamp" },
  ]) {
    strictEqual(parseBlacklistContentRequest({ ...valid, input: { input } }), null);
  }
});

test("AC-094 response envelopes are operation-bound, exact, and bounded", () => {
  const response = createBlacklistContentResponse("initialize", true, {
    revision: 0,
    authorCount: 100_000,
    tagCount: 3,
  });

  deepStrictEqual(parseBlacklistContentResponseEnvelope(response, "initialize"), response);
  strictEqual(parseBlacklistContentResponseEnvelope(response, "delete-tag"), null);
  strictEqual(
    parseBlacklistContentResponseEnvelope({ ...response, extra: true }, "initialize"),
    null,
  );
  strictEqual(
    parseBlacklistContentResponseEnvelope(
      createBlacklistContentResponse("initialize", true, "x".repeat(256 * 1024)),
      "initialize",
    ),
    null,
  );
  strictEqual(
    parseBlacklistContentResponseEnvelope(
      createBlacklistContentResponse("initialize", false, { extra: true }),
      "initialize",
    ),
    null,
  );
});
