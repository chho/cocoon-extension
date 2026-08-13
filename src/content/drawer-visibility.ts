export type DrawerVisibilityPhase =
  | "hidden"
  | "opening"
  | "open"
  | "closing";

export interface DrawerMotionContract {
  readonly offsetPixels: number;
  readonly enterDurationMilliseconds: number;
  readonly exitDurationMilliseconds: number;
  readonly animatedProperties: readonly ["transform", "opacity"];
}

export function getDrawerMotionContract(
  prefersReducedMotion: boolean,
): DrawerMotionContract {
  return {
    offsetPixels: prefersReducedMotion ? 0 : 8,
    enterDurationMilliseconds: prefersReducedMotion ? 80 : 120,
    exitDurationMilliseconds: prefersReducedMotion ? 80 : 120,
    animatedProperties: ["transform", "opacity"],
  };
}

export interface DrawerVisibilityDependencies {
  readonly setHidden: (hidden: boolean) => void;
  readonly setInert: (inert: boolean) => void;
  readonly setPhase: (phase: DrawerVisibilityPhase) => void;
  readonly scheduleFrame: (callback: () => void) => void;
  readonly scheduleExit: (callback: () => void) => () => void;
}

export interface DrawerVisibilityController {
  open(): void;
  close(): void;
  getPhase(): DrawerVisibilityPhase;
}

export function createDrawerVisibilityController(
  dependencies: DrawerVisibilityDependencies,
): DrawerVisibilityController {
  let phase: DrawerVisibilityPhase = "hidden";
  let revision = 0;
  let cancelScheduledExit: (() => void) | null = null;

  function setPhase(nextPhase: DrawerVisibilityPhase): void {
    phase = nextPhase;
    dependencies.setPhase(nextPhase);
  }

  function finishClose(closeRevision: number): void {
    if (revision !== closeRevision || phase !== "closing") {
      return;
    }

    cancelScheduledExit = null;
    dependencies.setHidden(true);
    setPhase("hidden");
  }

  return {
    open() {
      revision += 1;
      const openRevision = revision;
      cancelScheduledExit?.();
      cancelScheduledExit = null;
      dependencies.setHidden(false);
      dependencies.setInert(false);
      setPhase("opening");
      // Two frames guarantee that the browser paints the offset opening state
      // before transitioning to the final position.
      dependencies.scheduleFrame(() => {
        dependencies.scheduleFrame(() => {
          if (revision === openRevision && phase === "opening") {
            setPhase("open");
          }
        });
      });
    },

    close() {
      if (phase === "hidden" || phase === "closing") {
        return;
      }

      revision += 1;
      const closeRevision = revision;
      dependencies.setInert(true);
      setPhase("closing");
      cancelScheduledExit?.();
      cancelScheduledExit = dependencies.scheduleExit(() => {
        finishClose(closeRevision);
      });
    },

    getPhase() {
      return phase;
    },
  };
}
