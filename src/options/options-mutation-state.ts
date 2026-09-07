import type {
  BlacklistSummaryDto,
  BlacklistTagUsageDto,
} from "../core/blacklist-query-rpc-contract.ts";
import type {
  BlacklistAuthorDto,
  BlacklistAuthorIdentityDto,
  BlacklistRpcResponse,
  BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";
import type { AuthorListItem } from "../ui/blacklist-list-values.ts";

export interface DeletedTagState {
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly replacement: BlacklistTagUsageDto;
}

export interface RemovedAuthorState {
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly items: readonly AuthorListItem[];
  readonly totalCount: number;
}

function identityKey(identity: BlacklistAuthorIdentityDto): string {
  return JSON.stringify([identity.platformId, identity.userId]);
}

export function mutationSummary(response: BlacklistRpcResponse): BlacklistSummaryDto | null {
  const { revision, authorCount, tagCount } = response.data;
  return response.ok && revision !== null && authorCount !== null && tagCount !== null
    ? { revision, authorCount, tagCount }
    : null;
}

export function removedAuthorMatches(
  response: BlacklistRpcResponse,
  author: BlacklistAuthorDto,
): boolean {
  const removed = response.data.removed;
  return Boolean(
    response.ok &&
    removed &&
    removed.platformId === author.platformId &&
    removed.userId === author.userId,
  );
}

export function deletedTagCount(response: BlacklistRpcResponse, tagId: string): number | null {
  return response.ok && response.data.deletedTagId === tagId && response.data.migratedCount !== null
    ? response.data.migratedCount
    : null;
}

export function applyRenamedTagState(
  tags: readonly BlacklistTagUsageDto[],
  tag: BlacklistTagDto,
): readonly BlacklistTagUsageDto[] {
  return tags.map((candidate) =>
    candidate.tagId === tag.tagId ? { ...tag, authorCount: candidate.authorCount } : candidate,
  );
}

export function applyDeletedTagState(
  tags: readonly BlacklistTagUsageDto[],
  tagId: string,
  migratedCount: number,
): DeletedTagState | null {
  const deleted = tags.find((tag) => tag.tagId === tagId && !tag.isDefault);
  const defaultTag = tags.find((tag) => tag.isDefault && tag.tagId === "default");
  if (!deleted || !defaultTag || deleted.authorCount !== migratedCount) return null;
  const replacement = { ...defaultTag, authorCount: defaultTag.authorCount + migratedCount };
  return {
    replacement,
    tags: tags
      .filter((tag) => tag.tagId !== tagId)
      .map((tag) => (tag.tagId === replacement.tagId ? replacement : tag)),
  };
}

export function applyRemovedAuthorState(
  tags: readonly BlacklistTagUsageDto[],
  items: readonly AuthorListItem[],
  totalCount: number,
  identities: readonly BlacklistAuthorIdentityDto[],
): RemovedAuthorState {
  const removedKeys = new Set(identities.map(identityKey));
  const removedItems = items.filter(({ author }) =>
    removedKeys.has(identityKey({ platformId: author.platformId, userId: author.userId })),
  );
  const removedByTag = new Map<string, number>();
  for (const { author } of removedItems) {
    removedByTag.set(author.tagId, (removedByTag.get(author.tagId) ?? 0) + 1);
  }
  return {
    tags: tags.map((tag) => ({
      ...tag,
      authorCount: Math.max(0, tag.authorCount - (removedByTag.get(tag.tagId) ?? 0)),
    })),
    items: items.filter(
      ({ author }) =>
        !removedKeys.has(identityKey({ platformId: author.platformId, userId: author.userId })),
    ),
    totalCount: Math.max(0, totalCount - removedItems.length),
  };
}
