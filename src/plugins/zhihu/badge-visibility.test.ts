import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createCardFilterController as createIdentityCardFilterController } from "../../content/card-filter-controller.ts";
import {
  BLACKLISTED_CARD_CLASS,
  applyCardHiddenState,
  createCardVisibilityController,
} from "./runtime.ts";

function connectedCard(dom: JSDOM): HTMLElement {
  const card = dom.window.document.createElement("article");
  dom.window.document.body.append(card);
  return card;
}

function applyCurrentCardHiddenState(
  card: HTMLElement,
  hidden: boolean,
  observed: WeakSet<HTMLElement>,
  onFirstHidden: () => void,
): void {
  applyCardHiddenState(card, hidden, () => true, observed, onFirstHidden);
}

function createFrames() {
  const frames: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      frames.push(callback);
    },
    flushNext() {
      const callback = frames.shift();
      if (!callback) {
        throw new Error("Expected a queued frame.");
      }
      callback();
    },
    flush() {
      while (frames.length > 0) {
        frames.shift()?.();
      }
    },
    get size() {
      return frames.length;
    },
  };
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createFilteringHarness(
  beforeMatch: (identifiers: ReadonlySet<string>) => Promise<void> = async () => {},
) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const card = connectedCard(dom);
  const controllerFrames = createFrames();
  const visibilityFrames = createFrames();
  const failures: unknown[] = [];
  const matchAttempts: string[][] = [];
  let badgeCount = 0;
  const visibility = createCardVisibilityController({
    schedule: visibilityFrames.schedule,
    onFirstHidden() {
      badgeCount += 1;
    },
  });
  let available = false;
  let matchingIdentifiers = new Set<string>();
  const identityController = createIdentityCardFilterController<HTMLElement>({
    prepareCard() {},
    resolveStableIdentifiers(value) {
      return new Set(value.dataset.authorId ? [value.dataset.authorId] : []);
    },
    async matchStableIdentifiers(identifiers) {
      if (!available) return "unavailable";
      matchAttempts.push([...identifiers]);
      await beforeMatch(identifiers);
      return [...identifiers].some((identifier) => matchingIdentifiers.has(identifier))
        ? "matched"
        : "unmatched";
    },
    setHidden(value, hidden, isCurrent) {
      visibility.queue(value, hidden, isCurrent);
    },
    isConnected(value) {
      return value.isConnected;
    },
    reportFailure(error) {
      failures.push(error);
    },
    schedule: controllerFrames.schedule,
  });
  const controller = {
    enqueue(cardToEnqueue: HTMLElement) {
      identityController.enqueue(cardToEnqueue);
    },
    initializeMatcher(identifiers: ReadonlySet<string>) {
      available = true;
      matchingIdentifiers = new Set(identifiers);
      identityController.reevaluateAll();
    },
    replaceMatcherRevision(identifiers: ReadonlySet<string>) {
      matchingIdentifiers = new Set(identifiers);
      identityController.reevaluateAll();
    },
  };

  return {
    card,
    controller,
    controllerFrames,
    visibilityFrames,
    failures,
    matchAttempts,
    get badgeCount() {
      return badgeCount;
    },
  };
}

test("BADGE-002/003 cards count only their first connected absent-to-present transition", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const observed = new WeakSet<HTMLElement>();
  let count = 0;
  const first = connectedCard(dom);

  applyCurrentCardHiddenState(first, true, observed, () => {
    count += 1;
  });
  applyCurrentCardHiddenState(first, true, observed, () => {
    count += 1;
  });
  applyCurrentCardHiddenState(first, false, observed, () => {
    count += 1;
  });
  applyCurrentCardHiddenState(first, true, observed, () => {
    count += 1;
  });
  strictEqual(count, 1);
  strictEqual(first.classList.contains(BLACKLISTED_CARD_CLASS), true);

  const sameAuthorNewRoot = connectedCard(dom);
  applyCurrentCardHiddenState(sameAuthorNewRoot, true, observed, () => {
    count += 1;
  });
  strictEqual(count, 2);
});

test("BADGE-002 preexisting hidden classes are observed without reporting", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const observed = new WeakSet<HTMLElement>();
  const card = connectedCard(dom);
  card.classList.add(BLACKLISTED_CARD_CLASS);
  let count = 0;

  applyCurrentCardHiddenState(card, true, observed, () => {
    count += 1;
  });
  applyCurrentCardHiddenState(card, false, observed, () => {
    count += 1;
  });
  applyCurrentCardHiddenState(card, true, observed, () => {
    count += 1;
  });
  strictEqual(count, 0);
});

test("BADGE-003 detached cards do not transition or count", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const observed = new WeakSet<HTMLElement>();
  const card = connectedCard(dom);
  card.remove();
  let count = 0;

  applyCurrentCardHiddenState(card, true, observed, () => {
    count += 1;
  });
  strictEqual(count, 0);
  strictEqual(card.classList.contains(BLACKLISTED_CARD_CLASS), false);
});

test("BADGE-006 reporter callback failure cannot undo card hiding or enable recount", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const observed = new WeakSet<HTMLElement>();
  const card = connectedCard(dom);
  let attempts = 0;

  applyCurrentCardHiddenState(card, true, observed, () => {
    attempts += 1;
    throw new Error("reporting failed");
  });
  applyCurrentCardHiddenState(card, true, observed, () => {
    attempts += 1;
  });
  strictEqual(card.classList.contains(BLACKLISTED_CARD_CLASS), true);
  strictEqual(attempts, 1);
});

test("BADGE-003/AC-073 a reused connected card reruns after stale async success without RAF polling", async () => {
  const gate = createDeferred<void>();
  const resolvedIdentities: Array<string | null> = [];
  const harness = createFilteringHarness(async (identifiers) => {
    resolvedIdentities.push([...identifiers][0] ?? null);
    if (resolvedIdentities.length === 1) {
      await gate.promise;
    }
  });
  harness.card.dataset.authorId = "blocked-old";

  harness.controller.initializeMatcher(new Set(["blocked-old"]));
  harness.controller.enqueue(harness.card);
  harness.controllerFrames.flushNext();
  deepStrictEqual(resolvedIdentities, ["blocked-old"]);

  harness.card.dataset.authorId = "visible-new";
  harness.controller.enqueue(harness.card);
  strictEqual(harness.controllerFrames.size, 0);

  gate.resolve(undefined);
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 0);
  strictEqual(harness.controllerFrames.size, 1);
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);

  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 1);
  harness.visibilityFrames.flushNext();

  deepStrictEqual(resolvedIdentities, ["blocked-old", "visible-new"]);
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);
  deepStrictEqual(harness.failures, []);
});

test("BADGE-003/AC-073 delayed visibility rechecks freshness after async resolution", async () => {
  const gate = createDeferred<void>();
  const harness = createFilteringHarness(async () => {
    await gate.promise;
  });
  harness.card.dataset.authorId = "blocked-old";

  harness.controller.initializeMatcher(new Set(["blocked-old"]));
  harness.controller.enqueue(harness.card);
  harness.controllerFrames.flushNext();
  gate.resolve(undefined);
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 1);

  harness.card.dataset.authorId = "visible-new";
  harness.controller.enqueue(harness.card);
  harness.visibilityFrames.flushNext();
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);

  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  harness.visibilityFrames.flushNext();
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);
  deepStrictEqual(harness.failures, []);
});

test("BADGE-003/AC-073 a stale async error cannot report failure or unhide current state", async () => {
  const gate = createDeferred<void>();
  let resolutionCount = 0;
  const harness = createFilteringHarness(async () => {
    resolutionCount += 1;
    if (resolutionCount === 1) {
      await gate.promise;
    }
  });
  harness.card.dataset.authorId = "blocked-old";
  harness.card.classList.add(BLACKLISTED_CARD_CLASS);

  harness.controller.initializeMatcher(new Set(["blocked-old"]));
  harness.controller.enqueue(harness.card);
  harness.controllerFrames.flushNext();

  harness.card.dataset.authorId = "visible-new";
  harness.controller.enqueue(harness.card);
  strictEqual(harness.controllerFrames.size, 0);
  gate.reject(new Error("stale resolution failure"));
  await settleAsyncWork();

  deepStrictEqual(harness.failures, []);
  strictEqual(harness.visibilityFrames.size, 0);
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), true);

  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  harness.visibilityFrames.flushNext();
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);
  deepStrictEqual(harness.failures, []);
});

test("BADGE-003/AC-073 revision replacement invalidates and safely overwrites queued visibility", async () => {
  const harness = createFilteringHarness();
  harness.card.dataset.authorId = "blocked-direct";
  harness.controller.initializeMatcher(new Set(["blocked-direct"]));
  harness.controller.enqueue(harness.card);
  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 1);

  harness.controller.replaceMatcherRevision(new Set());
  harness.visibilityFrames.flushNext();
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);

  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  harness.visibilityFrames.flushNext();
  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);

  harness.controller.replaceMatcherRevision(new Set(["blocked-direct"]));
  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 1);
  harness.controller.replaceMatcherRevision(new Set());
  harness.controllerFrames.flushNext();
  await settleAsyncWork();
  strictEqual(harness.visibilityFrames.size, 1);
  harness.visibilityFrames.flushNext();

  strictEqual(harness.card.classList.contains(BLACKLISTED_CARD_CLASS), false);
  strictEqual(harness.badgeCount, 0);
  deepStrictEqual(harness.matchAttempts, [
    ["blocked-direct"],
    ["blocked-direct"],
    ["blocked-direct"],
    ["blocked-direct"],
  ]);
  deepStrictEqual(harness.failures, []);
});
