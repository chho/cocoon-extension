import type { BlacklistedAuthor, CocoonTag } from "../../content/blacklist-state.ts";
import { ZHIHU_PLATFORM_ID } from "../../content/blacklist-state.ts";
import {
  createAuthorAliasPersistenceController,
  type AuthorAliasPersistenceController,
} from "../../content/author-alias-persistence-controller.ts";
import {
  createBackgroundBlacklistClient,
  type BackgroundBlacklistClient,
} from "../../content/background-blacklist-client.ts";
import type { BackgroundBlacklistGateway } from "../../content/background-blacklist-gateway.ts";
import { createIdentityBatchMatcher } from "../../content/identity-batch-matcher.ts";
import type { MemberUserIdResolver } from "../../content/resolve-member-user-id.ts";

interface ZhihuBlacklistIdentityRuntimeDependencies {
  readonly gateway: BackgroundBlacklistGateway;
  readonly resolveMemberUserId: MemberUserIdResolver;
  readonly applyTags: (tags: readonly CocoonTag[]) => void;
  readonly reevaluateRoots: () => void;
  readonly reportSyncFailure: () => void;
  readonly schedule: (callback: () => void) => () => void;
}

export interface ZhihuBlacklistIdentityRuntime {
  readonly client: BackgroundBlacklistClient;
  readonly aliasPersistence: AuthorAliasPersistenceController;
  match(identifiers: ReadonlySet<string>): Promise<"matched" | "unmatched" | "unavailable">;
}

function authorMatchIdentities(author: BlacklistedAuthor) {
  if (author.platformId !== ZHIHU_PLATFORM_ID) return [];
  const identifiers = [author.userId];
  if (author.memberHashId !== null) identifiers.push(author.memberHashId);
  return identifiers.map((identifier) => ({ platformId: ZHIHU_PLATFORM_ID, identifier }));
}

export function createZhihuBlacklistIdentityRuntime(
  dependencies: ZhihuBlacklistIdentityRuntimeDependencies,
): ZhihuBlacklistIdentityRuntime {
  const matcher = createIdentityBatchMatcher({
    query: (input) => dependencies.gateway.queryIdentityMatches(input),
    schedule: dependencies.schedule,
    onRevisionInvalidated: dependencies.reevaluateRoots,
  });
  const client = createBackgroundBlacklistClient({
    gateway: dependencies.gateway,
    applyTags: dependencies.applyTags,
    setRevision: (revision) => matcher.setRevision(revision),
    rememberAuthor(author, revision) {
      matcher.rememberMatches(authorMatchIdentities(author), revision);
      dependencies.reevaluateRoots();
    },
    reportSyncFailure: dependencies.reportSyncFailure,
  });
  const aliasPersistence = createAuthorAliasPersistenceController({
    resolveMemberUserId: dependencies.resolveMemberUserId,
    backfillMemberHash: (identity, memberHashId) =>
      client.backfillMemberHash(identity, memberHashId),
  });
  return {
    client,
    aliasPersistence,
    match(identifiers) {
      return matcher.match(
        Array.from(identifiers, (identifier) => ({
          platformId: ZHIHU_PLATFORM_ID,
          identifier,
        })),
      );
    },
  };
}
