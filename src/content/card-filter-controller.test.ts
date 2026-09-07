import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createCardFilterController } from "./card-filter-controller.ts";

interface TestCard {
  readonly id: string;
  readonly directIds: ReadonlySet<string>;
  readonly resolvedUserId: string | null;
  hidden: boolean;
  prepared: number;
}

function card(
  id: string,
  directIds: readonly string[],
  resolvedUserId: string | null = null,
): TestCard {
  return {
    id,
    directIds: new Set(directIds),
    resolvedUserId,
    hidden: false,
    prepared: 0,
  };
}

function createHarness(cards: readonly TestCard[] = []) {
  const frames: Array<() => void> = [];
  const resolutions: string[] = [];
  const failures: unknown[] = [];
  let available = false;
  let stableUserIds = new Set<string>();
  const controller = createCardFilterController<TestCard>({
    prepareCard(value) {
      value.prepared += 1;
    },
    resolveStableIdentifiers(value) {
      return value.directIds;
    },
    matchStableIdentifiers(identifiers) {
      if (!available) return "unavailable";
      return [...identifiers].some((identifier) => stableUserIds.has(identifier))
        ? "matched"
        : "unmatched";
    },
    async resolveHistoricalAlias(memberHashId) {
      resolutions.push(memberHashId);
      const matchingCard = cards.find((value) => value.directIds.has(memberHashId));
      if (!matchingCard?.resolvedUserId || !stableUserIds.has(matchingCard.resolvedUserId)) {
        return { status: "failed" };
      }
      stableUserIds.add(memberHashId);
      return { status: "persisted" };
    },
    setHidden(value, hidden) {
      value.hidden = hidden;
    },
    reportFailure(error) {
      failures.push(error);
    },
    schedule(callback) {
      frames.push(callback);
    },
  });

  async function flush(): Promise<void> {
    while (frames.length > 0) {
      frames.shift()?.();
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    }
  }

  return {
    controller,
    resolutions,
    failures,
    flush,
    initialize(userIds: ReadonlySet<string>) {
      stableUserIds = new Set(userIds);
      available = true;
      controller.reevaluateAll();
    },
  };
}

test("BUG-008 token and hash direct matches hide cards without a member GET", async () => {
  const hash = "a".repeat(32);
  const tokenCard = card("token", ["blocked-token"]);
  const hashCard = card("hash", [hash]);
  const visible = card("visible", ["visible-token"]);
  const harness = createHarness([tokenCard, hashCard, visible]);
  harness.initialize(new Set(["blocked-token", hash]));
  for (const value of [tokenCard, hashCard, visible]) harness.controller.enqueue(value);
  await harness.flush();

  strictEqual(tokenCard.hidden, true);
  strictEqual(hashCard.hidden, true);
  strictEqual(visible.hidden, false);
  deepStrictEqual(harness.resolutions, []);
  deepStrictEqual(harness.failures, []);
});

test("metadata-only cards use historical alias proof when the visible hash is not yet stored", async () => {
  const hash = "a".repeat(32);
  const value = card("metadata-only", [hash], "blocked-token");
  const harness = createHarness([value]);
  harness.initialize(new Set(["blocked-token"]));
  harness.controller.enqueue(value);
  await harness.flush();
  strictEqual(value.hidden, true);
  deepStrictEqual(harness.resolutions, [hash]);
});

test("dynamic cards and cards encountered before matcher initialization are reevaluated", async () => {
  const early = card("early", ["blocked"]);
  const harness = createHarness([early]);
  harness.controller.enqueue(early);
  await harness.flush();
  strictEqual(early.hidden, false);
  strictEqual(early.prepared, 1);

  harness.initialize(new Set(["blocked"]));
  await harness.flush();
  strictEqual(early.hidden, true);

  const dynamic = card("dynamic", ["blocked"]);
  harness.controller.enqueue(dynamic);
  await harness.flush();
  strictEqual(dynamic.hidden, true);
  strictEqual(dynamic.prepared, 1);
});
