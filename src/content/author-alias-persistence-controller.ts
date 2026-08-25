import type { AliasMutationResult } from "../background/blacklist-repository-types.ts";
import { ZHIHU_PLATFORM_ID, normalizeMemberHashId } from "./blacklist-state.ts";
import type { MemberUserIdResolver } from "./resolve-member-user-id.ts";

export type AuthorAliasPersistenceResult =
  | { readonly status: "persisted" }
  | { readonly status: "unchanged" }
  | { readonly status: "failed" };

export interface AuthorAliasPersistenceControllerDependencies {
  readonly resolveMemberUserId: MemberUserIdResolver;
  readonly backfillMemberHash: (
    identity: { readonly platformId: string; readonly userId: string },
    memberHashId: string,
  ) => Promise<AliasMutationResult>;
}

export interface AuthorAliasPersistenceController {
  persistMemberHashAlias(memberHashId: string): Promise<AuthorAliasPersistenceResult>;
}

export function createAuthorAliasPersistenceController(
  dependencies: AuthorAliasPersistenceControllerDependencies,
): AuthorAliasPersistenceController {
  return {
    async persistMemberHashAlias(memberHashId) {
      const canonicalMemberHashId = normalizeMemberHashId(memberHashId);
      if (canonicalMemberHashId === null) return { status: "failed" };
      const userId = await dependencies.resolveMemberUserId(canonicalMemberHashId);
      if (!userId || normalizeMemberHashId(userId) === canonicalMemberHashId) {
        return { status: "failed" };
      }
      try {
        const result = await dependencies.backfillMemberHash(
          { platformId: ZHIHU_PLATFORM_ID, userId },
          canonicalMemberHashId,
        );
        if (result.status === "invalid") return { status: "failed" };
        if (result.status === "unchanged") return { status: "unchanged" };
        return { status: "persisted" };
      } catch {
        return { status: "failed" };
      }
    },
  };
}
