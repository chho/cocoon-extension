import type { AuthorAliasPersistenceResult } from "./author-alias-persistence-controller.ts";
import { isMemberHashId, normalizeMemberHashId } from "./blacklist-state.ts";
import type { IdentityMatchStatus } from "./identity-batch-matcher.ts";

export type CardFilterFreshness = () => boolean;

export interface CardFilterControllerDependencies<TCard extends object> {
  readonly prepareCard: (card: TCard) => void;
  readonly resolveStableIdentifiers: (card: TCard) => ReadonlySet<string>;
  readonly matchStableIdentifiers: (
    identifiers: ReadonlySet<string>,
  ) => IdentityMatchStatus | Promise<IdentityMatchStatus>;
  readonly resolveHistoricalAlias?: (
    memberHashId: string,
  ) => Promise<AuthorAliasPersistenceResult | void>;
  readonly setHidden: (card: TCard, hidden: boolean, isCurrent: CardFilterFreshness) => void;
  readonly isConnected?: (card: TCard) => boolean;
  readonly reportFailure: (error: unknown) => void;
  readonly schedule: (callback: () => void) => void | (() => void);
  readonly batchSize?: number;
}

export interface CardFilterController<TCard extends object> {
  enqueue(card: TCard): void;
  reevaluateAll(): void;
  destroy(): void;
}

function canonicalIdentifiers(identifiers: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(
    Array.from(identifiers, (identifier) => normalizeMemberHashId(identifier) ?? identifier),
  );
}

function firstMemberHash(identifiers: ReadonlySet<string>): string | null {
  for (const identifier of identifiers) {
    if (isMemberHashId(identifier)) return identifier;
  }
  return null;
}

class CardFilterControllerImpl<TCard extends object> implements CardFilterController<TCard> {
  private readonly dependencies: CardFilterControllerDependencies<TCard>;
  private readonly batchSize: number;
  private readonly encountered = new Set<TCard>();
  private readonly pending = new Map<TCard, object>();
  private readonly currentEvaluations = new WeakMap<TCard, object>();
  private readonly filtering = new WeakSet<TCard>();
  private readonly skipAliasOnce = new WeakMap<TCard, string>();
  private readonly inFlightAliases = new Map<
    string,
    Promise<AuthorAliasPersistenceResult | void>
  >();
  private frameRequested = false;
  private cancelFrame: (() => void) | null = null;
  private destroyed = false;

  constructor(dependencies: CardFilterControllerDependencies<TCard>) {
    this.dependencies = dependencies;
    this.batchSize = dependencies.batchSize ?? 20;
  }

  enqueue(card: TCard): void {
    if (this.destroyed) return;
    this.encountered.add(card);
    this.supersedeEvaluation(card);
    if (!this.filtering.has(card)) this.requestFrame();
  }

  reevaluateAll(): void {
    if (this.destroyed) return;
    let hasReadyEvaluation = false;
    for (const card of this.encountered) {
      if (!this.isConnected(card)) {
        this.forget(card);
        continue;
      }
      this.supersedeEvaluation(card);
      hasReadyEvaluation ||= !this.filtering.has(card);
    }
    if (hasReadyEvaluation) this.requestFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.frameRequested = false;
    this.pending.clear();
    this.encountered.clear();
    this.inFlightAliases.clear();
  }

  private isConnected(card: TCard): boolean {
    return this.dependencies.isConnected?.(card) ?? true;
  }

  private forget(card: TCard): void {
    this.encountered.delete(card);
    this.pending.delete(card);
  }

  private requestFrame(): void {
    if (this.frameRequested || this.destroyed) return;
    this.frameRequested = true;
    const cancellation = this.dependencies.schedule(() => this.processPending());
    this.cancelFrame = typeof cancellation === "function" ? cancellation : null;
  }

  private supersedeEvaluation(card: TCard): object {
    const evaluation = Object.freeze({});
    this.currentEvaluations.set(card, evaluation);
    this.pending.set(card, evaluation);
    return evaluation;
  }

  private isCurrentEvaluation(card: TCard, evaluation: object): boolean {
    return (
      !this.destroyed && this.isConnected(card) && this.currentEvaluations.get(card) === evaluation
    );
  }

  private reenqueueAliasRoots(memberHashId: string, skipImmediateRetry: boolean): void {
    for (const card of this.encountered) {
      if (!this.isConnected(card)) {
        this.forget(card);
        continue;
      }
      try {
        const identifiers = canonicalIdentifiers(this.dependencies.resolveStableIdentifiers(card));
        if (!identifiers.has(memberHashId)) continue;
        if (skipImmediateRetry) this.skipAliasOnce.set(card, memberHashId);
        this.supersedeEvaluation(card);
      } catch (error) {
        this.dependencies.reportFailure(error);
      }
    }
    if (!skipImmediateRetry) this.requestFrame();
  }

  private resolveAlias(memberHashId: string): void {
    const resolver = this.dependencies.resolveHistoricalAlias;
    if (!resolver || this.inFlightAliases.has(memberHashId) || this.destroyed) return;
    const completion = this.resolveAliasSafely(resolver, memberHashId);
    this.inFlightAliases.set(memberHashId, completion);
    void this.finishAliasResolution(memberHashId, completion);
  }

  private async resolveAliasSafely(
    resolver: (memberHashId: string) => Promise<AuthorAliasPersistenceResult | void>,
    memberHashId: string,
  ): Promise<AuthorAliasPersistenceResult | void> {
    try {
      return await resolver(memberHashId);
    } catch {
      return { status: "failed" };
    }
  }

  private async finishAliasResolution(
    memberHashId: string,
    completion: Promise<AuthorAliasPersistenceResult | void>,
  ): Promise<void> {
    const result = await completion;
    if (this.inFlightAliases.get(memberHashId) !== completion) return;
    this.inFlightAliases.delete(memberHashId);
    if (this.destroyed) return;
    this.reenqueueAliasRoots(memberHashId, result === undefined || result.status === "failed");
  }

  private applyMatchResult(
    card: TCard,
    evaluation: object,
    identifiers: ReadonlySet<string>,
    status: IdentityMatchStatus,
  ): void {
    const isCurrent = (): boolean => this.isCurrentEvaluation(card, evaluation);
    if (!isCurrent()) return;
    this.dependencies.setHidden(card, status === "matched", isCurrent);
    if (status !== "unmatched") return;
    const memberHashId = firstMemberHash(identifiers);
    if (memberHashId === null) return;
    if (this.skipAliasOnce.get(card) === memberHashId) {
      this.skipAliasOnce.delete(card);
      return;
    }
    this.resolveAlias(memberHashId);
  }

  private async filter(card: TCard, evaluation: object): Promise<void> {
    try {
      const identifiers = canonicalIdentifiers(this.dependencies.resolveStableIdentifiers(card));
      if (!this.isCurrentEvaluation(card, evaluation)) return;
      const match = this.dependencies.matchStableIdentifiers(identifiers);
      const status = typeof match === "string" ? match : await match;
      this.applyMatchResult(card, evaluation, identifiers, status);
    } catch (error) {
      this.applyFailure(card, evaluation, error);
    } finally {
      this.filtering.delete(card);
      if (this.pending.has(card)) this.requestFrame();
    }
  }

  private applyFailure(card: TCard, evaluation: object, error: unknown): void {
    if (!this.isCurrentEvaluation(card, evaluation)) return;
    this.dependencies.reportFailure(error);
    const isCurrent = (): boolean => this.isCurrentEvaluation(card, evaluation);
    this.dependencies.setHidden(card, false, isCurrent);
  }

  private takeBatch(): Array<readonly [TCard, object]> {
    const batch: Array<readonly [TCard, object]> = [];
    for (const entry of this.pending) {
      if (this.filtering.has(entry[0])) continue;
      batch.push(entry);
      if (batch.length === this.batchSize) break;
    }
    return batch;
  }

  private processEntry(card: TCard, evaluation: object): void {
    if (this.pending.get(card) !== evaluation) return;
    this.pending.delete(card);
    if (!this.isConnected(card)) {
      this.encountered.delete(card);
      return;
    }
    this.dependencies.prepareCard(card);
    if (!this.isCurrentEvaluation(card, evaluation)) return;
    this.filtering.add(card);
    void this.filter(card, evaluation);
  }

  private processPending(): void {
    this.frameRequested = false;
    this.cancelFrame = null;
    if (this.destroyed) return;
    for (const [card, evaluation] of this.takeBatch()) {
      this.processEntry(card, evaluation);
    }
    if ([...this.pending].some(([card]) => !this.filtering.has(card))) this.requestFrame();
  }
}

export function createCardFilterController<TCard extends object>(
  dependencies: CardFilterControllerDependencies<TCard>,
): CardFilterController<TCard> {
  return new CardFilterControllerImpl(dependencies);
}
