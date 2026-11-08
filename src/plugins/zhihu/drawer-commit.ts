import type { CommitController, CommitResult } from "../../content/commit-controller.ts";
import type {
  CommitTask,
  DrawerCommitOutcome,
  SubmissionPoint,
} from "../../content/drawer-controller.ts";
import {
  readCommentContextDisposition,
  type CommentFilterController,
} from "../../content/comment-filter-controller.ts";
import { captureCommentExposure } from "./comment-exposure.ts";
import type { RemoteBackgroundRun } from "../../content/remote-background-runner.ts";
import { recordCommitReceipt, recordVisibility } from "../../diagnostics/content.ts";
import { waitForAuthorVisibility } from "./author-visibility.ts";

type Task = CommitTask<HTMLElement, HTMLButtonElement>;
interface DrawerCommitDependencies {
  readonly document: Document;
  readonly commitController: CommitController<HTMLElement, HTMLButtonElement>;
  readonly remoteBackgroundRunner: {
    run(task: Task, result: Extract<CommitResult, { status: "persisted" }>): RemoteBackgroundRun;
  };
  readonly cardRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly commentRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly readCardIdentifiers: (root: HTMLElement) => ReadonlySet<string>;
  readonly settleComment: CommentFilterController["waitForSettled"];
}

export function createDrawerCommitHandler(dependencies: DrawerCommitDependencies) {
  return async (
    task: Task,
    signal: AbortSignal,
    point?: SubmissionPoint,
  ): Promise<DrawerCommitOutcome> => {
    const contexts = captureCommentExposure(dependencies.document, point);
    const result = await dependencies.commitController.commit(task);
    if (import.meta.env?.MODE === "diagnostic") {
      recordCommitReceipt(dependencies.document, signal, result);
    }
    if (result.status === "persisted")
      void dependencies.remoteBackgroundRunner.run(task, result).completion;
    if (result.status === "failed") return "failed";
    if (signal.aborted) return "incomplete";
    const settlements = await Promise.all(
      contexts.map((context) => dependencies.settleComment(context, signal)),
    );
    if (
      settlements.some(
        (status, index) =>
          status === "aborted" ||
          (status === "unavailable" && readCommentContextDisposition(contexts[index]!) === null),
      )
    )
      return "incomplete";
    const visible = await waitForAuthorVisibility(
      result.author,
      {
        cardRoots: dependencies.cardRoots,
        commentRoots: dependencies.commentRoots,
        readCardIdentifiers: dependencies.readCardIdentifiers,
        observe:
          import.meta.env?.MODE === "diagnostic"
            ? (event) => recordVisibility(dependencies.document, signal, event)
            : undefined,
      },
      signal,
    );
    return visible ? "completed" : "incomplete";
  };
}
