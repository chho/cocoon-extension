import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createBlacklistContentController } from "../background/blacklist-content-controller.ts";
import type { BlacklistRepository } from "../background/blacklist-repository-types.ts";
import {
  createBlacklistContentResponse,
  parseBlacklistContentRequest,
} from "../core/blacklist-content-rpc-contract.ts";
import type { BlacklistedAuthor, UpvoterCommitInput } from "./blacklist-state.ts";
import { createBackgroundBlacklistGateway } from "./background-blacklist-gateway.ts";
import { createRemoteBlockCoordinator } from "./remote-block-coordinator.ts";
import { createVoterBatchController } from "./voter-batch-controller.ts";

const POST = {
  postId: "zhihu:article:2",
  platformId: "zhihu",
  kind: "article",
  contentId: "2",
  title: "Synthetic",
  url: "https://zhuanlan.zhihu.com/p/2",
} as const;
const TIMESTAMP = "2026-10-30T00:00:00.000Z";

function pipeline(failure: "individual" | "global" | "invalid-input") {
  let transportCalls = 0;
  const authors: BlacklistedAuthor[] = [];
  const requests: UpvoterCommitInput[] = [];
  const controller = createBlacklistContentController(
    {
      async ensurePost() {
        return { post: POST, revision: 1 };
      },
      async commitUpvoter(input: UpvoterCommitInput) {
        requests.push(input);
        const context = { baseRevision: 1, revision: 1, authorCount: authors.length, tagCount: 1 };
        if (input.userId === "voter-0") {
          if (failure === "global") throw new DOMException("Private detail", "QuotaExceededError");
          return { ...context, status: "invalid", author: null, tag: null };
        }
        const author: BlacklistedAuthor = { ...input, memberHashId: null, blockSource: "upvoter" };
        authors.push(author);
        return { ...context, status: "persisted", author, tag: null };
      },
    } as unknown as BlacklistRepository,
    {
      async runExclusive(operation) {
        return operation();
      },
    },
  );
  const gateway = createBackgroundBlacklistGateway({
    async sendMessage(raw) {
      transportCalls += 1;
      const request = parseBlacklistContentRequest(raw);
      if (!request) throw new Error("Invalid test request");
      return createBlacklistContentResponse(
        request.operation,
        true,
        await controller.handle(request),
      );
    },
  });
  const coordinator = createRemoteBlockCoordinator({
    async withCrossContextLock(_name, operation) {
      return operation();
    },
    async tryWithCrossContextUserLock(_name, operation) {
      return { acquired: true, value: await operation() };
    },
    async preflightDirect() {
      throw new Error("Unexpected direct preflight");
    },
    commitUpvoter: (input) => gateway.commitUpvoter(input),
    now: () => new Date(TIMESTAMP),
    async blockUser() {
      throw new Error("Voters must never POST");
    },
    reportStorageFailure() {},
  });
  return { gateway, coordinator, authors, requests, transportCalls: () => transportCalls };
}

for (const failure of ["individual", "global", "invalid-input"] as const) {
  test(`POST-002 content RPC integrates ${failure} failure isolation with voter scheduling`, async () => {
    const harness = pipeline(failure);
    const persisted = await harness.gateway.ensurePost(POST);
    const batch = createVoterBatchController({
      async fetchCurrentUser() {
        return { status: "success", userId: "self" };
      },
      async fetchVoters() {
        return {
          users: Array.from({ length: 6 }, (_, index) => ({
            userId: `voter-${index}`,
            authorName:
              failure === "invalid-input" && index === 0 ? "x".repeat(501) : "Synthetic voter",
          })),
          fetched: 6,
          invalid: 0,
          duplicates: 0,
          complete: true,
          fatalReason: null,
          requestFailures: 0,
        };
      },
      coordinator: harness.coordinator,
      reportProgress() {},
    });
    const result = await batch.run({
      source: { kind: "article", contentId: "2" },
      sourcePostId: persisted.post.postId,
      tagId: "default",
      directAuthorUserId: "direct",
      isStopped: () => false,
    });
    strictEqual(result.phase, failure === "global" ? "failed" : "complete");
    strictEqual(result.failed, 1);
    strictEqual(harness.requests.length, { individual: 6, global: 3, "invalid-input": 5 }[failure]);
    strictEqual(harness.transportCalls(), harness.requests.length + 1);
    strictEqual(result.success, failure === "global" ? 2 : 5);
    strictEqual(result.success, harness.authors.length);
    strictEqual(result.unprocessed, failure === "global" ? 3 : 0);
    deepStrictEqual(
      [...new Set(harness.requests.map((input) => input.sourcePostId))],
      [POST.postId],
    );
  });
}
