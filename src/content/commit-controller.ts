import type { AuthorMutationResult } from "../background/blacklist-repository-types.ts";
import {
  ZHIHU_PLATFORM_ID,
  createBlacklistTimestamp,
  normalizeMemberHashId,
  type CommitInput,
} from "./blacklist-state.ts";
import type { ProvenAuthorIdentity } from "./author-identity.ts";
import type { CommitTask, DrawerTarget } from "./drawer-controller.ts";

export type CommitResult =
  | {
      readonly status: "persisted";
      readonly userId: string;
      readonly blacklistedAt: string;
    }
  | { readonly status: "duplicate" }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly focusRestorationRequested: true;
    };

export interface CommitControllerDependencies<TCard, TButton> {
  readonly resolveAuthorIdentity: (
    target: DrawerTarget<TCard, TButton>,
  ) => Promise<ProvenAuthorIdentity | null>;
  readonly now: () => Date;
  readonly commitAuthor: (input: CommitInput) => Promise<AuthorMutationResult>;
  readonly requestFailureFocus: (button: TButton) => void;
  readonly reportFailure: (error: unknown) => void;
}

export interface CommitController<TCard, TButton> {
  commit(task: CommitTask<TCard, TButton>): Promise<CommitResult>;
}

export function createCommitController<TCard, TButton>(
  dependencies: CommitControllerDependencies<TCard, TButton>,
): CommitController<TCard, TButton> {
  return {
    async commit(task) {
      try {
        const identity = await dependencies.resolveAuthorIdentity(task.target);
        if (!identity) throw new Error("Unable to resolve a stable author ID.");
        const userId = normalizeMemberHashId(identity.userId) ?? identity.userId;
        const result = await dependencies.commitAuthor({
          platformId: ZHIHU_PLATFORM_ID,
          userId,
          memberHashId: normalizeMemberHashId(identity.memberHashId),
          authorNameAtCapture: task.target.authorNameAtClick,
          tag: task.selection.tag,
          isNewTag: task.selection.isNewTag,
          blacklistedAt: createBlacklistTimestamp(dependencies.now),
        });
        if (result.status === "invalid") {
          throw new Error("Unable to create a valid blacklist record.");
        }
        if (result.status === "duplicate") return { status: "duplicate" };
        if (result.author.blacklistedAt === null) {
          throw new Error("The persisted direct author timestamp is missing.");
        }
        return {
          status: "persisted",
          userId: result.author.userId,
          blacklistedAt: result.author.blacklistedAt,
        };
      } catch (error) {
        dependencies.reportFailure(error);
        dependencies.requestFailureFocus(task.target.button);
        return {
          status: "failed",
          error,
          focusRestorationRequested: true,
        };
      }
    },
  };
}
