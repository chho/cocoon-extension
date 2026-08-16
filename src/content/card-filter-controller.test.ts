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

function createHarness() {
  const frames: Array<() => void> = [];
  const resolutions: string[] = [];
  const failures: unknown[] = [];
  const controller = createCardFilterController<TestCard>({
    prepareCard(value) {
      value.prepared += 1;
    },
    resolveDirectStableUserIds(value) {
      return value.directIds;
    },
    async resolveStableUserId(value) {
      resolutions.push(value.id);
      return value.resolvedUserId;
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
      await Promise.resolve();
    }
    await Promise.resolve();
  }

  return { controller, resolutions, failures, flush };
}

test("BUG-008 token and hash direct matches hide cards without a member GET", async () => {
  const harness = createHarness();
  const hash = "a".repeat(32);
  const tokenCard = card("token", ["blocked-token"]);
  const hashCard = card("hash", [hash]);
  const visible = card("visible", ["visible-token"]);
  harness.controller.loadStableUserIds(new Set(["blocked-token", hash]));
  for (const value of [tokenCard, hashCard, visible]) {
    harness.controller.enqueue(value);
  }
  await harness.flush();

  strictEqual(tokenCard.hidden, true);
  strictEqual(hashCard.hidden, true);
  strictEqual(visible.hidden, false);
  deepStrictEqual(harness.resolutions, ["visible"]);
  deepStrictEqual(harness.failures, []);
});

test("metadata-only cards use the existing resolver when no direct identifier matches", async () => {
  const harness = createHarness();
  const value = card("metadata-only", ["a".repeat(32)], "blocked-token");
  harness.controller.loadStableUserIds(new Set(["blocked-token"]));
  harness.controller.enqueue(value);
  await harness.flush();
  strictEqual(value.hidden, true);
  deepStrictEqual(harness.resolutions, ["metadata-only"]);
});

test("dynamic cards and cards encountered before storage load are reevaluated", async () => {
  const harness = createHarness();
  const early = card("early", ["blocked"]);
  harness.controller.enqueue(early);
  await harness.flush();
  strictEqual(early.hidden, false);
  strictEqual(early.prepared, 1);

  harness.controller.loadStableUserIds(new Set(["blocked"]));
  await harness.flush();
  strictEqual(early.hidden, true);

  const dynamic = card("dynamic", ["blocked"]);
  harness.controller.enqueue(dynamic);
  await harness.flush();
  strictEqual(dynamic.hidden, true);
  strictEqual(dynamic.prepared, 1);
});
