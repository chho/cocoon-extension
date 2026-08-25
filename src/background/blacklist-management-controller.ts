import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  AuthorIdentity,
  BlacklistState,
  BlacklistedAuthor,
} from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import type * as RpcContractModule from "../core/blacklist-rpc-contract.ts";
import type {
  BlacklistAuthorDto,
  BlacklistRpcError,
  BlacklistRpcRequest,
  BlacklistRpcResponse,
  BlacklistSnapshotDto,
} from "../core/blacklist-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundRpcContract from "../core/blacklist-rpc-contract.ts?background-copy";
import type { BlacklistLockCoordinator } from "./blacklist-lock-coordinator.ts";
import type { BlacklistRepository } from "./blacklist-repository-types.ts";
import {
  createBlacklistTransferEnvelope,
  planBlacklistTransferMerge,
  planBlacklistTransferReplace,
} from "./blacklist-transfer-planner.ts";
import type { CurrentPageStatusResult } from "./status-controller.ts";

const {
  DEFAULT_TAG_ID,
  planAuthorBatchRemoval,
  planAuthorRemoval,
  planAuthorRestoration,
  planTagDeletion,
  planTagRename,
} = backgroundBlacklistState as typeof BlacklistStateModule;
const { createBlacklistRpcResponse, isWithinBlacklistRpcLimit, parseBlacklistTransferEnvelope } =
  backgroundRpcContract as typeof RpcContractModule;

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

function responseWithinLimit(response: BlacklistRpcResponse): BlacklistRpcResponse | null {
  return isWithinBlacklistRpcLimit(response) ? response : null;
}

function snapshotResponse(
  operation: BlacklistRpcRequest["operation"],
  state: BlacklistState,
  removed: BlacklistedAuthor | null = null,
): BlacklistRpcResponse {
  return (
    responseWithinLimit(
      createBlacklistRpcResponse(operation, true, {
        snapshot: toSnapshot(state),
        removed: removed ? toAuthorDto(removed) : null,
      }),
    ) ?? createBlacklistRpcResponse(operation, false, {}, "storage-unreadable")
  );
}

function mutationFailure(
  operation: BlacklistRpcRequest["operation"],
  error: BlacklistRpcError,
  state: BlacklistState,
) {
  return {
    response: createBlacklistRpcResponse(operation, false, {}, error),
    state,
  };
}

type ManagementMutationRequest = Exclude<
  BlacklistRpcRequest,
  {
    readonly operation: "status" | "snapshot" | "export-json" | "import-merge" | "import-replace";
  }
>;

interface ManagementMutationOutcome {
  readonly response?: BlacklistRpcResponse;
  readonly removed?: BlacklistedAuthor;
  readonly state: BlacklistState;
}

function invalidCandidate(
  operation: BlacklistRpcRequest["operation"],
  candidate: BlacklistState,
  before: BlacklistState,
  removed: BlacklistedAuthor | null = null,
): ManagementMutationOutcome | null {
  const response = snapshotResponse(operation, candidate, removed);
  return response.ok ? null : { response, state: before };
}

async function removeOne(
  repository: BlacklistRepository,
  request: Extract<BlacklistRpcRequest, { readonly operation: "remove-one" }>,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  const identity = toIdentity(request.input.identity);
  const plan = planAuthorRemoval(before, identity);
  if (plan.status !== "ready") return mutationFailure(request.operation, "not-found", before);
  const invalid = invalidCandidate(request.operation, plan.state, before, plan.removed);
  if (invalid) return invalid;
  const result = await repository.removeAuthor(identity);
  return result.status === "persisted" && result.removed
    ? { removed: result.removed, state: plan.state }
    : mutationFailure(request.operation, "not-found", before);
}

async function restoreOne(
  repository: BlacklistRepository,
  request: Extract<BlacklistRpcRequest, { readonly operation: "restore-one" }>,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  const author = fromAuthorDto(request.input.author);
  const plan = planAuthorRestoration(before, author);
  if (plan.status !== "ready") {
    const error = plan.status === "missing-tag" ? "invalid-tag" : "conflict";
    return mutationFailure(request.operation, error, before);
  }
  const invalid = invalidCandidate(request.operation, plan.state, before);
  if (invalid) return invalid;
  const result = await repository.restoreAuthor(author);
  return result.status === "persisted"
    ? { state: plan.state }
    : mutationFailure(request.operation, "conflict", before);
}

async function removeMany(
  repository: BlacklistRepository,
  request: Extract<BlacklistRpcRequest, { readonly operation: "remove-many" }>,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  const identities = request.input.identities.map(toIdentity);
  const plan = planAuthorBatchRemoval(before, identities);
  if (plan.status !== "ready") return mutationFailure(request.operation, "not-found", before);
  const invalid = invalidCandidate(request.operation, plan.state, before);
  if (invalid) return invalid;
  const result = await repository.removeAuthors(identities);
  return result.status === "persisted"
    ? { state: plan.state }
    : mutationFailure(request.operation, "not-found", before);
}

async function renameTag(
  repository: BlacklistRepository,
  request: Extract<BlacklistRpcRequest, { readonly operation: "rename-tag" }>,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  const plan = planTagRename(before, request.input.tagId, request.input.name);
  if (plan.status !== "ready" && plan.status !== "unchanged") {
    return mutationFailure(request.operation, "invalid-tag", before);
  }
  const invalid = invalidCandidate(request.operation, plan.state, before);
  if (invalid) return invalid;
  const result = await repository.renameTag(request.input.tagId, request.input.name);
  return result.status === "persisted" || result.status === "unchanged"
    ? { state: plan.state }
    : mutationFailure(request.operation, "invalid-tag", before);
}

async function deleteTag(
  repository: BlacklistRepository,
  request: Extract<BlacklistRpcRequest, { readonly operation: "delete-tag" }>,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  const plan = planTagDeletion(before, request.input.tagId);
  if (plan.status !== "ready") return mutationFailure(request.operation, "invalid-tag", before);
  const invalid = invalidCandidate(request.operation, plan.state, before);
  if (invalid) return invalid;
  const result = await repository.deleteTag(request.input.tagId);
  return result.status === "persisted"
    ? { state: plan.state }
    : mutationFailure(request.operation, "invalid-tag", before);
}

function runManagementMutation(
  repository: BlacklistRepository,
  request: ManagementMutationRequest,
  before: BlacklistState,
): Promise<ManagementMutationOutcome> {
  switch (request.operation) {
    case "remove-one":
      return removeOne(repository, request, before);
    case "restore-one":
      return restoreOne(repository, request, before);
    case "remove-many":
      return removeMany(repository, request, before);
    case "rename-tag":
      return renameTag(repository, request, before);
    case "delete-tag":
      return deleteTag(repository, request, before);
  }
}

export function createBlacklistManagementController(
  repository: BlacklistRepository,
  lock: Pick<BlacklistLockCoordinator, "runExclusive">,
  statusController: StatusController,
  now: () => Date = () => new Date(),
): BlacklistManagementController {
  async function readState(): Promise<BlacklistState> {
    return (await repository.hydrate()).state;
  }

  async function handleSnapshot(request: BlacklistRpcRequest): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () =>
        snapshotResponse(request.operation, await readState()),
      );
    } catch {
      return createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
    }
  }

  async function handleExport(): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        const state = await readState();
        let exportedAt: string;
        try {
          exportedAt = now().toISOString();
        } catch {
          return createBlacklistRpcResponse("export-json", false, {}, "storage-unreadable");
        }
        const transfer = createBlacklistTransferEnvelope(state, exportedAt);
        const validated = parseBlacklistTransferEnvelope(transfer);
        if (validated.status !== "valid") {
          return createBlacklistRpcResponse(
            "export-json",
            false,
            {},
            validated.status === "too-large" ? "transfer-too-large" : "storage-unreadable",
          );
        }
        return (
          responseWithinLimit(createBlacklistRpcResponse("export-json", true, { transfer })) ??
          createBlacklistRpcResponse("export-json", false, {}, "transfer-too-large")
        );
      });
    } catch {
      return createBlacklistRpcResponse("export-json", false, {}, "storage-unreadable");
    }
  }

  async function persistReplacement(
    operation: "import-merge" | "import-replace",
    candidate: BlacklistState,
  ): Promise<BlacklistRpcResponse> {
    const prospective = snapshotResponse(operation, candidate);
    if (!prospective.ok) return prospective;
    try {
      const persisted = await repository.replaceAll(candidate);
      return snapshotResponse(operation, persisted.state);
    } catch {
      return createBlacklistRpcResponse(operation, false, {}, "save-failed");
    }
  }

  async function handleImport(
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
        parsedTransfer.status === "too-large" ? "transfer-too-large" : "invalid-transfer",
      );
    }
    try {
      return await lock.runExclusive(async () => {
        const state = await readState();
        if (request.operation === "import-replace") {
          return persistReplacement(
            request.operation,
            planBlacklistTransferReplace(parsedTransfer.transfer),
          );
        }
        const plan = planBlacklistTransferMerge(state, parsedTransfer.transfer);
        if (plan.status === "conflict") {
          return createBlacklistRpcResponse(request.operation, false, {}, "transfer-conflict");
        }
        return plan.status === "unchanged"
          ? snapshotResponse(request.operation, state)
          : persistReplacement(request.operation, plan.state);
      });
    } catch {
      return createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
    }
  }

  async function handleMutation(
    request: Exclude<
      BlacklistRpcRequest,
      {
        readonly operation:
          "status" | "snapshot" | "export-json" | "import-merge" | "import-replace";
      }
    >,
  ): Promise<BlacklistRpcResponse> {
    try {
      return await lock.runExclusive(async () => {
        const before = await readState();
        let result: ManagementMutationOutcome;
        try {
          result = await runManagementMutation(repository, request, before);
        } catch {
          return createBlacklistRpcResponse(
            request.operation,
            false,
            { snapshot: toSnapshot(before) },
            "save-failed",
          );
        }
        if (result.response) {
          return {
            ...result.response,
            data: { ...result.response.data, snapshot: toSnapshot(result.state) },
          };
        }
        return snapshotResponse(request.operation, result.state, result.removed ?? null);
      });
    } catch {
      return createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
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
      if (request.operation === "snapshot") return handleSnapshot(request);
      if (request.operation === "export-json") return handleExport();
      if (request.operation === "import-merge" || request.operation === "import-replace") {
        return handleImport(request);
      }
      return handleMutation(request);
    },
  };
}
