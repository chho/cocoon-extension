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
  readonly sourcePostId: string | null;
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

async function persistVoterQueue(
  request: VoterBatchRequest,
  coordinator: RemoteBlockCoordinator,
  queue: VoterFetchResult["users"],
  progress: { skipped: number; report: (changes: Partial<VoterBatchProgress>) => void },
): Promise<void> {
  const counts = { success: 0, failed: 0, skipped: progress.skipped };
  const { report } = progress;
  let globalFailure = false;
  const isStopped = () => globalFailure || request.isStopped();
  let nextIndex = 0;
  let stoppedAfterStart = 0;
  report({ phase: "persisting", ...counts, unprocessed: queue.length });

  async function worker(): Promise<void> {
    while (!isStopped()) {
      const index = nextIndex;
      if (index >= queue.length) return;
      nextIndex += 1;
      const voter = queue[index];
      report({ unprocessed: queue.length - nextIndex });
      const result = await coordinator.block(
        {
          source: "upvoter",
          userId: voter.userId,
          authorName: voter.authorName,
          tagId: request.tagId,
          sourcePostId: request.sourcePostId,
        },
        isStopped,
      );
      if (result.status === "success") {
        counts.success += 1;
      } else if (result.status === "skipped") {
        counts.skipped += 1;
      } else if (result.status === "stopped") {
        stoppedAfterStart += 1;
      } else {
        counts.failed += 1;
        if (result.reason === "storage-global") globalFailure = true;
      }
      report(counts);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PERSIST_CONCURRENCY, queue.length) }, async () => worker()),
  );
  const unprocessed = queue.length - nextIndex + stoppedAfterStart;
  const phase = globalFailure ? "failed" : request.isStopped() ? "stopped" : "complete";
  report({ phase, ...counts, unprocessed });
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
      if (request.isStopped() || currentUser.status !== "success") {
        report({ phase: request.isStopped() ? "stopped" : "failed" });
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
      const skipped = voters.invalid + voters.duplicates;
      report({ fetched: voters.users.length, skipped, dataComplete: voters.complete });

      if (request.isStopped() || voters.fatalReason !== null) {
        report({
          phase: request.isStopped() ? "stopped" : "failed",
          unprocessed: voters.users.length,
        });
        return progress;
      }

      const queue = voters.users.filter(
        (voter) =>
          voter.userId !== currentUser.userId && voter.userId !== request.directAuthorUserId,
      );
      await persistVoterQueue(request, dependencies.coordinator, queue, {
        skipped: skipped + voters.users.length - queue.length,
        report,
      });
      return progress;
    },
  };
}
