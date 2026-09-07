import type {
  AliasMutationResult,
  AuthorMutationResult,
  TagDeletionMutationResult,
} from "../background/blacklist-repository-types.ts";
import type { BlacklistedAuthor, CocoonTag } from "./blacklist-state.ts";

export interface ContentBlacklistDirectory {
  readonly revision: number;
  readonly authorCount: number;
  readonly tagCount: number;
  readonly tags: readonly CocoonTag[];
}

interface BlacklistSyncDependencies {
  loadDirectory(): Promise<ContentBlacklistDirectory>;
  applyTags(tags: readonly CocoonTag[]): void;
  setRevision(revision: number): void;
  rememberAuthor(author: BlacklistedAuthor, revision: number): void;
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

function addTag(tags: readonly CocoonTag[], tag: CocoonTag | null): CocoonTag[] {
  if (tag === null || tags.some(({ tagId }) => tagId === tag.tagId)) return [...tags];
  return [...tags, tag];
}

class BlacklistSyncControllerImpl implements BlacklistSyncController {
  private tags: readonly CocoonTag[] = [];
  private currentRevision = -1;
  private directoryRevision = -1;
  private pendingLocalMutations = 0;
  private deferredDirectoryRevision = -1;
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

  private advanceRevision(revision: number): void {
    if (revision <= this.currentRevision) return;
    this.currentRevision = revision;
    this.dependencies.setRevision(revision);
  }

  private applyDirectory(directory: ContentBlacklistDirectory, minimumRevision = -1): void {
    if (directory.revision < minimumRevision || directory.revision < this.currentRevision) return;
    this.tags = [...directory.tags];
    this.directoryRevision = directory.revision;
    this.dependencies.applyTags(this.tags);
    this.advanceRevision(directory.revision);
  }

  private async reloadDirectory(minimumRevision = -1): Promise<void> {
    this.applyDirectory(await this.dependencies.loadDirectory(), minimumRevision);
  }

  private applyLocalTags(
    tags: readonly CocoonTag[],
    revision: number,
    expectedCount: number,
  ): boolean {
    if (tags.length !== expectedCount) return false;
    this.tags = [...tags];
    this.directoryRevision = revision;
    this.dependencies.applyTags(this.tags);
    return true;
  }

  private canAdvanceUnchangedDirectory(baseRevision: number): boolean {
    return this.directoryRevision === baseRevision;
  }

  private async prepareMutationRevision(baseRevision: number, revision: number): Promise<boolean> {
    if (revision < this.currentRevision) return false;
    this.advanceRevision(revision);
    if (revision !== this.currentRevision) return false;
    if (revision === baseRevision || this.canAdvanceUnchangedDirectory(baseRevision)) return true;
    await this.reloadDirectory(revision);
    return revision === this.currentRevision && revision === this.directoryRevision;
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.directoryRevision < 0) await this.reloadDirectory();
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
    if (
      this.pendingLocalMutations > 0 ||
      this.deferredDirectoryRevision <= this.directoryRevision
    ) {
      return Promise.resolve();
    }
    const revision = this.deferredDirectoryRevision;
    this.deferredDirectoryRevision = -1;
    return this.enqueue(async () => this.reloadDirectory(revision));
  }

  handleRevision(revision: number): Promise<void> {
    if (revision <= this.currentRevision) return Promise.resolve();
    this.advanceRevision(revision);
    if (this.pendingLocalMutations > 0) {
      this.deferredDirectoryRevision = Math.max(this.deferredDirectoryRevision, revision);
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (revision > this.directoryRevision) await this.reloadDirectory(revision);
    });
  }

  applyAuthorMutation(result: AuthorMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status === "invalid") return;
      const prepared = await this.prepareMutationRevision(result.baseRevision, result.revision);
      if (!prepared) return;
      const nextTags = addTag(this.tags, result.tag);
      if (!this.applyLocalTags(nextTags, result.revision, result.tagCount)) {
        await this.reloadDirectory(result.revision);
      }
      if (result.revision === this.currentRevision) {
        this.dependencies.rememberAuthor(result.author, result.revision);
      }
    });
  }

  applyAliasMutation(result: AliasMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status === "invalid") return;
      const prepared = await this.prepareMutationRevision(result.baseRevision, result.revision);
      if (!prepared) return;
      this.directoryRevision = result.revision;
      this.dependencies.rememberAuthor(result.author, result.revision);
    });
  }

  applyTagDeletion(result: TagDeletionMutationResult): Promise<void> {
    return this.enqueue(async () => {
      if (result.status !== "persisted" || result.deletedTagId === null) return;
      const prepared = await this.prepareMutationRevision(result.baseRevision, result.revision);
      if (!prepared) return;
      const nextTags = this.tags.filter(({ tagId }) => tagId !== result.deletedTagId);
      if (!this.applyLocalTags(nextTags, result.revision, result.tagCount)) {
        await this.reloadDirectory(result.revision);
      }
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
