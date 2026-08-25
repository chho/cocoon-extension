import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistContentRequest,
  createBlacklistContentResponse,
  parseBlacklistContentRequest,
  parseBlacklistContentResponseEnvelope,
} from "./blacklist-content-rpc-contract.ts";

const TIMESTAMP = "2026-08-25T12:34:56.789Z";

test("AC-094 strictly parses targeted content requests without whole-state payloads", () => {
  const request = createBlacklistContentRequest("commit-author", {
    input: {
      platformId: "zhihu",
      userId: "synthetic-user",
      memberHashId: null,
      authorNameAtCapture: "Synthetic author",
      tag: { tagId: "default", name: "default" },
      isNewTag: false,
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
  const response = createBlacklistContentResponse("hydrate", true, {
    state: { schemaVersion: 5, authors: [], tags: [] },
    revision: 0,
  });

  deepStrictEqual(parseBlacklistContentResponseEnvelope(response, "hydrate"), response);
  strictEqual(parseBlacklistContentResponseEnvelope(response, "delete-tag"), null);
  strictEqual(parseBlacklistContentResponseEnvelope({ ...response, extra: true }, "hydrate"), null);
  strictEqual(
    parseBlacklistContentResponseEnvelope(
      createBlacklistContentResponse("hydrate", true, "x".repeat(8 * 1024 * 1024)),
      "hydrate",
    ),
    null,
  );
});
