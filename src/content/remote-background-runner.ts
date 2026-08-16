import type { CommitResult } from "./commit-controller.ts";
import type { CommitTask } from "./drawer-controller.ts";
import type { CoordinatedBlockResult } from "./remote-block-coordinator.ts";
import {
  runAuthorizedRemoteOperations,
  type RemoteOperationDispatch,
} from "./remote-operation-orchestrator.ts";
import type { VoterBatchProgress } from "./voter-batch-controller.ts";
import type { ZhihuContentSource } from "./zhihu-content-source.ts";

type PersistedCommit = Extract<CommitResult, { status: "persisted" }>;

export interface RemoteBackgroundRunnerDependencies<TCard, TButton> {
  readonly blockAuthor: (
    task: CommitTask<TCard, TButton>,
    committed: PersistedCommit,
  ) => Promise<CoordinatedBlockResult>;
  readonly blockVoters: (
    task: CommitTask<TCard, TButton>,
    committed: PersistedCommit,
    source: ZhihuContentSource,
  ) => Promise<VoterBatchProgress>;
  readonly reportFailure: (scope: "author" | "voters") => void;
}

export interface RemoteBackgroundResult {
  readonly author: CoordinatedBlockResult | undefined;
  readonly voters: VoterBatchProgress | undefined;
}

export interface RemoteBackgroundRun {
  readonly dispatch: RemoteOperationDispatch;
  readonly completion: Promise<RemoteBackgroundResult>;
}

export function createRemoteBackgroundRunner<TCard, TButton>(
  dependencies: RemoteBackgroundRunnerDependencies<TCard, TButton>,
): {
  run(
    task: CommitTask<TCard, TButton>,
    committed: PersistedCommit,
  ): RemoteBackgroundRun;
} {
  return {
    run(task, committed) {
      const operations: Promise<void>[] = [];
      let authorResult: CoordinatedBlockResult | undefined;
      let voterResult: VoterBatchProgress | undefined;
      const dispatch = runAuthorizedRemoteOperations(
        task.remoteAuthorization,
        task.target.voterSource,
        {
          blockAuthor() {
            operations.push((async () => {
              try {
                authorResult = await dependencies.blockAuthor(task, committed);
                if (authorResult.status === "failed") {
                  dependencies.reportFailure("author");
                }
              } catch {
                dependencies.reportFailure("author");
              }
            })());
          },
          blockVoters(source) {
            operations.push((async () => {
              try {
                voterResult = await dependencies.blockVoters(
                  task,
                  committed,
                  source,
                );
                if (
                  voterResult.phase === "failed" ||
                  voterResult.failed > 0 ||
                  !voterResult.dataComplete
                ) {
                  dependencies.reportFailure("voters");
                }
              } catch {
                dependencies.reportFailure("voters");
              }
            })());
          },
        },
      );

      return {
        dispatch,
        completion: (async () => {
          await Promise.all(operations);
          return {
            author: authorResult,
            voters: voterResult,
          };
        })(),
      };
    },
  };
}
