import type { CocoonTag } from "../content/blacklist-state.ts";
import type { BlacklistAuthorListItemDto } from "../core/blacklist-query-rpc-contract.ts";
import type { StoredAuthor } from "./blacklist-idb-schema.ts";
import { SourcePostUnavailableError, sourcePostFrom } from "./blacklist-post-repository.ts";
import { logicalAuthor } from "./blacklist-repository-records.ts";

export function authorItem(author: StoredAuthor, tag: CocoonTag): BlacklistAuthorListItemDto {
  const logical = logicalAuthor(author);
  return {
    author: {
      platformId: logical.platformId,
      userId: logical.userId,
      memberHashId: logical.memberHashId,
      authorName: logical.authorNameAtCapture,
      tagId: logical.tagId,
      blacklistedAt: logical.blacklistedAt,
      source: logical.blockSource,
      sourcePostId: logical.sourcePostId,
      sourcePost: null,
    },
    tag: {
      tagId: tag.tagId,
      name: tag.name,
      isDefault: tag.tagId === "default",
    },
  };
}

// Leave room for the bounded cursor, summary and RPC envelope within the 256 KiB limit.
export function boundedAuthorItems(
  items: readonly BlacklistAuthorListItemDto[],
): BlacklistAuthorListItemDto[] {
  const selected: BlacklistAuthorListItemDto[] = [];
  const encoder = new TextEncoder();
  let bytes = 2;
  for (const item of items) {
    bytes += encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (bytes > 240 * 1024) break;
    selected.push(item);
  }
  if (items.length > 0 && selected.length === 0)
    throw new Error("Author query item exceeds the response budget.");
  return selected;
}

export async function hydrateSourcePosts(
  transaction: IDBTransaction,
  items: readonly BlacklistAuthorListItemDto[],
): Promise<BlacklistAuthorListItemDto[]> {
  const ids = new Set(
    items.map((item) => item.author.sourcePostId).filter((id): id is string => id !== null),
  );
  const posts = new Map(
    await Promise.all(
      [...ids].map(async (id) => [id, await sourcePostFrom(transaction, id)] as const),
    ),
  );
  return items.map((item) => {
    const sourcePost =
      item.author.sourcePostId === null ? null : posts.get(item.author.sourcePostId);
    if (
      item.author.sourcePostId !== null &&
      (!sourcePost || sourcePost.platformId !== item.author.platformId)
    )
      throw new SourcePostUnavailableError();
    return { ...item, author: { ...item.author, sourcePost: sourcePost ?? null } };
  });
}
