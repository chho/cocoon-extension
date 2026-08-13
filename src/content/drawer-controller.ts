import {
  CLOSED_DRAWER_STATE,
  reduceDrawerState,
  type DrawerState,
} from "./drawer-state.ts";
import type { CocoonTag } from "./blacklist-state";

export interface DrawerTarget<TCard, TButton> {
  readonly targetId: string;
  readonly card: TCard;
  readonly button: TButton;
  readonly authorNameAtClick: string;
}

export interface TagSelection {
  readonly tag: CocoonTag;
  readonly isNewTag: boolean;
}

export interface CommitTask<TCard, TButton> {
  readonly target: DrawerTarget<TCard, TButton>;
  readonly selection: TagSelection;
}

export interface CancelInteraction {
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface DrawerControllerDependencies<TCard, TButton> {
  readonly show: (target: DrawerTarget<TCard, TButton>) => void;
  readonly hide: () => void;
  readonly clearDraft: () => void;
  readonly focusInput: () => void;
  readonly restoreFocus: (button: TButton) => void;
  readonly commit: (task: CommitTask<TCard, TButton>) => void;
}

export interface DrawerController<TCard, TButton> {
  open(target: DrawerTarget<TCard, TButton>): void;
  setDraft(value: string): void;
  cancel(interaction?: CancelInteraction): void;
  submit(selection: TagSelection): void;
  getState(): DrawerState;
  getTarget(): DrawerTarget<TCard, TButton> | null;
}

export function createDrawerController<TCard, TButton>(
  dependencies: DrawerControllerDependencies<TCard, TButton>,
): DrawerController<TCard, TButton> {
  let state: DrawerState = CLOSED_DRAWER_STATE;
  let target: DrawerTarget<TCard, TButton> | null = null;

  function close(restoreFocus: boolean): DrawerTarget<TCard, TButton> | null {
    const closingTarget = target;
    target = null;
    state = reduceDrawerState(state, { type: "close" });
    dependencies.hide();
    dependencies.clearDraft();
    if (restoreFocus && closingTarget) {
      dependencies.restoreFocus(closingTarget.button);
    }
    return closingTarget;
  }

  return {
    open(nextTarget) {
      target = nextTarget;
      state = reduceDrawerState(state, {
        type: "open",
        targetId: nextTarget.targetId,
      });
      dependencies.clearDraft();
      dependencies.show(nextTarget);
      dependencies.focusInput();
    },

    setDraft(value) {
      state = reduceDrawerState(state, { type: "draft", value });
    },

    cancel(interaction) {
      if (state.status !== "open") {
        return;
      }
      interaction?.preventDefault();
      interaction?.stopImmediatePropagation();
      close(true);
    },

    submit(selection) {
      if (state.status !== "open" || !target) {
        return;
      }
      const submittedTarget = close(false);
      if (submittedTarget) {
        dependencies.commit({ target: submittedTarget, selection });
      }
    },

    getState() {
      return state;
    },

    getTarget() {
      return target;
    },
  };
}
