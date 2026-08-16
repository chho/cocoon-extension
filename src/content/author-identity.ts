import { normalizeMemberHashId } from "./blacklist-state.ts";
import type { MemberUserIdResolver } from "./resolve-member-user-id.ts";

export interface AuthorIdentityEvidence {
  readonly profileUserId: string | null;
  readonly memberHashId: string | null;
}

export interface ProvenAuthorIdentity {
  readonly userId: string;
  readonly memberHashId: string | null;
}

export async function resolveProvenAuthorIdentity(
  evidence: AuthorIdentityEvidence,
  resolveMemberUserId: MemberUserIdResolver,
): Promise<ProvenAuthorIdentity | null> {
  const profileUserId = evidence.profileUserId;
  const profileMemberHashId = normalizeMemberHashId(profileUserId);
  const metadataHashId = normalizeMemberHashId(evidence.memberHashId);

  if (profileUserId) {
    if (profileMemberHashId) {
      const canonicalUserId = await resolveMemberUserId(profileMemberHashId);
      return canonicalUserId &&
          normalizeMemberHashId(canonicalUserId) !== profileMemberHashId
        ? { userId: canonicalUserId, memberHashId: profileMemberHashId }
        : null;
    }

    return { userId: profileUserId, memberHashId: metadataHashId };
  }

  if (!metadataHashId) {
    return null;
  }
  const canonicalUserId = await resolveMemberUserId(metadataHashId);
  return canonicalUserId
    ? { userId: canonicalUserId, memberHashId: metadataHashId }
    : null;
}
