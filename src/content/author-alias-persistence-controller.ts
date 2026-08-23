import {
  ZHIHU_PLATFORM_ID,
  normalizeMemberHashId,
  planMemberHashBackfill,
  type BlacklistState,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";
import type { MemberUserIdResolver } from "./resolve-member-user-id.ts";

export type AuthorAliasPersistenceResult =
  | { readonly status: "persisted"; readonly state: BlacklistState }
  | { readonly status: "unchanged" }
  | { readonly status: "failed" };

export interface AuthorAliasPersistenceControllerDependencies {
  readonly resolveMemberUserId: MemberUserIdResolver;
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
  readonly applyPersistedState: (state: BlacklistState) => void;
}

export interface AuthorAliasPersistenceController {
  persistMemberHashAlias(
    memberHashId: string,
  ): Promise<AuthorAliasPersistenceResult>;
}

export function createAuthorAliasPersistenceController(
  dependencies: AuthorAliasPersistenceControllerDependencies,
): AuthorAliasPersistenceController {
  return {
    async persistMemberHashAlias(memberHashId) {
      const canonicalMemberHashId = normalizeMemberHashId(memberHashId);
      if (canonicalMemberHashId === null) {
        return { status: "failed" };
      }

      const userId = await dependencies.resolveMemberUserId(
        canonicalMemberHashId,
      );
      if (
        !userId ||
        normalizeMemberHashId(userId) === canonicalMemberHashId
      ) {
        return { status: "failed" };
      }

      try {
        return await dependencies.withExclusiveLock(async () => {
          const parsed = await dependencies.readState();
          if (parsed.status !== "valid") {
            return { status: "failed" };
          }

          const plan = planMemberHashBackfill(
            parsed.state,
            { platformId: ZHIHU_PLATFORM_ID, userId },
            canonicalMemberHashId,
          );
          if (plan.status === "already-present") {
            return { status: "unchanged" };
          }
          if (plan.status !== "ready") {
            return { status: "failed" };
          }

          await dependencies.writeState(plan.state);
          dependencies.applyPersistedState(plan.state);
          return { status: "persisted", state: plan.state };
        });
      } catch {
        return { status: "failed" };
      }
    },
  };
}
