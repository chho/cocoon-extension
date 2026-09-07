import type {
  AliasMutationResult,
  AuthorMutationResult,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import {
  BLACKLIST_CONTENT_TAG_PAGE_SIZE,
  type BlacklistContentIdentityMatchInput,
  type BlacklistContentTagPageInput,
} from "../core/blacklist-content-rpc-contract.ts";
import type * as RevisionContractModule from "../core/blacklist-revision-contract.ts";
// @ts-expect-error Vite resolves the content-only copy during bundling.
import * as contentRevisionContract from "../core/blacklist-revision-contract.ts?content-copy";
import {
  parseBlacklistState,
  type AuthorIdentity,
  type BlacklistedAuthor,
  type CocoonTag,
  type CommitInput,
  type UpvoterCommitInput,
} from "./blacklist-state.ts";
import {
  createBlacklistSyncController,
  type BlacklistSyncController,
  type ContentBlacklistDirectory,
} from "./blacklist-sync-controller.ts";
import type {
  BackgroundBlacklistGateway,
  ContentIdentityMatchResult,
  ContentTagDirectoryPage,
} from "./background-blacklist-gateway.ts";

const { BLACKLIST_REVISION_STORAGE_KEY, parseBlacklistRevisionSignal } =
  contentRevisionContract as typeof RevisionContractModule;

export { BLACKLIST_REVISION_STORAGE_KEY };

export interface BackgroundBlacklistClient {
  initialize(): Promise<void>;
  queryTagsPage(input: BlacklistContentTagPageInput): Promise<ContentTagDirectoryPage>;
  queryIdentityMatches(
    input: BlacklistContentIdentityMatchInput,
  ): Promise<ContentIdentityMatchResult>;
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
  readonly applyTags: (tags: readonly CocoonTag[]) => void;
  readonly setRevision: (revision: number) => void;
  readonly rememberAuthor: (author: BlacklistedAuthor, revision: number) => void;
  readonly reportSyncFailure: () => void;
}

async function loadContentDirectory(
  gateway: BackgroundBlacklistGateway,
): Promise<ContentBlacklistDirectory> {
  const initialization = await gateway.initialize();
  const tags: CocoonTag[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await gateway.queryTagsPage({
      revision: initialization.revision,
      cursor,
      limit: BLACKLIST_CONTENT_TAG_PAGE_SIZE,
    });
    tags.push(...page.tags);
    cursor = page.nextCursor;
    if (cursor !== null && seenCursors.has(cursor)) {
      throw new Error("Background returned a repeated content tag cursor.");
    }
    if (cursor !== null) seenCursors.add(cursor);
  } while (cursor !== null);
  const parsed = parseBlacklistState({ schemaVersion: 5, authors: [], tags });
  if (parsed.status !== "valid" || parsed.state.tags.length !== initialization.tagCount) {
    throw new Error("Background returned an inconsistent content tag directory.");
  }
  return {
    revision: initialization.revision,
    authorCount: initialization.authorCount,
    tagCount: initialization.tagCount,
    tags: parsed.state.tags,
  };
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

class BackgroundBlacklistClientImpl implements BackgroundBlacklistClient {
  private readonly dependencies: BackgroundBlacklistClientDependencies;
  private readonly sync: BlacklistSyncController;

  constructor(dependencies: BackgroundBlacklistClientDependencies) {
    this.dependencies = dependencies;
    this.sync = createBlacklistSyncController({
      loadDirectory: async () => loadContentDirectory(dependencies.gateway),
      applyTags: dependencies.applyTags,
      setRevision: dependencies.setRevision,
      rememberAuthor: dependencies.rememberAuthor,
    });
  }

  initialize(): Promise<void> {
    return this.sync.initialize();
  }

  queryTagsPage(input: BlacklistContentTagPageInput): Promise<ContentTagDirectoryPage> {
    return this.dependencies.gateway.queryTagsPage(input);
  }

  queryIdentityMatches(
    input: BlacklistContentIdentityMatchInput,
  ): Promise<ContentIdentityMatchResult> {
    return this.dependencies.gateway.queryIdentityMatches(input);
  }

  // These callbacks are passed directly to controller dependencies; retain the client receiver.
  readonly commitAuthor = (input: CommitInput): Promise<AuthorMutationResult> => {
    return this.mutate(
      () => this.dependencies.gateway.commitAuthor(input),
      async (result) => this.sync.applyAuthorMutation(result),
    );
  };

  backfillMemberHash(identity: AuthorIdentity, memberHashId: string): Promise<AliasMutationResult> {
    return this.mutate(
      () => this.dependencies.gateway.backfillMemberHash(identity, memberHashId),
      async (result) => this.sync.applyAliasMutation(result),
    );
  }

  readonly commitUpvoter = (input: UpvoterCommitInput): Promise<AuthorMutationResult> => {
    return this.mutate(
      () => this.dependencies.gateway.commitUpvoter(input),
      async (result) => this.sync.applyAuthorMutation(result),
    );
  };

  preflightDirect(
    identity: AuthorIdentity,
    expectedBlacklistedAt: string,
  ): Promise<{ readonly status: "ready" | "existing" }> {
    return this.dependencies.gateway.preflightDirect(identity, expectedBlacklistedAt);
  }

  readonly deleteTag = (tagId: string): Promise<TagDeletionMutationResult> => {
    return this.mutate(
      () => this.dependencies.gateway.deleteTag(tagId),
      async (result) => this.sync.applyTagDeletion(result),
    );
  };

  async handleRevisionValue(value: unknown): Promise<boolean> {
    const signal = parseBlacklistRevisionSignal(value);
    if (signal === null) return false;
    await this.sync.handleRevision(signal.revision);
    return true;
  }

  private mutate<Result>(
    operation: () => Promise<Result>,
    apply: (result: Result) => Promise<void>,
  ): Promise<Result> {
    return performMutation(mutationOptions(this.sync, this.dependencies, operation, apply));
  }
}

export function createBackgroundBlacklistClient(
  dependencies: BackgroundBlacklistClientDependencies,
): BackgroundBlacklistClient {
  return new BackgroundBlacklistClientImpl(dependencies);
}
