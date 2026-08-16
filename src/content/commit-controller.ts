import {
  createBlacklistTimestamp,
  normalizeMemberHashId,
  planAuthorCommit,
  type BlacklistState,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";
import type { ProvenAuthorIdentity } from "./author-identity.ts";
import type {
  CommitTask,
  DrawerTarget,
} from "./drawer-controller.ts";

export type CommitResult =
  | {
      readonly status: "persisted";
      readonly state: BlacklistState;
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
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly resolveAuthorIdentity: (
    target: DrawerTarget<TCard, TButton>,
  ) => Promise<ProvenAuthorIdentity | null>;
  readonly now: () => Date;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
  readonly applyPersistedState: (state: BlacklistState) => void;
  readonly requestFailureFocus: (button: TButton) => void;
  readonly reportMalformedStorage: () => void;
  readonly reportFailure: (error: unknown) => void;
}

export interface CommitController<TCard, TButton> {
  commit(task: CommitTask<TCard, TButton>): Promise<CommitResult>;
}

export function createCommitController<TCard, TButton>(
  dependencies: CommitControllerDependencies<TCard, TButton>,
): CommitController<TCard, TButton> {
  async function executeLocked(
    task: CommitTask<TCard, TButton>,
    identity: ProvenAuthorIdentity,
  ): Promise<CommitResult> {
    const parsed = await dependencies.readState();
    if (parsed.status === "malformed") {
      dependencies.reportMalformedStorage();
    }
    const latestState = parsed.state;
    const canonicalIdentity: ProvenAuthorIdentity = {
      userId: normalizeMemberHashId(identity.userId) ?? identity.userId,
      memberHashId: normalizeMemberHashId(identity.memberHashId),
    };
    const existing = latestState.authors.find(
      (author) => author.userId === canonicalIdentity.userId,
    );

    if (existing) {
      const duplicatePlan = planAuthorCommit(latestState, {
        ...canonicalIdentity,
        authorNameAtCapture: task.target.authorNameAtClick,
        tag: task.selection.tag,
        isNewTag: task.selection.isNewTag,
        blacklistedAt: "",
      });
      if (duplicatePlan.status === "backfill") {
        await dependencies.writeState(duplicatePlan.state);
        dependencies.applyPersistedState(duplicatePlan.state);
        return { status: "duplicate" };
      }
      if (duplicatePlan.status === "duplicate") {
        dependencies.applyPersistedState(latestState);
        return { status: "duplicate" };
      }
      throw new Error("The author identity conflicts with stored aliases.");
    }

    const blacklistedAt = createBlacklistTimestamp(dependencies.now);
    const plan = planAuthorCommit(latestState, {
      ...canonicalIdentity,
      authorNameAtCapture: task.target.authorNameAtClick,
      tag: task.selection.tag,
      isNewTag: task.selection.isNewTag,
      blacklistedAt,
    });
    if (plan.status !== "ready") {
      throw new Error("Unable to create a valid blacklist record.");
    }

    await dependencies.writeState(plan.state);
    dependencies.applyPersistedState(plan.state);
    return {
      status: "persisted",
      state: plan.state,
      userId: canonicalIdentity.userId,
      blacklistedAt,
    };
  }

  return {
    async commit(task) {
      try {
        const identity = await dependencies.resolveAuthorIdentity(task.target);
        if (!identity) {
          throw new Error("Unable to resolve a stable author ID.");
        }
        return await dependencies.withExclusiveLock(async () =>
          executeLocked(task, identity)
        );
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
