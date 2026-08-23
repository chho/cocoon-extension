import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  BlacklistState,
  BlacklistedAuthor,
} from "../content/blacklist-state.ts";
// The query creates a background-only module instance so Rollup does not make
// content.js depend on a shared extension-page chunk.
// @ts-expect-error Vite resolves the query-qualified copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import type * as RpcContractModule from "../core/blacklist-rpc-contract.ts";
import type {
  BlacklistAuthorDto,
  BlacklistRpcRequest,
  BlacklistRpcResponse,
  BlacklistSnapshotDto,
} from "../core/blacklist-rpc-contract.ts";
// @ts-expect-error Vite resolves the query-qualified copy during bundling.
import * as backgroundRpcContract from "../core/blacklist-rpc-contract.ts?background-copy";
import type { BlacklistLockCoordinator } from "./blacklist-lock-coordinator.ts";
import type { CurrentPageStatusResult } from "./status-controller.ts";

const {
  DEFAULT_TAG_ID,
  STORAGE_KEY,
  parseBlacklistState,
  planAuthorBatchRemoval,
  planAuthorRemoval,
  planAuthorRestoration,
  planTagDeletion,
  planTagRename,
} = backgroundBlacklistState as typeof BlacklistStateModule;
const { createBlacklistRpcResponse } =
  backgroundRpcContract as typeof RpcContractModule;

interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface StatusController {
  query(): Promise<CurrentPageStatusResult>;
}

export interface BlacklistManagementController {
  handle(request: BlacklistRpcRequest): Promise<BlacklistRpcResponse>;
}

function toAuthorDto(author: BlacklistedAuthor): BlacklistAuthorDto {
  return {
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
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorName,
    tagId: author.tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.source,
  };
}

function toSnapshot(state: BlacklistState): BlacklistSnapshotDto {
  return {
    authors: state.authors.map(toAuthorDto),
    tags: state.tags.map((tag) => ({
      tagId: tag.tagId,
      name: tag.name,
      isDefault: tag.tagId === DEFAULT_TAG_ID,
    })),
  };
}

export function createBlacklistManagementController(
  storage: LocalStorageArea,
  lock: Pick<BlacklistLockCoordinator, "runExclusive">,
  statusController: StatusController,
): BlacklistManagementController {
  async function readLatest(): Promise<ReturnType<typeof parseBlacklistState>> {
    const values = await storage.get(STORAGE_KEY);
    return parseBlacklistState(values[STORAGE_KEY] as unknown);
  }

  async function readInitializedLocked(): Promise<BlacklistState | null> {
    const parsed = await readLatest();
    if (parsed.status === "malformed") {
      return null;
    }
    if (parsed.status === "missing" || parsed.status === "migrated") {
      await storage.set({ [STORAGE_KEY]: parsed.state });
      const reread = await readLatest();
      return reread.status === "valid" ? reread.state : null;
    }
    return parsed.state;
  }

  async function snapshotResponse(
    request: BlacklistRpcRequest,
  ): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        const state = await readInitializedLocked();
        return state
          ? createBlacklistRpcResponse(request.operation, true, {
            snapshot: toSnapshot(state),
          })
          : createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "storage-unreadable",
          );
      });
    } catch {
      return createBlacklistRpcResponse(
        request.operation,
        false,
        {},
        "storage-unreadable",
      );
    }
  }

  async function mutate(
    request: Exclude<BlacklistRpcRequest, { readonly operation: "status" | "snapshot" }>,
  ): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        const parsed = await readLatest();
        if (parsed.status === "malformed") {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "storage-unreadable",
          );
        }
        const state = parsed.state;
        let candidate: BlacklistState;
        let removed: BlacklistedAuthor | null = null;

        switch (request.operation) {
          case "remove-one": {
            const plan = planAuthorRemoval(state, request.input.userId);
            if (plan.status !== "ready") {
              return createBlacklistRpcResponse(
                request.operation,
                false,
                { snapshot: toSnapshot(state) },
                "not-found",
              );
            }
            candidate = plan.state;
            removed = plan.removed;
            break;
          }
          case "restore-one": {
            const plan = planAuthorRestoration(
              state,
              fromAuthorDto(request.input.author),
            );
            if (plan.status !== "ready") {
              return createBlacklistRpcResponse(
                request.operation,
                false,
                { snapshot: toSnapshot(state) },
                plan.status === "missing-tag" ? "invalid-tag" : "conflict",
              );
            }
            candidate = plan.state;
            break;
          }
          case "remove-many": {
            const plan = planAuthorBatchRemoval(state, request.input.userIds);
            if (plan.status !== "ready") {
              return createBlacklistRpcResponse(
                request.operation,
                false,
                { snapshot: toSnapshot(state) },
                "not-found",
              );
            }
            candidate = plan.state;
            break;
          }
          case "rename-tag": {
            const plan = planTagRename(
              state,
              request.input.tagId,
              request.input.name,
            );
            if (plan.status === "unchanged") {
              return createBlacklistRpcResponse(request.operation, true, {
                snapshot: toSnapshot(state),
              });
            }
            if (plan.status !== "ready") {
              return createBlacklistRpcResponse(
                request.operation,
                false,
                { snapshot: toSnapshot(state) },
                "invalid-tag",
              );
            }
            candidate = plan.state;
            break;
          }
          case "delete-tag": {
            const plan = planTagDeletion(state, request.input.tagId);
            if (plan.status !== "ready") {
              return createBlacklistRpcResponse(
                request.operation,
                false,
                { snapshot: toSnapshot(state) },
                "invalid-tag",
              );
            }
            candidate = plan.state;
            break;
          }
        }

        try {
          await storage.set({ [STORAGE_KEY]: candidate });
        } catch {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            { snapshot: toSnapshot(state) },
            "save-failed",
          );
        }
        return createBlacklistRpcResponse(request.operation, true, {
          snapshot: toSnapshot(candidate),
          removed: removed ? toAuthorDto(removed) : null,
        });
      });
    } catch {
      return createBlacklistRpcResponse(
        request.operation,
        false,
        {},
        "storage-unreadable",
      );
    }
  }

  return {
    async handle(request) {
      if (request.operation === "status") {
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
      }
      if (request.operation === "snapshot") {
        return snapshotResponse(request);
      }
      return mutate(request);
    },
  };
}
