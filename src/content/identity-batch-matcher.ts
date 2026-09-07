import { BLACKLIST_CONTENT_IDENTITY_BATCH_SIZE } from "../core/blacklist-content-rpc-contract.ts";
import type { BlacklistIdentityQueryDto } from "../core/blacklist-query-rpc-contract.ts";
import { normalizeMemberHashId } from "./blacklist-state.ts";
import type { ContentIdentityMatchResult } from "./background-blacklist-gateway.ts";

export const IDENTITY_MATCH_POSITIVE_CACHE_LIMIT = 1_000;
export const IDENTITY_MATCH_NEGATIVE_CACHE_LIMIT = 2_000;

export type IdentityMatchStatus = "matched" | "unmatched" | "unavailable";

interface IdentityBatchQuery {
  readonly revision: number;
  readonly identities: readonly BlacklistIdentityQueryDto[];
}

interface IdentityBatchMatcherDependencies {
  readonly query: (input: IdentityBatchQuery) => Promise<ContentIdentityMatchResult>;
  readonly schedule: (callback: () => void) => void | (() => void);
  readonly onRevisionInvalidated?: (revision: number) => void;
  readonly positiveCacheLimit?: number;
  readonly negativeCacheLimit?: number;
}

export interface IdentityBatchMatcher {
  match(identities: readonly BlacklistIdentityQueryDto[]): Promise<IdentityMatchStatus>;
  setRevision(revision: number): void;
  rememberMatches(identities: readonly BlacklistIdentityQueryDto[], revision: number): void;
  getRevision(): number | null;
  destroy(): void;
}

interface IdentityWaiter {
  readonly resolve: (status: IdentityMatchStatus) => void;
  settled: boolean;
}

interface PendingIdentity {
  readonly key: string;
  readonly identity: BlacklistIdentityQueryDto;
  readonly waiters: Set<IdentityWaiter>;
}

interface IdentityBatchContext {
  readonly batch: readonly PendingIdentity[];
  readonly revision: number;
  readonly generation: number;
}

class LruSet {
  private readonly values = new Map<string, true>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  has(key: string): boolean {
    if (!this.values.has(key)) return false;
    this.values.delete(key);
    this.values.set(key, true);
    return true;
  }

  add(key: string): void {
    this.values.delete(key);
    this.values.set(key, true);
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) return;
      this.values.delete(oldest);
    }
  }

  delete(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function identityKey({ platformId, identifier }: BlacklistIdentityQueryDto): string {
  return JSON.stringify([platformId, identifier]);
}

function canonicalIdentity(identity: BlacklistIdentityQueryDto): BlacklistIdentityQueryDto {
  return {
    platformId: identity.platformId,
    identifier: normalizeMemberHashId(identity.identifier) ?? identity.identifier,
  };
}

function uniqueIdentities(
  identities: readonly BlacklistIdentityQueryDto[],
): BlacklistIdentityQueryDto[] {
  const unique = new Map<string, BlacklistIdentityQueryDto>();
  for (const identity of identities) {
    const canonical = canonicalIdentity(identity);
    unique.set(identityKey(canonical), canonical);
  }
  return [...unique.values()];
}

class IdentityBatchMatcherImpl implements IdentityBatchMatcher {
  private readonly dependencies: IdentityBatchMatcherDependencies;
  private readonly positiveCache: LruSet;
  private readonly negativeCache: LruSet;
  private readonly entries = new Map<string, PendingIdentity>();
  private readonly queued = new Map<string, PendingIdentity>();
  private readonly inFlight = new Set<PendingIdentity>();
  private revision: number | null = null;
  private generation = 0;
  private frameRequested = false;
  private cancelFrame: (() => void) | null = null;
  private destroyed = false;

  constructor(dependencies: IdentityBatchMatcherDependencies) {
    this.dependencies = dependencies;
    this.positiveCache = new LruSet(
      dependencies.positiveCacheLimit ?? IDENTITY_MATCH_POSITIVE_CACHE_LIMIT,
    );
    this.negativeCache = new LruSet(
      dependencies.negativeCacheLimit ?? IDENTITY_MATCH_NEGATIVE_CACHE_LIMIT,
    );
  }

  private requestFrame(): void {
    if (this.frameRequested || this.destroyed || this.queued.size === 0) return;
    this.frameRequested = true;
    const cancellation = this.dependencies.schedule(() => this.processFrame());
    this.cancelFrame = typeof cancellation === "function" ? cancellation : null;
  }

  private settle(entry: PendingIdentity, status: IdentityMatchStatus): void {
    this.entries.delete(entry.key);
    this.queued.delete(entry.key);
    this.inFlight.delete(entry);
    for (const waiter of entry.waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.resolve(status);
    }
    entry.waiters.clear();
  }

  private requeue(entries: readonly PendingIdentity[]): void {
    for (const entry of entries) {
      this.inFlight.delete(entry);
      if (entry.waiters.size > 0) this.queued.set(entry.key, entry);
    }
    this.requestFrame();
  }

  private applyResult(
    entries: readonly PendingIdentity[],
    result: ContentIdentityMatchResult,
  ): void {
    const matches = new Set(result.matches.map(identityKey));
    for (const entry of entries) {
      const matched = matches.has(entry.key);
      if (matched) {
        this.negativeCache.delete(entry.key);
        this.positiveCache.add(entry.key);
      } else {
        this.positiveCache.delete(entry.key);
        this.negativeCache.add(entry.key);
      }
      this.settle(entry, matched ? "matched" : "unmatched");
    }
  }

  private settleUnavailable(entries: readonly PendingIdentity[]): void {
    for (const entry of entries) this.settle(entry, "unavailable");
  }

  private batchBecameStale(revision: number, generation: number): boolean {
    return this.generation !== generation || this.revision !== revision;
  }

  private handleBatchResult(
    context: IdentityBatchContext,
    result: ContentIdentityMatchResult,
  ): void {
    if (this.destroyed) {
      this.settleUnavailable(context.batch);
      return;
    }
    if (
      this.batchBecameStale(context.revision, context.generation) ||
      result.revision < context.revision
    ) {
      this.requeue(context.batch);
      return;
    }
    if (result.revision > context.revision) {
      this.setRevision(result.revision);
      this.requeue(context.batch);
      return;
    }
    this.applyResult(context.batch, result);
  }

  private handleBatchFailure(context: IdentityBatchContext): void {
    if (!this.destroyed && this.batchBecameStale(context.revision, context.generation)) {
      this.requeue(context.batch);
      return;
    }
    this.settleUnavailable(context.batch);
  }

  private async runBatch(
    batch: readonly PendingIdentity[],
    revision: number,
    generation: number,
  ): Promise<void> {
    const context = { batch, revision, generation };
    try {
      const result = await this.dependencies.query({
        revision,
        identities: batch.map(({ identity }) => identity),
      });
      this.handleBatchResult(context, result);
    } catch {
      this.handleBatchFailure(context);
    } finally {
      for (const entry of batch) this.inFlight.delete(entry);
    }
  }

  private processFrame(): void {
    this.frameRequested = false;
    this.cancelFrame = null;
    if (this.destroyed || this.revision === null) {
      const pending = [...this.queued.values()];
      for (const entry of pending) this.settle(entry, "unavailable");
      return;
    }
    const batch = [...this.queued.values()].slice(0, BLACKLIST_CONTENT_IDENTITY_BATCH_SIZE);
    for (const entry of batch) {
      this.queued.delete(entry.key);
      this.inFlight.add(entry);
    }
    if (this.queued.size > 0) this.requestFrame();
    void this.runBatch(batch, this.revision, this.generation);
  }

  private queryIdentity(identity: BlacklistIdentityQueryDto): Promise<IdentityMatchStatus> {
    const key = identityKey(identity);
    const existing = this.entries.get(key);
    const entry = existing ?? { key, identity, waiters: new Set<IdentityWaiter>() };
    if (!existing) {
      this.entries.set(key, entry);
      this.queued.set(key, entry);
      this.requestFrame();
    }
    return new Promise<IdentityMatchStatus>((resolve) => {
      entry.waiters.add({ resolve, settled: false });
    });
  }

  async match(identities: readonly BlacklistIdentityQueryDto[]): Promise<IdentityMatchStatus> {
    if (this.destroyed || this.revision === null) return "unavailable";
    const unique = uniqueIdentities(identities);
    if (unique.length === 0) return "unmatched";
    if (unique.some((identity) => this.positiveCache.has(identityKey(identity)))) {
      return "matched";
    }
    const uncached = unique.filter((identity) => !this.negativeCache.has(identityKey(identity)));
    if (uncached.length === 0) return "unmatched";
    const results = await Promise.all(uncached.map((identity) => this.queryIdentity(identity)));
    if (results.includes("matched")) return "matched";
    return results.includes("unavailable") ? "unavailable" : "unmatched";
  }

  setRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    if (this.revision !== null && revision <= this.revision) return;
    this.revision = revision;
    this.generation += 1;
    this.positiveCache.clear();
    this.negativeCache.clear();
    try {
      this.dependencies.onRevisionInvalidated?.(revision);
    } catch {
      // Cache invalidation remains authoritative even if DOM reevaluation scheduling fails.
    }
    this.requestFrame();
  }

  rememberMatches(identities: readonly BlacklistIdentityQueryDto[], revision: number): void {
    if (this.destroyed || !Number.isSafeInteger(revision) || revision < 0) return;
    if (this.revision === null || revision > this.revision) this.setRevision(revision);
    if (revision !== this.revision) return;
    for (const identity of uniqueIdentities(identities)) {
      const key = identityKey(identity);
      this.negativeCache.delete(key);
      this.positiveCache.add(key);
    }
  }

  getRevision(): number | null {
    return this.revision;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.frameRequested = false;
    const pending = new Set([...this.queued.values(), ...this.inFlight]);
    for (const entry of pending) this.settle(entry, "unavailable");
    this.queued.clear();
    this.inFlight.clear();
    this.entries.clear();
    this.positiveCache.clear();
    this.negativeCache.clear();
  }
}

export function createIdentityBatchMatcher(
  dependencies: IdentityBatchMatcherDependencies,
): IdentityBatchMatcher {
  return new IdentityBatchMatcherImpl(dependencies);
}
