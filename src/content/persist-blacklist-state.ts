import type { BlacklistState, CommitPlan } from "./blacklist-state";

export type BlacklistStateWriter = (state: BlacklistState) => Promise<void>;

export interface PersistedCommit {
  readonly state: BlacklistState;
  readonly omittedImageAfterWriteFailure: boolean;
}

export async function persistPlannedCommit(
  plan: Extract<CommitPlan, { status: "ready" }>,
  writeState: BlacklistStateWriter,
): Promise<PersistedCommit> {
  if (!plan.imageIncluded) {
    await writeState(plan.withoutImage);
    return {
      state: plan.withoutImage,
      omittedImageAfterWriteFailure: false,
    };
  }

  try {
    await writeState(plan.withImage);
    return {
      state: plan.withImage,
      omittedImageAfterWriteFailure: false,
    };
  } catch {
    await writeState(plan.withoutImage);
    return {
      state: plan.withoutImage,
      omittedImageAfterWriteFailure: true,
    };
  }
}
