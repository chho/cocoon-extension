import type {
  AliasMutationResult,
  AuthorMutationResult,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import type * as RevisionContractModule from "../core/blacklist-revision-contract.ts";
// @ts-expect-error Vite resolves the content-only copy during bundling.
import * as contentRevisionContract from "../core/blacklist-revision-contract.ts?content-copy";
import type {
  AuthorIdentity,
  BlacklistState,
  CommitInput,
  UpvoterCommitInput,
} from "./blacklist-state.ts";
import {
  createBlacklistSyncController,
  type BlacklistSyncController,
} from "./blacklist-sync-controller.ts";
import type { BackgroundBlacklistGateway } from "./background-blacklist-gateway.ts";

const { BLACKLIST_REVISION_STORAGE_KEY, parseBlacklistRevisionSignal } =
  contentRevisionContract as typeof RevisionContractModule;

export { BLACKLIST_REVISION_STORAGE_KEY };

export interface BackgroundBlacklistClient {
  initialize(): Promise<void>;
  commitAuthor(input: CommitInput): Promise<AuthorMutationResult>;
  backfillMemberHash(identity: AuthorIdentity, memberHashId: string): Promise<AliasMutationResult>;
  commitUpvoter(input: UpvoterCommitInput): Promise<AuthorMutationResult>;
  preflightDirect(
    identity: AuthorIdentity,
    expectedBlacklistedAt: string,
  ): Promise<{ readonly status: "ready" | "existing" }>;
  deleteTag(tagId: string): Promise<TagDeletionMutationResult>;
  handleRevisionValue(value: unknown): Promise<boolean>;
}

interface BackgroundBlacklistClientDependencies {
  readonly gateway: BackgroundBlacklistGateway;
  readonly applyState: (state: BlacklistState) => void;
  readonly reportSyncFailure: () => void;
}

async function finishMutation(
  sync: BlacklistSyncController,
  reportSyncFailure: () => void,
): Promise<void> {
  try {
    await sync.finishLocalMutation();
  } catch {
    reportSyncFailure();
  }
}

interface MutationOptions<Result> {
  readonly sync: BlacklistSyncController;
  readonly operation: () => Promise<Result>;
  readonly apply: (result: Result) => Promise<void>;
  readonly reportSyncFailure: () => void;
}

async function performMutation<Result>(options: MutationOptions<Result>): Promise<Result> {
  options.sync.beginLocalMutation();
  try {
    const result = await options.operation();
    try {
      await options.apply(result);
    } catch {
      options.reportSyncFailure();
    }
    return result;
  } finally {
    await finishMutation(options.sync, options.reportSyncFailure);
  }
}

function mutationOptions<Result>(
  sync: BlacklistSyncController,
  dependencies: BackgroundBlacklistClientDependencies,
  operation: () => Promise<Result>,
  apply: (result: Result) => Promise<void>,
): MutationOptions<Result> {
  return { sync, operation, apply, reportSyncFailure: dependencies.reportSyncFailure };
}

export function createBackgroundBlacklistClient(
  dependencies: BackgroundBlacklistClientDependencies,
): BackgroundBlacklistClient {
  const sync = createBlacklistSyncController({
    async hydrate() {
      return dependencies.gateway.hydrate();
    },
    applyState: dependencies.applyState,
  });
  return {
    initialize() {
      return sync.initialize();
    },
    commitAuthor(input) {
      const operation = async () => dependencies.gateway.commitAuthor(input);
      const apply = async (result: AuthorMutationResult) => sync.applyAuthorMutation(result);
      return performMutation(mutationOptions(sync, dependencies, operation, apply));
    },
    backfillMemberHash(identity, memberHashId) {
      const operation = async () => dependencies.gateway.backfillMemberHash(identity, memberHashId);
      const apply = async (result: AliasMutationResult) => sync.applyAliasMutation(result);
      return performMutation(mutationOptions(sync, dependencies, operation, apply));
    },
    commitUpvoter(input) {
      const operation = async () => dependencies.gateway.commitUpvoter(input);
      const apply = async (result: AuthorMutationResult) => sync.applyAuthorMutation(result);
      return performMutation(mutationOptions(sync, dependencies, operation, apply));
    },
    preflightDirect(identity, expectedBlacklistedAt) {
      return dependencies.gateway.preflightDirect(identity, expectedBlacklistedAt);
    },
    deleteTag(tagId) {
      const operation = async () => dependencies.gateway.deleteTag(tagId);
      const apply = async (result: TagDeletionMutationResult) => sync.applyTagDeletion(result);
      return performMutation(mutationOptions(sync, dependencies, operation, apply));
    },
    async handleRevisionValue(value) {
      const signal = parseBlacklistRevisionSignal(value);
      if (signal === null) return false;
      await sync.handleRevision(signal.revision);
      return true;
    },
  };
}
