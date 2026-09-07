import { PopupQueryError, type PopupQueryData } from "./popup-query-client.ts";

interface PopupRevisionCoordinatorDependencies {
  readonly getQuery: () => string;
  readonly hasData: () => boolean;
  readonly load: (query: string, minimumRevision: number) => Promise<PopupQueryData>;
  readonly apply: (data: PopupQueryData) => void;
  readonly fail: () => void;
}

export interface PopupRevisionCoordinator {
  request(minimumRevision?: number): Promise<void>;
  invalidate(): void;
}

interface RefreshAttempt {
  readonly generation: number;
  readonly query: string;
  readonly minimumRevision: number;
}

class PopupRevisionCoordinatorImpl implements PopupRevisionCoordinator {
  private readonly dependencies: PopupRevisionCoordinatorDependencies;
  private revisionFloor = 0;
  private generation = 0;
  private pending = false;
  private running: Promise<void> | null = null;

  constructor(dependencies: PopupRevisionCoordinatorDependencies) {
    this.dependencies = dependencies;
  }

  request(minimumRevision = 0): Promise<void> {
    this.revisionFloor = Math.max(this.revisionFloor, minimumRevision);
    this.generation += 1;
    this.pending = true;
    this.running ??= this.drain();
    return this.running;
  }

  invalidate(): void {
    this.generation += 1;
    this.pending = false;
  }

  private currentAttempt(): RefreshAttempt {
    return {
      generation: this.generation,
      query: this.dependencies.getQuery(),
      minimumRevision: this.revisionFloor,
    };
  }

  private isCurrent(attempt: RefreshAttempt): boolean {
    return attempt.generation === this.generation && attempt.query === this.dependencies.getQuery();
  }

  private shouldFail(error: unknown): boolean {
    return (
      (error instanceof PopupQueryError && error.code === "storage-unreadable") ||
      !this.dependencies.hasData()
    );
  }

  private async runAttempt(attempt: RefreshAttempt): Promise<void> {
    try {
      const data = await this.dependencies.load(attempt.query, attempt.minimumRevision);
      if (this.isCurrent(attempt)) this.dependencies.apply(data);
    } catch (error) {
      if (this.isCurrent(attempt) && this.shouldFail(error)) this.dependencies.fail();
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.runAttempt(this.currentAttempt());
      }
    } finally {
      this.running = null;
      if (this.pending) this.running = this.drain();
    }
  }
}

export function createPopupRevisionCoordinator(
  dependencies: PopupRevisionCoordinatorDependencies,
): PopupRevisionCoordinator {
  return new PopupRevisionCoordinatorImpl(dependencies);
}
