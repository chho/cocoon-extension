import type { BlacklistContentRequest } from "../core/blacklist-content-rpc-contract.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";

export interface BlacklistContentController {
  handle(request: BlacklistContentRequest): Promise<unknown>;
}

interface ExclusiveRunner {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export function createBlacklistContentController(
  repository: BlacklistRepository,
  lock: ExclusiveRunner,
): BlacklistContentController {
  return {
    async handle(request) {
      return lock.runExclusive(async () => {
        switch (request.operation) {
          case "hydrate":
            return repository.hydrate();
          case "commit-author":
            return repository.commitAuthor(request.input.input);
          case "backfill-member-hash":
            return repository.backfillMemberHash(
              request.input.identity,
              request.input.memberHashId,
            );
          case "commit-upvoter":
            return repository.commitUpvoter(request.input.input);
          case "preflight-direct":
            return repository.preflightDirect({
              ...request.input.identity,
              expectedBlacklistedAt: request.input.expectedBlacklistedAt,
            });
          case "delete-tag":
            return repository.deleteTag(request.input.tagId);
        }
      });
    },
  };
}
