import { CLOSED_DRAWER_STATE, reduceDrawerState, type DrawerState } from "./drawer-state.ts";
import type { CocoonTag } from "./blacklist-state";
import type { ZhihuContentSource } from "./zhihu-content-source.ts";
import type { SourcePost } from "../core/source-post.ts";

export interface DrawerAnchorBounds {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface DrawerTarget<TCard, TButton> {
  readonly targetId: string;
  readonly card: TCard;
  readonly button: TButton;
  readonly authorNameAtClick: string;
  readonly profileUserIdAtClick: string | null;
  readonly memberHashIdAtClick: string | null;
  readonly anchorBounds: DrawerAnchorBounds | null;
  readonly voterSource: ZhihuContentSource | null;
  // Absent uses card-time validation; null is an explicitly unavailable hover snapshot.
  readonly sourcePost?: SourcePost | null;
}

export interface RemoteAuthorization {
  readonly blockAuthorOnZhihu: boolean;
  readonly blockContentVoters: boolean;
}

export interface SubmissionPoint {
  readonly x: number;
  readonly y: number;
}

export interface TagSelection {
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
}

export interface CommitTask<TCard, TButton> {
  readonly target: DrawerTarget<TCard, TButton>;
  readonly selection: TagSelection;
  readonly remoteAuthorization: RemoteAuthorization;
}

export interface CancelInteraction {
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export type DrawerCommitOutcome = "completed" | "failed" | "incomplete";

export type SubmissionEndReason = DrawerCommitOutcome | "timeout" | "superseded" | "pagehide";
export type SubmissionObservation<TCard, TButton> =
  | { phase: "start"; signal: AbortSignal; task: CommitTask<TCard, TButton> }
  | { phase: "end"; signal: AbortSignal; reason: SubmissionEndReason };

function observeSubmission<TCard, TButton>(
  dependencies: DrawerControllerDependencies<TCard, TButton>,
  event: SubmissionObservation<TCard, TButton>,
): void {
  try {
    dependencies.observeSubmission?.(event);
  } catch {
    /* Observers cannot own submission success. */
  }
}

export interface DrawerControllerDependencies<TCard, TButton> {
  readonly observeSubmission?: (event: SubmissionObservation<TCard, TButton>) => void;
  readonly setSubmitting: (submitting: boolean) => void;
  readonly scheduleDeadline: (callback: () => void) => () => void;
  readonly reportIncomplete: () => void;
  readonly show: (target: DrawerTarget<TCard, TButton>) => void;
  readonly hide: () => void;
  readonly clearDraft: () => void;
  readonly focusInput: () => void;
  readonly restoreFocus: (button: TButton) => void;
  readonly getRemoteAuthorization: (target: DrawerTarget<TCard, TButton>) => RemoteAuthorization;
  readonly commit: (
    task: CommitTask<TCard, TButton>,
    signal: AbortSignal,
    point?: SubmissionPoint,
  ) => Promise<DrawerCommitOutcome>;
}

export interface DrawerController<TCard, TButton> {
  open(target: DrawerTarget<TCard, TButton>): void;
  setDraft(value: string): void;
  cancel(interaction?: CancelInteraction): void;
  submit(selection: TagSelection, point?: SubmissionPoint): void;
  dismiss(): void;
  getState(): DrawerState;
  getTarget(): DrawerTarget<TCard, TButton> | null;
}

class DrawerControllerImpl<TCard, TButton> implements DrawerController<TCard, TButton> {
  private state: DrawerState = CLOSED_DRAWER_STATE;
  private target: DrawerTarget<TCard, TButton> | null = null;
  private pending: AbortController | null = null;

  private readonly dependencies: DrawerControllerDependencies<TCard, TButton>;

  constructor(dependencies: DrawerControllerDependencies<TCard, TButton>) {
    this.dependencies = dependencies;
  }

  private releaseSubmission(reason: SubmissionEndReason = "superseded"): void {
    if (import.meta.env?.MODE !== "production" && this.pending) {
      observeSubmission(this.dependencies, { phase: "end", signal: this.pending.signal, reason });
    }
    this.pending?.abort("superseded");
    this.pending = null;
    this.dependencies.setSubmitting(false);
  }

  private close(restoreFocus: boolean, reason: SubmissionEndReason = "completed"): void {
    const closingTarget = this.target;
    this.releaseSubmission(reason);
    this.target = null;
    this.state = CLOSED_DRAWER_STATE;
    this.dependencies.hide();
    this.dependencies.clearDraft();
    if (restoreFocus && closingTarget) this.dependencies.restoreFocus(closingTarget.button);
  }

  open(nextTarget: DrawerTarget<TCard, TButton>): void {
    this.releaseSubmission();
    this.target = nextTarget;
    this.state = reduceDrawerState(this.state, { type: "open", targetId: nextTarget.targetId });
    this.dependencies.clearDraft();
    this.dependencies.show(nextTarget);
    this.dependencies.focusInput();
  }

  setDraft(value: string): void {
    this.state = reduceDrawerState(this.state, { type: "draft", value });
  }

  cancel(interaction?: CancelInteraction): void {
    if (this.state.status !== "open") return;
    interaction?.preventDefault();
    interaction?.stopImmediatePropagation();
    this.close(true);
  }

  submit(selection: TagSelection, point?: SubmissionPoint): void {
    if (this.state.status !== "open" || !this.target) return;
    const task = {
      target: this.target,
      selection,
      remoteAuthorization: this.dependencies.getRemoteAuthorization(this.target),
    };
    this.state = reduceDrawerState(this.state, { type: "submit" });
    this.pending = new AbortController();
    this.dependencies.setSubmitting(true);
    if (import.meta.env?.MODE !== "production") {
      observeSubmission(this.dependencies, { phase: "start", signal: this.pending.signal, task });
    }
    void this.finishSubmission(task, this.pending, point);
  }

  private async finishSubmission(
    task: CommitTask<TCard, TButton>,
    run: AbortController,
    point?: SubmissionPoint,
  ): Promise<void> {
    let interrupt: () => void = () => {};
    const interrupted = new Promise<DrawerCommitOutcome>((resolve) => {
      interrupt = () => resolve("incomplete");
      run.signal.addEventListener("abort", interrupt, { once: true });
    });
    const cancelDeadline = this.dependencies.scheduleDeadline(() => run.abort("timeout"));
    let outcome: DrawerCommitOutcome;
    try {
      // Cancelling UI ownership never cancels an already-dispatched database transaction.
      outcome = await Promise.race([
        this.dependencies.commit(task, run.signal, point),
        interrupted,
      ]);
    } catch {
      outcome = "incomplete";
    } finally {
      cancelDeadline();
      run.signal.removeEventListener("abort", interrupt);
    }
    if (this.pending !== run) return;
    this.close(outcome === "failed", run.signal.reason === "timeout" ? "timeout" : outcome);
    if (outcome === "incomplete") this.dependencies.reportIncomplete();
  }

  dismiss(): void {
    this.close(false, "pagehide");
  }
  getState(): DrawerState {
    return this.state;
  }
  getTarget(): DrawerTarget<TCard, TButton> | null {
    return this.target;
  }
}

export function createDrawerController<TCard, TButton>(
  dependencies: DrawerControllerDependencies<TCard, TButton>,
): DrawerController<TCard, TButton> {
  return new DrawerControllerImpl(dependencies);
}
