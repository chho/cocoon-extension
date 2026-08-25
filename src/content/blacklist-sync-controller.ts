import type {
  AliasMutationResult,
  AuthorMutationResult,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import {
  DEFAULT_TAG_ID,
  type BlacklistState,
  type BlacklistedAuthor,
  type CocoonTag,
} from "./blacklist-state.ts";

interface BlacklistHydration {
  readonly state: BlacklistState;
  readonly revision: number;
}

interface BlacklistSyncDependencies {
  hydrate(): Promise<BlacklistHydration>;
  applyState(state: BlacklistState): void;
}

export interface BlacklistSyncController {
  initialize(): Promise<void>;
  beginLocalMutation(): void;
  finishLocalMutation(): Promise<void>;
  handleRevision(revision: number): Promise<void>;
  applyAuthorMutation(result: AuthorMutationResult): Promise<void>;
  applyAliasMutation(result: AliasMutationResult): Promise<void>;
  applyTagDeletion(result: TagDeletionMutationResult): Promise<void>;
  getRevision(): number;
}

interface DeltaApplication {
  readonly baseRevision: number;
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
  readonly update: (state: BlacklistState) => BlacklistState;
}

function replaceAuthor(
  authors: readonly BlacklistedAuthor[],
  author: BlacklistedAuthor,
): BlacklistedAuthor[] {
  const index = authors.findIndex(
    (candidate) => candidate.platformId === author.platformId && candidate.userId === author.userId,
  );
  if (index === -1) return [...authors, author];
  return authors.map((candidate, candidateIndex) =>
    candidateIndex === index ? author : candidate,
  );
}

function addTag(tags: readonly CocoonTag[], tag: CocoonTag | null): CocoonTag[] {
  if (tag === null || tags.some(({ tagId }) => tagId === tag.tagId)) return [...tags];
  return [...tags, tag];
}

class BlacklistSyncControllerImpl implements BlacklistSyncController {
  private currentState: BlacklistState | null = null;
  private currentRevision = -1;
  private pendingLocalMutations = 0;
  private deferredRevision = -1;
  private operationTail = Promise.resolve();
  private readonly dependencies: BlacklistSyncDependencies;

  constructor(dependencies: BlacklistSyncDependencies) {
    this.dependencies = dependencies;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.operationTail;
    let release: () => void = () => {};
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      try {
        await previous;
        await operation();
      } finally {
        release();
      }
    })();
  }

  private applyHydration(hydration: BlacklistHydration, minimumRevision = -1): void {
    if (hydration.revision < minimumRevision || hydration.revision < this.currentRevision) return;
    this.currentState = hydration.state;
    this.currentRevision = hydration.revision;
    this.dependencies.applyState(hydration.state);
  }

  private async rehydrate(minimumRevision = -1): Promise<void> {
    this.applyHydration(await this.dependencies.hydrate(), minimumRevision);
  }

  private async applyDelta(application: DeltaApplication): Promise<void> {
    if (application.revision <= this.currentRevision) return;
    if (this.currentState === null || application.baseRevision !== this.currentRevision) {
      await this.rehydrate(application.revision);
      return;
    }
    const next = application.update(this.currentState);
    if (
      next.authors.length !== application.authorCount ||
      next.tags.length !== application.tagCount
    ) {
      await this.rehydrate(application.revision);
      return;
    }
    this.currentState = next;
    this.currentRevision = application.revision;
    this.dependencies.applyState(next);
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentState === null) await this.rehydrate();
    });
  }

  beginLocalMutation(): void {
    this.pendingLocalMutations += 1;
  }

  finishLocalMutation(): Promise<void> {
    if (this.pendingLocalMutations < 1) {
      return Promise.reject(new Error("No local blacklist mutation is pending."));
    }
    this.pendingLocalMutations -= 1;
    if (this.pendingLocalMutations > 0 || this.deferredRevision <= this.currentRevision) {
      return Promise.resolve();
    }
    const revision = this.deferredRevision;
    this.deferredRevision = -1;
    return this.enqueue(async () => this.rehydrate(revision));
  }

  handleRevision(revision: number): Promise<void> {
    if (this.pendingLocalMutations > 0) {
      this.deferredRevision = Math.max(this.deferredRevision, revision);
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (revision > this.currentRevision) await this.rehydrate(revision);
    });
  }

  applyAuthorMutation(result: AuthorMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status === "invalid") return;
      if (result.revision === result.baseRevision) {
        this.reapplyDuplicate(result);
        return;
      }
      await this.applyDelta({
        ...result,
        update: (state) => ({
          ...state,
          tags: addTag(state.tags, result.tag),
          authors: replaceAuthor(state.authors, result.author),
        }),
      });
    });
  }

  private reapplyDuplicate(result: AuthorMutationResult): void {
    if (result.status !== "duplicate" || this.currentState === null) return;
    this.currentState = {
      ...this.currentState,
      authors: replaceAuthor(this.currentState.authors, result.author),
    };
    this.dependencies.applyState(this.currentState);
  }

  applyAliasMutation(result: AliasMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status !== "persisted") return;
      await this.applyDelta({
        ...result,
        update: (state) => ({
          ...state,
          authors: replaceAuthor(state.authors, result.author),
        }),
      });
    });
  }

  applyTagDeletion(result: TagDeletionMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status !== "persisted" || result.deletedTagId === null) return;
      const deletedTagId = result.deletedTagId;
      await this.applyDelta({
        ...result,
        update: (state) => ({
          ...state,
          tags: state.tags.filter(({ tagId }) => tagId !== deletedTagId),
          authors: state.authors.map((author) =>
            author.tagId === deletedTagId ? { ...author, tagId: DEFAULT_TAG_ID } : author,
          ),
        }),
      });
    });
  }

  getRevision(): number {
    return this.currentRevision;
  }
}

export function createBlacklistSyncController(
  dependencies: BlacklistSyncDependencies,
): BlacklistSyncController {
  return new BlacklistSyncControllerImpl(dependencies);
}
