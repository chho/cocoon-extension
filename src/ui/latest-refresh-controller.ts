export interface LatestRefreshController {
  request(): Promise<void>;
  invalidate(): void;
}

export interface LatestRefreshDependencies<Value> {
  readonly load: () => Promise<Value>;
  readonly apply: (value: Value) => void;
  readonly fail: () => void;
}

export function createLatestRefreshController<Value>(
  dependencies: LatestRefreshDependencies<Value>,
): LatestRefreshController {
  let generation = 0;
  let pending = false;
  let running: Promise<void> | null = null;

  async function drain(): Promise<void> {
    try {
      while (pending) {
        pending = false;
        const requestGeneration = generation;
        try {
          const value = await dependencies.load();
          if (requestGeneration === generation) {
            dependencies.apply(value);
          }
        } catch {
          if (requestGeneration === generation) {
            dependencies.fail();
          }
        }
      }
    } finally {
      // Clear ownership before this drain settles. A request queued by the
      // terminal apply/fail microtask will then start a new drain rather than
      // attaching pending work to an already-settled promise.
      running = null;
      if (pending) {
        running = drain();
      }
    }
  }

  return {
    request() {
      generation += 1;
      pending = true;
      if (running === null) {
        running = drain();
      }
      return running;
    },
    invalidate() {
      generation += 1;
      pending = false;
    },
  };
}
