import type { RemoteBlockCoordinator, UserBlockRequest } from "./remote-block-coordinator.ts";
import { observeVoters, type VoterObserver } from "./voter-observation.ts";
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
  readonly observer?: VoterObserver;
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

interface PersistenceProgress {
  skipped: number;
  report: (changes: Partial<VoterBatchProgress>) => void;
  observer?: VoterObserver;
}

function createUpvoterRequest(
  request: VoterBatchRequest,
  voter: VoterFetchResult["users"][number],
): UserBlockRequest {
  return {
    source: "upvoter",
    userId: voter.userId,
    authorName: voter.authorName,
    tagId: request.tagId,
    sourcePostId: request.sourcePostId,
  };
}

async function persistVoterQueue(
  request: VoterBatchRequest,
  coordinator: RemoteBlockCoordinator,
  queue: VoterFetchResult["users"],
  progress: PersistenceProgress,
): Promise<void> {
  const counts = { success: 0, failed: 0, skipped: progress.skipped };
  const { report, observer } = progress;
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
      observeVoters(observer, { kind: "dispatch" });
      const result = await coordinator.block(createUpvoterRequest(request, voter), isStopped);
      observeVoters(observer, {
        kind: "result",
        status: result.status,
        ...("reason" in result ? { reason: result.reason } : {}),
      });
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

async function fetchVotersWithProgress(
  dependencies: VoterBatchControllerDependencies,
  request: VoterBatchRequest,
  report: PersistenceProgress["report"],
): Promise<VoterFetchResult> {
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
  observeVoters(dependencies.observer, {
    kind: "fetch",
    fetched: voters.fetched,
    unique: voters.users.length,
    invalid: voters.invalid,
    duplicates: voters.duplicates,
    complete: voters.complete,
    requestFailures: voters.requestFailures,
    fatalReason: voters.fatalReason,
  });
  return voters;
}

async function prepareAndPersistVoters(
  dependencies: VoterBatchControllerDependencies,
  request: VoterBatchRequest,
  report: (changes: Partial<VoterBatchProgress>) => void,
): Promise<void> {
  const { observer } = dependencies;
  const currentUser = await dependencies.fetchCurrentUser(request.isStopped);
  observeVoters(observer, {
    kind: "preparation",
    status: currentUser.status,
    ...("reason" in currentUser ? { reason: currentUser.reason } : {}),
  });
  if (request.isStopped() || currentUser.status !== "success") {
    report({ phase: request.isStopped() ? "stopped" : "failed" });
    return;
  }

  const voters = await fetchVotersWithProgress(dependencies, request, report);
  const skipped = voters.invalid + voters.duplicates;
  report({ fetched: voters.users.length, skipped, dataComplete: voters.complete });

  if (request.isStopped() || voters.fatalReason !== null) {
    report({
      phase: request.isStopped() ? "stopped" : "failed",
      unprocessed: voters.users.length,
    });
    return;
  }

  const queue = voters.users.filter(
    (voter) => voter.userId !== currentUser.userId && voter.userId !== request.directAuthorUserId,
  );
  const self = voters.users.filter((voter) => voter.userId === currentUser.userId).length;
  observeVoters(observer, {
    kind: "queue",
    eligible: queue.length,
    self,
    direct: voters.users.length - queue.length - self,
  });
  await persistVoterQueue(request, dependencies.coordinator, queue, {
    skipped: skipped + voters.users.length - queue.length,
    report,
    observer,
  });
}

export function createVoterBatchController(
  dependencies: VoterBatchControllerDependencies,
): VoterBatchController {
  return {
    async run(request) {
      let progress = initialProgress();
      let stage: "preparing" | "fetching" | "persisting" = "preparing";
      const report = (changes: Partial<VoterBatchProgress>): void => {
        progress = { ...progress, ...changes };
        const { phase } = progress;
        if (phase === "preparing" || phase === "fetching" || phase === "persisting") stage = phase;
        dependencies.reportProgress(progress);
      };
      observeVoters(dependencies.observer, { kind: "batch-start" });
      try {
        report({});
        await prepareAndPersistVoters(dependencies, request, report);
        const { phase, dataComplete } = progress;
        if (phase === "complete" || phase === "stopped" || phase === "failed") {
          observeVoters(dependencies.observer, { kind: "finish", phase, dataComplete });
        }
        return progress;
      } catch (error) {
        // Rejected workers do not cancel their peers; later receipts must remain observable.
        observeVoters(dependencies.observer, { kind: "exception", stage });
        throw error;
      }
    },
  };
}
