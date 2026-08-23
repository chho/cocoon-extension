import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  AuthorIdentity,
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
import {
  createBlacklistTransferEnvelope,
  planBlacklistTransferMerge,
  planBlacklistTransferReplace,
} from "./blacklist-transfer-planner.ts";
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
const {
  createBlacklistRpcResponse,
  isWithinBlacklistRpcLimit,
  parseBlacklistTransferEnvelope,
} = backgroundRpcContract as typeof RpcContractModule;

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

function toIdentity(author: {
  readonly platformId: string;
  readonly userId: string;
}): AuthorIdentity {
  return { platformId: author.platformId, userId: author.userId };
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

function responseWithinLimit(
  response: BlacklistRpcResponse,
): BlacklistRpcResponse | null {
  return isWithinBlacklistRpcLimit(response) ? response : null;
}

export function createBlacklistManagementController(
  storage: LocalStorageArea,
  lock: Pick<BlacklistLockCoordinator, "runExclusive">,
  statusController: StatusController,
  now: () => Date = () => new Date(),
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
        if (!state) {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "storage-unreadable",
          );
        }
        return responseWithinLimit(
          createBlacklistRpcResponse(request.operation, true, {
            snapshot: toSnapshot(state),
          }),
        ) ?? createBlacklistRpcResponse(
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

  async function exportResponse(): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        const parsed = await readLatest();
        if (parsed.status === "malformed") {
          return createBlacklistRpcResponse(
            "export-json",
            false,
            {},
            "storage-unreadable",
          );
        }
        let exportedAt: string;
        try {
          exportedAt = now().toISOString();
        } catch {
          return createBlacklistRpcResponse(
            "export-json",
            false,
            {},
            "storage-unreadable",
          );
        }
        const transfer = createBlacklistTransferEnvelope(
          parsed.state,
          exportedAt,
        );
        const validatedTransfer = parseBlacklistTransferEnvelope(transfer);
        if (validatedTransfer.status !== "valid") {
          return createBlacklistRpcResponse(
            "export-json",
            false,
            {},
            validatedTransfer.status === "too-large"
              ? "transfer-too-large"
              : "storage-unreadable",
          );
        }
        const success = createBlacklistRpcResponse("export-json", true, {
          transfer,
        });
        if (!responseWithinLimit(success)) {
          return createBlacklistRpcResponse(
            "export-json",
            false,
            {},
            "transfer-too-large",
          );
        }
        if (parsed.status === "missing" || parsed.status === "migrated") {
          try {
            await storage.set({ [STORAGE_KEY]: parsed.state });
          } catch {
            return createBlacklistRpcResponse(
              "export-json",
              false,
              {},
              "save-failed",
            );
          }
        }
        return success;
      });
    } catch {
      return createBlacklistRpcResponse(
        "export-json",
        false,
        {},
        "storage-unreadable",
      );
    }
  }

  async function importResponse(
    request: Extract<
      BlacklistRpcRequest,
      { readonly operation: "import-merge" | "import-replace" }
    >,
  ): Promise<BlacklistRpcResponse> {
    const parsedTransfer = parseBlacklistTransferEnvelope(request.input.transfer);
    if (parsedTransfer.status !== "valid") {
      return createBlacklistRpcResponse(
        request.operation,
        false,
        {},
        parsedTransfer.status === "too-large"
          ? "transfer-too-large"
          : "invalid-transfer",
      );
    }

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

        let candidate: BlacklistState;
        let unchanged = false;
        if (request.operation === "import-merge") {
          const plan = planBlacklistTransferMerge(
            parsed.state,
            parsedTransfer.transfer,
          );
          if (plan.status === "conflict") {
            return createBlacklistRpcResponse(
              request.operation,
              false,
              {},
              "transfer-conflict",
            );
          }
          candidate = plan.state;
          unchanged = plan.status === "unchanged" && parsed.status === "valid";
        } else {
          candidate = planBlacklistTransferReplace(parsedTransfer.transfer);
        }

        const success = createBlacklistRpcResponse(request.operation, true, {
          snapshot: toSnapshot(candidate),
        });
        if (!responseWithinLimit(success)) {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "transfer-too-large",
          );
        }
        if (unchanged) {
          return success;
        }
        try {
          await storage.set({ [STORAGE_KEY]: candidate });
        } catch {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "save-failed",
          );
        }
        return success;
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
    request: Exclude<
      BlacklistRpcRequest,
      {
        readonly operation:
          | "status"
          | "snapshot"
          | "export-json"
          | "import-merge"
          | "import-replace";
      }
    >,
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
            const plan = planAuthorRemoval(state, toIdentity(request.input.identity));
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
            const plan = planAuthorBatchRemoval(
              state,
              request.input.identities.map(toIdentity),
            );
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

        const success = createBlacklistRpcResponse(request.operation, true, {
          snapshot: toSnapshot(candidate),
          removed: removed ? toAuthorDto(removed) : null,
        });
        if (!responseWithinLimit(success)) {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "storage-unreadable",
          );
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
        return success;
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
      if (request.operation === "export-json") {
        return exportResponse();
      }
      if (request.operation === "import-merge" || request.operation === "import-replace") {
        return importResponse(request);
      }
      return mutate(request);
    },
  };
}
