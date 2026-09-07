import type {
  AliasMutationResult,
  AuthorMutationResult,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import {
  BLACKLIST_CONTENT_IDENTITY_BATCH_SIZE,
  BLACKLIST_CONTENT_TAG_PAGE_SIZE,
  MAX_BLACKLIST_CONTENT_CURSOR_BYTES,
  createBlacklistContentRequest,
  isBlacklistContentQueryIdentity,
  parseBlacklistContentResponseEnvelope,
  type BlacklistContentIdentityMatchInput,
  type BlacklistContentOperation,
  type BlacklistContentTagPageInput,
} from "../core/blacklist-content-rpc-contract.ts";
import type { BlacklistIdentityQueryDto } from "../core/blacklist-query-rpc-contract.ts";
import {
  DEFAULT_TAG_ID,
  parseBlacklistState,
  type AuthorIdentity,
  type BlacklistedAuthor,
  type CocoonTag,
  type CommitInput,
  type UpvoterCommitInput,
} from "./blacklist-state.ts";

interface RuntimeMessenger {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface ContentBlacklistInitialization {
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

export interface ContentTagDirectoryPage {
  readonly revision: number;
  readonly tags: readonly CocoonTag[];
  readonly nextCursor: string | null;
}

export interface ContentIdentityMatchResult {
  readonly revision: number;
  readonly matches: readonly BlacklistIdentityQueryDto[];
}

export interface BackgroundBlacklistGateway {
  initialize(): Promise<ContentBlacklistInitialization>;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

interface ParsedMutationContext {
  readonly baseRevision: number;
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

function parseContext(value: Record<string, unknown>): ParsedMutationContext | null {
  const baseRevision = parseCount(value.baseRevision);
  const revision = parseCount(value.revision);
  const authorCount = parseCount(value.authorCount);
  const tagCount = parseCount(value.tagCount);
  const revisionsMatch = baseRevision !== null && revision !== null && revision >= baseRevision;
  return revisionsMatch && authorCount !== null && tagCount !== null
    ? { baseRevision, revision, authorCount, tagCount }
    : null;
}

function parseTag(value: unknown): CocoonTag | null {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "tagId"])) return null;
  const candidate = { tagId: value.tagId, name: value.name };
  const tags =
    value.tagId === DEFAULT_TAG_ID
      ? [candidate]
      : [{ tagId: DEFAULT_TAG_ID, name: "default" }, candidate];
  const parsed = parseBlacklistState({ schemaVersion: 5, tags, authors: [] });
  return parsed.status === "valid" ? (parsed.state.tags.at(-1) ?? null) : null;
}

function parseAuthor(value: unknown): BlacklistedAuthor | null {
  if (!isRecord(value) || typeof value.tagId !== "string") return null;
  const tag =
    value.tagId === DEFAULT_TAG_ID
      ? { tagId: DEFAULT_TAG_ID, name: "default" }
      : { tagId: value.tagId, name: "Validation tag" };
  const tags =
    tag.tagId === DEFAULT_TAG_ID ? [tag] : [{ tagId: DEFAULT_TAG_ID, name: "default" }, tag];
  const parsed = parseBlacklistState({ schemaVersion: 5, tags, authors: [value] });
  return parsed.status === "valid" ? (parsed.state.authors[0] ?? null) : null;
}

function parseInitialization(value: unknown): ContentBlacklistInitialization | null {
  if (!isRecord(value) || !hasExactKeys(value, ["revision", "authorCount", "tagCount"])) {
    return null;
  }
  const revision = parseCount(value.revision);
  const authorCount = parseCount(value.authorCount);
  const tagCount = parseCount(value.tagCount);
  return revision !== null && authorCount !== null && tagCount !== null && tagCount >= 1
    ? { revision, authorCount, tagCount }
    : null;
}

function parseTagCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes <= MAX_BLACKLIST_CONTENT_CURSOR_BYTES ? value : undefined;
}

function hasUniqueTags(tags: readonly CocoonTag[]): boolean {
  const tagIds = new Set(tags.map(({ tagId }) => tagId));
  const tagNames = new Set(tags.map(({ name }) => name.toLocaleLowerCase()));
  return tagIds.size === tags.length && tagNames.size === tags.length;
}

function parseTagDirectoryPage(value: unknown): ContentTagDirectoryPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ["revision", "tags", "nextCursor"])) return null;
  if (!Array.isArray(value.tags) || value.tags.length > BLACKLIST_CONTENT_TAG_PAGE_SIZE)
    return null;
  const revision = parseCount(value.revision);
  const tags = value.tags.map(parseTag);
  const nextCursor = parseTagCursor(value.nextCursor);
  if (revision === null || nextCursor === undefined || tags.some((tag) => tag === null))
    return null;
  const parsedTags = tags as CocoonTag[];
  if (!hasUniqueTags(parsedTags)) return null;
  return { revision, tags: parsedTags, nextCursor };
}

function identityKey({ platformId, identifier }: BlacklistIdentityQueryDto): string {
  return JSON.stringify([platformId, identifier]);
}

function parseIdentityMatches(
  value: unknown,
  requested: readonly BlacklistIdentityQueryDto[],
): ContentIdentityMatchResult | null {
  if (!isRecord(value) || !hasExactKeys(value, ["matches", "revision"])) return null;
  const revision = parseCount(value.revision);
  if (
    revision === null ||
    !Array.isArray(value.matches) ||
    value.matches.length > BLACKLIST_CONTENT_IDENTITY_BATCH_SIZE ||
    !value.matches.every(isBlacklistContentQueryIdentity)
  ) {
    return null;
  }
  const matches = value.matches as BlacklistIdentityQueryDto[];
  const matchKeys = matches.map(identityKey);
  const requestedKeys = new Set(requested.map(identityKey));
  if (
    new Set(matchKeys).size !== matchKeys.length ||
    !matchKeys.every((key) => requestedKeys.has(key))
  ) {
    return null;
  }
  return { revision, matches };
}

const MUTATION_KEYS = ["authorCount", "baseRevision", "revision", "status", "tagCount"] as const;

function isInvalidAuthorMutation(value: Record<string, unknown>): boolean {
  return value.status === "invalid" && value.author === null && value.tag === null;
}

function isAuthorMutationStatus(value: unknown): value is "persisted" | "duplicate" {
  return value === "persisted" || value === "duplicate";
}

function parseAuthorMutation(value: unknown): AuthorMutationResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [...MUTATION_KEYS, "author", "tag"])) return null;
  const mutationContext = parseContext(value);
  if (!mutationContext) return null;
  if (isInvalidAuthorMutation(value)) {
    return { status: "invalid", author: null, tag: null, ...mutationContext };
  }
  if (!isAuthorMutationStatus(value.status)) return null;
  const author = parseAuthor(value.author);
  const tag = value.tag === null ? null : parseTag(value.tag);
  if (!author || (value.tag !== null && tag === null)) return null;
  return { status: value.status, author, tag, ...mutationContext };
}

function isInvalidAliasMutation(value: Record<string, unknown>): boolean {
  return value.status === "invalid" && value.author === null;
}

function isAliasMutationStatus(value: unknown): value is "persisted" | "unchanged" {
  return value === "persisted" || value === "unchanged";
}

function parseAliasMutation(value: unknown): AliasMutationResult | null {
  if (!isRecord(value) || !hasExactKeys(value, [...MUTATION_KEYS, "author"])) return null;
  const mutationContext = parseContext(value);
  if (!mutationContext) return null;
  if (isInvalidAliasMutation(value)) {
    return { status: "invalid", author: null, ...mutationContext };
  }
  if (!isAliasMutationStatus(value.status)) return null;
  const author = parseAuthor(value.author);
  return author ? { status: value.status, author, ...mutationContext } : null;
}

function isTagDeletionStatus(value: unknown): value is TagDeletionMutationResult["status"] {
  return value === "persisted" || value === "protected" || value === "missing";
}

function parseTagDeletion(value: unknown): TagDeletionMutationResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...MUTATION_KEYS, "deletedTagId", "migratedCount"])
  ) {
    return null;
  }
  if (!isTagDeletionStatus(value.status)) return null;
  const mutationContext = parseContext(value);
  const migratedCount = parseCount(value.migratedCount);
  if (!mutationContext || migratedCount === null) return null;
  if (value.status === "persisted") {
    return typeof value.deletedTagId === "string"
      ? {
          status: value.status,
          deletedTagId: value.deletedTagId,
          migratedCount,
          ...mutationContext,
        }
      : null;
  }
  return value.deletedTagId === null && migratedCount === 0
    ? { status: value.status, deletedTagId: null, migratedCount, ...mutationContext }
    : null;
}

function parsePreflight(value: unknown): { readonly status: "ready" | "existing" } | null {
  if (!isRecord(value) || !hasExactKeys(value, ["status"])) return null;
  return value.status === "ready" || value.status === "existing" ? { status: value.status } : null;
}

class RuntimeBackgroundBlacklistGateway implements BackgroundBlacklistGateway {
  private readonly runtime: RuntimeMessenger;

  constructor(runtime: RuntimeMessenger) {
    this.runtime = runtime;
  }

  private async request(operation: BlacklistContentOperation, message: unknown): Promise<unknown> {
    const envelope = parseBlacklistContentResponseEnvelope(
      await this.runtime.sendMessage(message),
      operation,
    );
    if (!envelope?.ok) throw new Error("Background blacklist operation failed.");
    return envelope.result;
  }

  async initialize(): Promise<ContentBlacklistInitialization> {
    const value = await this.request("initialize", createBlacklistContentRequest("initialize", {}));
    const result = parseInitialization(value);
    if (!result) throw new Error("Background returned invalid content initialization data.");
    return result;
  }

  async queryTagsPage(input: BlacklistContentTagPageInput): Promise<ContentTagDirectoryPage> {
    const value = await this.request(
      "tags-page",
      createBlacklistContentRequest("tags-page", input),
    );
    const result = parseTagDirectoryPage(value);
    if (!result || result.revision !== input.revision || result.tags.length > input.limit) {
      throw new Error("Background returned an invalid content tag page.");
    }
    return result;
  }

  async queryIdentityMatches(
    input: BlacklistContentIdentityMatchInput,
  ): Promise<ContentIdentityMatchResult> {
    const value = await this.request(
      "identity-match",
      createBlacklistContentRequest("identity-match", input),
    );
    const result = parseIdentityMatches(value, input.identities);
    if (!result || result.revision !== input.revision) {
      throw new Error("Background returned invalid content identity matches.");
    }
    return result;
  }

  async commitAuthor(input: CommitInput): Promise<AuthorMutationResult> {
    const value = await this.request(
      "commit-author",
      createBlacklistContentRequest("commit-author", { input }),
    );
    const result = parseAuthorMutation(value);
    if (!result) throw new Error("Background returned an invalid author mutation.");
    return result;
  }

  async backfillMemberHash(
    identity: AuthorIdentity,
    memberHashId: string,
  ): Promise<AliasMutationResult> {
    const message = createBlacklistContentRequest("backfill-member-hash", {
      identity,
      memberHashId,
    });
    const result = parseAliasMutation(await this.request("backfill-member-hash", message));
    if (!result) throw new Error("Background returned an invalid alias mutation.");
    return result;
  }

  async commitUpvoter(input: UpvoterCommitInput): Promise<AuthorMutationResult> {
    const message = createBlacklistContentRequest("commit-upvoter", { input });
    const result = parseAuthorMutation(await this.request("commit-upvoter", message));
    if (!result) throw new Error("Background returned an invalid upvoter mutation.");
    return result;
  }

  async preflightDirect(
    identity: AuthorIdentity,
    expectedBlacklistedAt: string,
  ): Promise<{ readonly status: "ready" | "existing" }> {
    const message = createBlacklistContentRequest("preflight-direct", {
      identity,
      expectedBlacklistedAt,
    });
    const result = parsePreflight(await this.request("preflight-direct", message));
    if (!result) throw new Error("Background returned an invalid direct preflight.");
    return result;
  }

  async deleteTag(tagId: string): Promise<TagDeletionMutationResult> {
    const message = createBlacklistContentRequest("delete-tag", { tagId });
    const result = parseTagDeletion(await this.request("delete-tag", message));
    if (!result) throw new Error("Background returned an invalid tag mutation.");
    return result;
  }
}

export function createBackgroundBlacklistGateway(
  runtime: RuntimeMessenger,
): BackgroundBlacklistGateway {
  return new RuntimeBackgroundBlacklistGateway(runtime);
}
