import type {
  BlacklistState,
  BlacklistedAuthor,
  CocoonTag,
} from "../content/blacklist-state.ts";
import type {
  BlacklistTransferEnvelope,
  BlacklistTransferAuthor,
} from "../core/blacklist-rpc-contract.ts";

const STORAGE_SCHEMA_VERSION = 5 as const;
const TRANSFER_PRODUCT = "cocoon-blacklist" as const;
const TRANSFER_FORMAT_VERSION = 1 as const;

export type BlacklistTransferMergePlan =
  | { readonly status: "conflict"; readonly state: BlacklistState }
  | { readonly status: "unchanged"; readonly state: BlacklistState }
  | { readonly status: "ready"; readonly state: BlacklistState };

function tagNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function identityKey(platformId: string, userId: string): string {
  return JSON.stringify([platformId, userId]);
}

function identifierKey(platformId: string, identifier: string): string {
  return JSON.stringify([platformId, identifier]);
}

function transferAuthorToStored(
  author: BlacklistTransferAuthor,
  tagId: string,
): BlacklistedAuthor {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorNameAtCapture,
    tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.blockSource,
  };
}

export function createBlacklistTransferEnvelope(
  state: BlacklistState,
  exportedAt: string,
): BlacklistTransferEnvelope {
  return {
    product: TRANSFER_PRODUCT,
    formatVersion: TRANSFER_FORMAT_VERSION,
    exportedAt,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    authors: state.authors.map((author) => ({ ...author })),
    tags: state.tags.map((tag) => ({ ...tag })),
  };
}

export function planBlacklistTransferMerge(
  local: BlacklistState,
  transfer: BlacklistTransferEnvelope,
): BlacklistTransferMergePlan {
  const tags: CocoonTag[] = [...local.tags];
  const localTagsById = new Map(local.tags.map((tag) => [tag.tagId, tag]));
  const localTagsByName = new Map(
    local.tags.map((tag) => [tagNameKey(tag.name), tag]),
  );
  const importedTagIdMap = new Map<string, string>();

  for (const importedTag of transfer.tags) {
    const sameId = localTagsById.get(importedTag.tagId);
    const sameName = localTagsByName.get(tagNameKey(importedTag.name));
    if (sameId && tagNameKey(sameId.name) !== tagNameKey(importedTag.name)) {
      return { status: "conflict", state: local };
    }
    if (sameName) {
      importedTagIdMap.set(importedTag.tagId, sameName.tagId);
      continue;
    }
    if (sameId) {
      importedTagIdMap.set(importedTag.tagId, sameId.tagId);
      continue;
    }

    const added = { ...importedTag };
    tags.push(added);
    localTagsById.set(added.tagId, added);
    localTagsByName.set(tagNameKey(added.name), added);
    importedTagIdMap.set(importedTag.tagId, added.tagId);
  }

  const authors: BlacklistedAuthor[] = [...local.authors];
  const localAuthorIdentities = new Set(
    local.authors.map((author) => identityKey(author.platformId, author.userId)),
  );
  const identifierOwners = new Set<string>();
  for (const author of local.authors) {
    identifierOwners.add(identifierKey(author.platformId, author.userId));
    if (author.memberHashId !== null) {
      identifierOwners.add(identifierKey(author.platformId, author.memberHashId));
    }
  }

  for (const importedAuthor of transfer.authors) {
    const importedIdentity = identityKey(
      importedAuthor.platformId,
      importedAuthor.userId,
    );
    if (localAuthorIdentities.has(importedIdentity)) {
      continue;
    }
    const identifiers = [importedAuthor.userId, importedAuthor.memberHashId]
      .filter((identifier): identifier is string => identifier !== null)
      .map((identifier) => identifierKey(importedAuthor.platformId, identifier));
    if (identifiers.some((identifier) => identifierOwners.has(identifier))) {
      return { status: "conflict", state: local };
    }
    const remappedTagId = importedTagIdMap.get(importedAuthor.tagId);
    if (!remappedTagId) {
      return { status: "conflict", state: local };
    }
    authors.push(transferAuthorToStored(importedAuthor, remappedTagId));
    localAuthorIdentities.add(importedIdentity);
    for (const identifier of identifiers) {
      identifierOwners.add(identifier);
    }
  }

  if (tags.length === local.tags.length && authors.length === local.authors.length) {
    return { status: "unchanged", state: local };
  }
  return {
    status: "ready",
    state: {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      tags,
      authors,
    },
  };
}

export function planBlacklistTransferReplace(
  transfer: BlacklistTransferEnvelope,
): BlacklistState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    tags: transfer.tags.map((tag) => ({ ...tag })),
    authors: transfer.authors.map((author) =>
      transferAuthorToStored(author, author.tagId)
    ),
  };
}
