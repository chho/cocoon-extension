import {
  createBlacklistTimestamp,
  planAuthorCommit,
  type BlacklistState,
  type CardImage,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";
import type { CommitTask } from "./drawer-controller";
import { persistPlannedCommit } from "./persist-blacklist-state.ts";

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
  readonly resolveStableUserId: (card: TCard) => Promise<string | null>;
  readonly captureCardImage: (card: TCard) => Promise<CardImage>;
  readonly now: () => Date;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
  readonly applyPersistedState: (state: BlacklistState) => void;
  readonly requestFailureFocus: (button: TButton) => void;
  readonly reportMalformedStorage: () => void;
  readonly reportCaptureFailure: (error: unknown) => void;
  readonly reportImageOmitted: () => void;
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
  ): Promise<CommitResult> {
    const userId = await dependencies.resolveStableUserId(task.target.card);
    if (!userId) {
      throw new Error("Unable to resolve a stable author ID.");
    }

    const parsed = await dependencies.readState();
    if (parsed.status === "malformed") {
      dependencies.reportMalformedStorage();
    }
    const latestState = parsed.state;
    if (latestState.authors.some((author) => author.userId === userId)) {
      return { status: "duplicate" };
    }

    const blacklistedAt = createBlacklistTimestamp(dependencies.now);
    const preflight = planAuthorCommit(latestState, {
      userId,
      authorNameAtCapture: task.target.authorNameAtClick,
      tag: task.selection.tag,
      isNewTag: task.selection.isNewTag,
      blacklistedAt,
    });
    if (preflight.status !== "ready") {
      throw new Error("The selected tag is no longer valid.");
    }

    let cardImage: CardImage | undefined;
    try {
      cardImage = await dependencies.captureCardImage(task.target.card);
    } catch (error) {
      dependencies.reportCaptureFailure(error);
    }

    const plan = planAuthorCommit(latestState, {
      userId,
      authorNameAtCapture: task.target.authorNameAtClick,
      tag: task.selection.tag,
      isNewTag: task.selection.isNewTag,
      blacklistedAt,
      cardImage,
    });
    if (plan.status !== "ready") {
      throw new Error("Unable to create a valid blacklist record.");
    }
    if (cardImage && !plan.imageIncluded) {
      dependencies.reportImageOmitted();
    }

    const persisted = await persistPlannedCommit(plan, dependencies.writeState);
    if (persisted.omittedImageAfterWriteFailure) {
      dependencies.reportImageOmitted();
    }
    dependencies.applyPersistedState(persisted.state);
    return {
      status: "persisted",
      state: persisted.state,
      userId,
      blacklistedAt,
    };
  }

  return {
    async commit(task) {
      try {
        return await dependencies.withExclusiveLock(async () =>
          executeLocked(task),
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
