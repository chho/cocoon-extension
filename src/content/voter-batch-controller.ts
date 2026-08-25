import type { RemoteBlockCoordinator } from "./remote-block-coordinator.ts";
import type {
  CurrentUserResult,
  VoterFetchResult,
  VoterFetchProgress,
} from "./zhihu-remote-api.ts";
import type { ZhihuContentSource } from "./zhihu-content-source.ts";

const PERSIST_CONCURRENCY = 3;

export type VoterBatchPhase =
  "preparing" | "fetching" | "persisting" | "complete" | "stopped" | "failed";

export interface VoterBatchProgress {
  readonly phase: VoterBatchPhase;
  readonly fetched: number;
  readonly success: number;
  readonly failed: number;
  readonly skipped: number;
  readonly unprocessed: number;
  readonly dataComplete: boolean;
}

export interface VoterBatchRequest {
  readonly source: ZhihuContentSource;
  readonly tagId: string;
  readonly directAuthorUserId: string;
  readonly isStopped: () => boolean;
}

export interface VoterBatchControllerDependencies {
  readonly fetchCurrentUser: (isStopped: () => boolean) => Promise<CurrentUserResult>;
  readonly fetchVoters: (
    source: ZhihuContentSource,
    isStopped: () => boolean,
    onProgress: (progress: VoterFetchProgress) => void,
  ) => Promise<VoterFetchResult>;
  readonly coordinator: RemoteBlockCoordinator;
  readonly reportProgress: (progress: VoterBatchProgress) => void;
}

export interface VoterBatchController {
  run(request: VoterBatchRequest): Promise<VoterBatchProgress>;
}

function initialProgress(): VoterBatchProgress {
  return {
    phase: "preparing",
    fetched: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    unprocessed: 0,
    dataComplete: false,
  };
}

export function createVoterBatchController(
  dependencies: VoterBatchControllerDependencies,
): VoterBatchController {
  return {
    async run(request) {
      let progress = initialProgress();
      const report = (changes: Partial<VoterBatchProgress>): void => {
        progress = { ...progress, ...changes };
        dependencies.reportProgress(progress);
      };
      report({});

      const currentUser = await dependencies.fetchCurrentUser(request.isStopped);
      if (request.isStopped()) {
        report({ phase: "stopped" });
        return progress;
      }
      if (currentUser.status !== "success") {
        report({ phase: "failed" });
        return progress;
      }

      report({ phase: "fetching" });
      const voters = await dependencies.fetchVoters(
        request.source,
        request.isStopped,
        (fetchProgress) => {
          report({
            phase: "fetching",
            fetched: fetchProgress.unique,
            dataComplete: fetchProgress.complete,
          });
        },
      );
      let skipped = voters.invalid + voters.duplicates;
      report({
        fetched: voters.users.length,
        skipped,
        dataComplete: voters.complete,
      });

      if (request.isStopped()) {
        report({
          phase: "stopped",
          unprocessed: voters.users.length,
        });
        return progress;
      }
      if (voters.fatalReason !== null) {
        report({
          phase: "failed",
          unprocessed: voters.users.length,
        });
        return progress;
      }

      const queue = voters.users.filter((voter) => {
        const shouldSkip =
          voter.userId === currentUser.userId || voter.userId === request.directAuthorUserId;
        if (shouldSkip) {
          skipped += 1;
        }
        return !shouldSkip;
      });

      let nextIndex = 0;
      let started = 0;
      let stoppedAfterStart = 0;
      let success = 0;
      let failed = 0;
      report({
        phase: "persisting",
        skipped,
        unprocessed: queue.length,
      });

      async function worker(): Promise<void> {
        while (!request.isStopped()) {
          const index = nextIndex;
          if (index >= queue.length) {
            return;
          }
          nextIndex += 1;
          started += 1;
          const voter = queue[index];
          report({ unprocessed: Math.max(0, queue.length - started) });
          const result = await dependencies.coordinator.block(
            {
              source: "upvoter",
              userId: voter.userId,
              authorName: voter.authorName,
              tagId: request.tagId,
            },
            request.isStopped,
          );
          if (result.status === "success") {
            success += 1;
          } else if (result.status === "skipped") {
            skipped += 1;
          } else if (result.status === "stopped") {
            stoppedAfterStart += 1;
          } else {
            failed += 1;
          }
          report({ success, failed, skipped });
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(PERSIST_CONCURRENCY, queue.length) }, async () => worker()),
      );
      const unprocessed = queue.length - started + stoppedAfterStart;
      const phase = request.isStopped() ? "stopped" : "complete";
      report({ phase, success, failed, skipped, unprocessed });
      return progress;
    },
  };
}
