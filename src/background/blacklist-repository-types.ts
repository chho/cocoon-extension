import type {
  AuthorIdentity,
  BlacklistState,
  BlacklistedAuthor,
  CocoonTag,
  CommitInput,
  UpvoterCommitInput,
} from "../content/blacklist-state.ts";

export interface BlacklistHydration {
  readonly state: BlacklistState;
  readonly revision: number;
}

export interface MutationContext {
  readonly baseRevision: number;
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
}

export type AuthorMutationResult = MutationContext &
  (
    | {
        readonly status: "persisted" | "duplicate";
        readonly author: BlacklistedAuthor;
        readonly tag: CocoonTag | null;
      }
    | {
        readonly status: "invalid";
        readonly author: null;
        readonly tag: null;
      }
  );

export type AliasMutationResult = MutationContext &
  (
    | {
        readonly status: "persisted" | "unchanged";
        readonly author: BlacklistedAuthor;
      }
    | { readonly status: "invalid"; readonly author: null }
  );

export type TagDeletionMutationResult = MutationContext & {
  readonly status: "persisted" | "protected" | "missing";
  readonly deletedTagId: string | null;
};

export type AuthorRemovalResult = MutationContext & {
  readonly status: "persisted" | "missing";
  readonly removed: BlacklistedAuthor | null;
};

export type AuthorRestorationResult = MutationContext & {
  readonly status: "persisted" | "conflict" | "missing-tag" | "invalid";
};

export type AuthorBatchRemovalResult = MutationContext & {
  readonly status: "persisted" | "empty" | "missing";
  readonly removedCount: number;
};

export type TagRenameResult = MutationContext & {
  readonly status: "persisted" | "unchanged" | "protected" | "missing" | "invalid";
  readonly tag: CocoonTag | null;
};

export interface DirectPreflightInput extends AuthorIdentity {
  readonly expectedBlacklistedAt: string;
}

export interface BlacklistRepository {
  hydrate(): Promise<BlacklistHydration>;
  commitAuthor(input: CommitInput): Promise<AuthorMutationResult>;
  backfillMemberHash(identity: AuthorIdentity, memberHashId: string): Promise<AliasMutationResult>;
  commitUpvoter(input: UpvoterCommitInput): Promise<AuthorMutationResult>;
  preflightDirect(input: DirectPreflightInput): Promise<{ readonly status: "ready" | "existing" }>;
  deleteTag(tagId: string): Promise<TagDeletionMutationResult>;
  removeAuthor(identity: AuthorIdentity): Promise<AuthorRemovalResult>;
  restoreAuthor(author: BlacklistedAuthor): Promise<AuthorRestorationResult>;
  removeAuthors(identities: readonly AuthorIdentity[]): Promise<AuthorBatchRemovalResult>;
  renameTag(tagId: string, name: string): Promise<TagRenameResult>;
  replaceAll(state: BlacklistState): Promise<BlacklistHydration>;
}
