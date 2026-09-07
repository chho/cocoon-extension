import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type { BlacklistedAuthor, CocoonTag } from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import type * as RpcContractModule from "../core/blacklist-rpc-contract.ts";
import type {
  BlacklistAuthorDto,
  BlacklistRpcError,
  BlacklistRpcRequest,
  BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundRpcContract from "../core/blacklist-rpc-contract.ts?background-copy";
import type { BlacklistLockCoordinator } from "./blacklist-lock-coordinator.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";
import type { CurrentPageStatusResult } from "./status-controller.ts";

const { DEFAULT_TAG_ID } = backgroundBlacklistState as typeof BlacklistStateModule;
const { createBlacklistRpcResponse } = backgroundRpcContract as typeof RpcContractModule;

interface StatusController {
  query(): Promise<CurrentPageStatusResult>;
}

export interface BlacklistManagementController {
  handle(request: BlacklistRpcRequest): Promise<BlacklistRpcResponse>;
}

function toAuthorDto(author: BlacklistedAuthor): BlacklistAuthorDto {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorName: author.authorNameAtCapture,
    tagId: author.tagId,
    blacklistedAt: author.blacklistedAt,
    source: author.blockSource,
  };
}

function fromAuthorDto(author: BlacklistAuthorDto): BlacklistedAuthor {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorName,
    tagId: author.tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.source,
  };
}

function toTagDto(tag: CocoonTag) {
  return { tagId: tag.tagId, name: tag.name, isDefault: tag.tagId === DEFAULT_TAG_ID };
}

type ManagementMutationRequest = Exclude<BlacklistRpcRequest, { readonly operation: "status" }>;

type MutationResultSummary = {
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
};

function mutationSummary(result: MutationResultSummary) {
  return {
    revision: result.revision,
    authorCount: result.authorCount,
    tagCount: result.tagCount,
  };
}

type AuthorMutationRequest = Extract<
  ManagementMutationRequest,
  { readonly operation: "remove-one" | "restore-one" | "remove-many" }
>;
type TagMutationRequest = Exclude<ManagementMutationRequest, AuthorMutationRequest>;

function isAuthorMutation(request: ManagementMutationRequest): request is AuthorMutationRequest {
  return (
    request.operation === "remove-one" ||
    request.operation === "restore-one" ||
    request.operation === "remove-many"
  );
}

async function runAuthorMutation(
  repository: BlacklistRepository,
  request: AuthorMutationRequest,
): Promise<BlacklistRpcResponse> {
  if (request.operation === "remove-one") {
    const result = await repository.removeAuthor(request.input.identity);
    if (result.status !== "persisted" || !result.removed) {
      return createBlacklistRpcResponse("remove-one", false, {}, "not-found");
    }
    return createBlacklistRpcResponse("remove-one", true, {
      ...mutationSummary(result),
      removed: toAuthorDto(result.removed),
    });
  }
  if (request.operation === "restore-one") {
    const result = await repository.restoreAuthor(fromAuthorDto(request.input.author));
    if (result.status === "persisted") {
      return createBlacklistRpcResponse("restore-one", true, mutationSummary(result));
    }
    const error: BlacklistRpcError = result.status === "missing-tag" ? "invalid-tag" : "conflict";
    return createBlacklistRpcResponse("restore-one", false, {}, error);
  }
  const result = await repository.removeAuthors(request.input.identities);
  if (result.status !== "persisted") {
    return createBlacklistRpcResponse("remove-many", false, {}, "not-found");
  }
  return createBlacklistRpcResponse("remove-many", true, {
    ...mutationSummary(result),
    removedCount: result.removedCount,
  });
}

async function runTagMutation(
  repository: BlacklistRepository,
  request: TagMutationRequest,
): Promise<BlacklistRpcResponse> {
  if (request.operation === "rename-tag") {
    const result = await repository.renameTag(request.input.tagId, request.input.name);
    if ((result.status !== "persisted" && result.status !== "unchanged") || !result.tag) {
      return createBlacklistRpcResponse("rename-tag", false, {}, "invalid-tag");
    }
    return createBlacklistRpcResponse("rename-tag", true, {
      ...mutationSummary(result),
      tag: toTagDto(result.tag),
    });
  }
  const result = await repository.deleteTag(request.input.tagId);
  if (result.status !== "persisted" || !result.deletedTagId) {
    return createBlacklistRpcResponse("delete-tag", false, {}, "invalid-tag");
  }
  return createBlacklistRpcResponse("delete-tag", true, {
    ...mutationSummary(result),
    deletedTagId: result.deletedTagId,
    migratedCount: result.migratedCount,
  });
}

function runManagementMutation(
  repository: BlacklistRepository,
  request: ManagementMutationRequest,
): Promise<BlacklistRpcResponse> {
  return isAuthorMutation(request)
    ? runAuthorMutation(repository, request)
    : runTagMutation(repository, request);
}

export function createBlacklistManagementController(
  repository: BlacklistRepository,
  lock: Pick<BlacklistLockCoordinator, "runExclusive">,
  statusController: StatusController,
): BlacklistManagementController {
  async function handleMutation(request: ManagementMutationRequest): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        try {
          await repository.querySummary();
        } catch {
          return createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
        }
        try {
          return await runManagementMutation(repository, request);
        } catch {
          return createBlacklistRpcResponse(request.operation, false, {}, "save-failed");
        }
      });
    } catch {
      return createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
    }
  }

  return {
    async handle(request) {
      if (request.operation !== "status") return handleMutation(request);
      try {
        const result = await statusController.query();
        return createBlacklistRpcResponse("status", true, {
          status: result.status,
          count: result.count,
        });
      } catch {
        return createBlacklistRpcResponse("status", true, {
          status: "connection-error",
          count: 0,
        });
      }
    },
  };
}
