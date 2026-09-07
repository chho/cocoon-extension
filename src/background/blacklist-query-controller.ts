import type * as QueryRpcContractModule from "../core/blacklist-query-rpc-contract.ts";
import type {
  BlacklistQueryRequest,
  BlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundQueryRpcContract from "../core/blacklist-query-rpc-contract.ts?background-copy";
import { StaleBlacklistCursorError } from "./blacklist-repository-query.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";

const { createBlacklistQueryResponse } =
  backgroundQueryRpcContract as typeof QueryRpcContractModule;

export interface BlacklistQueryController {
  handleQuery(request: BlacklistQueryRequest): Promise<BlacklistQueryResponse>;
}

type QueryRepository = Pick<
  BlacklistRepository,
  | "querySummary"
  | "queryAuthorsPage"
  | "queryTagsPage"
  | "queryPlatformsPage"
  | "queryIdentityMatches"
>;

export function createBlacklistQueryController(
  repository: QueryRepository,
): BlacklistQueryController {
  return {
    async handleQuery(request) {
      try {
        switch (request.operation) {
          case "summary":
            return createBlacklistQueryResponse("summary", true, await repository.querySummary());
          case "authors-page":
            return createBlacklistQueryResponse(
              "authors-page",
              true,
              await repository.queryAuthorsPage(request.input),
            );
          case "tags-page":
            return createBlacklistQueryResponse(
              "tags-page",
              true,
              await repository.queryTagsPage(request.input),
            );
          case "platforms-page":
            return createBlacklistQueryResponse(
              "platforms-page",
              true,
              await repository.queryPlatformsPage(request.input),
            );
          case "identity-match":
            return createBlacklistQueryResponse(
              "identity-match",
              true,
              await repository.queryIdentityMatches(request.input),
            );
        }
      } catch (error) {
        return createBlacklistQueryResponse(
          request.operation,
          false,
          null,
          error instanceof StaleBlacklistCursorError ? "stale-cursor" : "storage-unreadable",
        );
      }
    },
  };
}
