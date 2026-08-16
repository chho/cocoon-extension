import { normalizeMemberHashId } from "./blacklist-state.ts";

export interface CardFilterControllerDependencies<TCard extends object> {
  readonly prepareCard: (card: TCard) => void;
  readonly resolveDirectStableUserIds: (card: TCard) => ReadonlySet<string>;
  readonly resolveStableUserId: (card: TCard) => Promise<string | null>;
  readonly setHidden: (card: TCard, hidden: boolean) => void;
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
  const pending = new Set<TCard>();
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

  function enqueue(card: TCard): void {
    encountered.add(card);
    pending.add(card);
    requestFrame();
  }

  async function filter(card: TCard): Promise<void> {
    if (!storageLoaded || filtering.has(card)) {
      return;
    }
    if (stableUserIds.size === 0) {
      dependencies.setHidden(card, false);
      return;
    }

    filtering.add(card);
    try {
      const directIds = dependencies.resolveDirectStableUserIds(card);
      if (
        [...directIds].some((identifier) =>
          stableUserIds.has(normalizeMemberHashId(identifier) ?? identifier)
        )
      ) {
        dependencies.setHidden(card, true);
        return;
      }

      const userId = await dependencies.resolveStableUserId(card);
      const canonicalUserId = normalizeMemberHashId(userId) ?? userId;
      dependencies.setHidden(
        card,
        canonicalUserId !== null && stableUserIds.has(canonicalUserId),
      );
    } catch (error) {
      dependencies.reportFailure(error);
      dependencies.setHidden(card, false);
    } finally {
      filtering.delete(card);
    }
  }

  function processPending(): void {
    frameRequested = false;
    const batch = Array.from(pending).slice(0, batchSize);
    for (const card of batch) {
      pending.delete(card);
      dependencies.prepareCard(card);
      void filter(card);
    }
    if (pending.size > 0) {
      requestFrame();
    }
  }

  function reevaluateEncountered(): void {
    for (const card of encountered) {
      pending.add(card);
    }
    requestFrame();
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
