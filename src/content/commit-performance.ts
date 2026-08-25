import {
  createCommitController,
  type CommitController,
  type CommitControllerDependencies,
  type CommitResult,
} from "./commit-controller.ts";

export interface CommitPerformanceSummary {
  readonly status: CommitResult["status"];
  readonly totalMs: number;
  readonly identityMs: number;
  readonly lockWaitMs: number;
  readonly readMs: number;
  readonly writeMs: number;
  readonly applyMs: number;
  readonly otherMs: number;
  readonly authorCount: number | null;
  readonly tagCount: number | null;
}

export interface CommitPerformanceReporter {
  readonly now: () => number;
  readonly report: (summary: CommitPerformanceSummary) => void;
}

type AsyncPhase = "identityMs" | "writeMs";

interface MutableCommitPerformance {
  identityMs: number;
  lockWaitMs: number;
  readMs: number;
  writeMs: number;
  applyMs: number;
  authorCount: number | null;
  tagCount: number | null;
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

async function measureAsync<T>(
  metrics: MutableCommitPerformance,
  phase: AsyncPhase,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = now();
  try {
    return await operation();
  } finally {
    metrics[phase] += elapsed(now, startedAt);
  }
}

function reportSafely(
  reporter: CommitPerformanceReporter,
  status: CommitResult["status"],
  totalMs: number,
  metrics: MutableCommitPerformance,
): void {
  const measuredMs =
    metrics.identityMs + metrics.lockWaitMs + metrics.readMs + metrics.writeMs + metrics.applyMs;
  try {
    reporter.report({
      status,
      totalMs,
      ...metrics,
      otherMs: Math.max(0, totalMs - measuredMs),
    });
  } catch {
    // Diagnostics must never affect blocking behavior.
  }
}

function createMetrics(): MutableCommitPerformance {
  return {
    identityMs: 0,
    lockWaitMs: 0,
    readMs: 0,
    writeMs: 0,
    applyMs: 0,
    authorCount: null,
    tagCount: null,
  };
}

function instrumentDependencies<TCard, TButton>(
  dependencies: CommitControllerDependencies<TCard, TButton>,
  reporter: CommitPerformanceReporter,
  metrics: MutableCommitPerformance,
): CommitControllerDependencies<TCard, TButton> {
  return {
    ...dependencies,
    resolveAuthorIdentity: async (target) =>
      measureAsync(metrics, "identityMs", reporter.now, () =>
        dependencies.resolveAuthorIdentity(target),
      ),
    async commitAuthor(input) {
      const result = await measureAsync(metrics, "writeMs", reporter.now, () =>
        dependencies.commitAuthor(input),
      );
      metrics.authorCount = result.authorCount;
      metrics.tagCount = result.tagCount;
      return result;
    },
  };
}

export function createMeasuredCommitController<TCard, TButton>(
  dependencies: CommitControllerDependencies<TCard, TButton>,
  reporter: CommitPerformanceReporter,
): CommitController<TCard, TButton> {
  return {
    async commit(task) {
      const metrics = createMetrics();
      const totalStartedAt = reporter.now();
      const controller = createCommitController(
        instrumentDependencies(dependencies, reporter, metrics),
      );
      const result = await controller.commit(task);
      reportSafely(reporter, result.status, elapsed(reporter.now, totalStartedAt), metrics);
      return result;
    },
  };
}
