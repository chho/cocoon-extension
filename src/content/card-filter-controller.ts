import { normalizeMemberHashId } from "./blacklist-state.ts";

export type CardFilterFreshness = () => boolean;

export interface CardFilterControllerDependencies<TCard extends object> {
  readonly prepareCard: (card: TCard) => void;
  readonly resolveDirectStableUserIds: (card: TCard) => ReadonlySet<string>;
  readonly resolveStableUserId: (card: TCard) => Promise<string | null>;
  readonly setHidden: (
    card: TCard,
    hidden: boolean,
    isCurrent: CardFilterFreshness,
  ) => void;
  readonly reportFailure: (error: unknown) => void;
  readonly schedule: (callback: () => void) => void;
  readonly batchSize?: number;
}

export interface CardFilterController<TCard extends object> {
  enqueue(card: TCard): void;
  loadStableUserIds(userIds: ReadonlySet<string>): void;
  replaceStableUserIds(userIds: ReadonlySet<string>): void;
}

export function createCardFilterController<TCard extends object>(
  dependencies: CardFilterControllerDependencies<TCard>,
): CardFilterController<TCard> {
  const batchSize = dependencies.batchSize ?? 20;
  const encountered = new Set<TCard>();
  const pending = new Map<TCard, object>();
  const currentEvaluations = new WeakMap<TCard, object>();
  const filtering = new WeakSet<TCard>();
  let stableUserIds = new Set<string>();
  let storageLoaded = false;
  let frameRequested = false;

  function requestFrame(): void {
    if (frameRequested) {
      return;
    }
    frameRequested = true;
    dependencies.schedule(processPending);
  }

  function supersedeEvaluation(card: TCard): object {
    const evaluation = Object.freeze({});
    currentEvaluations.set(card, evaluation);
    pending.set(card, evaluation);
    return evaluation;
  }

  function isCurrentEvaluation(card: TCard, evaluation: object): boolean {
    return currentEvaluations.get(card) === evaluation;
  }

  function enqueue(card: TCard): void {
    encountered.add(card);
    supersedeEvaluation(card);
    if (!filtering.has(card)) {
      requestFrame();
    }
  }

  async function filter(card: TCard, evaluation: object): Promise<void> {
    const isCurrent = (): boolean => isCurrentEvaluation(card, evaluation);
    if (!storageLoaded || !isCurrent()) {
      return;
    }
    if (stableUserIds.size === 0) {
      if (isCurrent()) {
        dependencies.setHidden(card, false, isCurrent);
      }
      return;
    }

    filtering.add(card);
    try {
      const directIds = dependencies.resolveDirectStableUserIds(card);
      if (!isCurrent()) {
        return;
      }
      if (
        [...directIds].some((identifier) =>
          stableUserIds.has(normalizeMemberHashId(identifier) ?? identifier)
        )
      ) {
        if (isCurrent()) {
          dependencies.setHidden(card, true, isCurrent);
        }
        return;
      }

      const userId = await dependencies.resolveStableUserId(card);
      if (!isCurrent()) {
        return;
      }
      const canonicalUserId = normalizeMemberHashId(userId) ?? userId;
      dependencies.setHidden(
        card,
        canonicalUserId !== null && stableUserIds.has(canonicalUserId),
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      dependencies.reportFailure(error);
      if (isCurrent()) {
        dependencies.setHidden(card, false, isCurrent);
      }
    } finally {
      filtering.delete(card);
      if (pending.has(card)) {
        requestFrame();
      }
    }
  }

  function processPending(): void {
    frameRequested = false;
    const batch: Array<readonly [TCard, object]> = [];
    for (const entry of pending) {
      if (filtering.has(entry[0])) {
        continue;
      }
      batch.push(entry);
      if (batch.length === batchSize) {
        break;
      }
    }

    for (const [card, evaluation] of batch) {
      if (pending.get(card) !== evaluation) {
        continue;
      }
      pending.delete(card);
      dependencies.prepareCard(card);
      if (isCurrentEvaluation(card, evaluation)) {
        void filter(card, evaluation);
      }
    }

    if (Array.from(pending).some(([card]) => !filtering.has(card))) {
      requestFrame();
    }
  }

  function reevaluateEncountered(): void {
    let hasReadyEvaluation = false;
    for (const card of encountered) {
      supersedeEvaluation(card);
      hasReadyEvaluation ||= !filtering.has(card);
    }
    if (hasReadyEvaluation) {
      requestFrame();
    }
  }

  return {
    enqueue,
    loadStableUserIds(userIds) {
      storageLoaded = true;
      stableUserIds = new Set(
        Array.from(userIds, (userId) => normalizeMemberHashId(userId) ?? userId),
      );
      reevaluateEncountered();
    },
    replaceStableUserIds(userIds) {
      stableUserIds = new Set(
        Array.from(userIds, (userId) => normalizeMemberHashId(userId) ?? userId),
      );
      if (storageLoaded) {
        reevaluateEncountered();
      }
    },
  };
}
