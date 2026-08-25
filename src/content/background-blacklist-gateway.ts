import type {
  AliasMutationResult,
  AuthorMutationResult,
  BlacklistHydration,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import {
  createBlacklistContentRequest,
  parseBlacklistContentResponseEnvelope,
  type BlacklistContentOperation,
} from "../core/blacklist-content-rpc-contract.ts";
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

export interface BackgroundBlacklistGateway {
  hydrate(): Promise<BlacklistHydration>;
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

function parseHydration(value: unknown): BlacklistHydration | null {
  if (!isRecord(value) || !hasExactKeys(value, ["revision", "state"])) return null;
  const revision = parseCount(value.revision);
  const parsed = parseBlacklistState(value.state);
  return revision !== null && parsed.status === "valid" ? { state: parsed.state, revision } : null;
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
  if (!isRecord(value) || !hasExactKeys(value, [...MUTATION_KEYS, "deletedTagId"])) return null;
  if (!isTagDeletionStatus(value.status)) return null;
  const mutationContext = parseContext(value);
  if (!mutationContext) return null;
  if (value.status === "persisted") {
    return typeof value.deletedTagId === "string"
      ? { status: value.status, deletedTagId: value.deletedTagId, ...mutationContext }
      : null;
  }
  return value.deletedTagId === null
    ? { status: value.status, deletedTagId: null, ...mutationContext }
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

  async hydrate(): Promise<BlacklistHydration> {
    const value = await this.request("hydrate", createBlacklistContentRequest("hydrate", {}));
    const result = parseHydration(value);
    if (!result) throw new Error("Background returned an invalid blacklist hydration.");
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
