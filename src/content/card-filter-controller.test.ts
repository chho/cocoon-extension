import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createCardFilterController } from "./card-filter-controller.ts";

interface TestCard {
  readonly id: string;
  readonly displayName: string;
  readonly stableUserId: string | null;
  hidden: boolean;
  prepared: number;
}

function card(
  id: string,
  stableUserId: string | null,
  displayName = "Same display name",
): TestCard {
  return { id, stableUserId, displayName, hidden: false, prepared: 0 };
}

function createHarness() {
  const frames: Array<() => void> = [];
  const resolutions: string[] = [];
  const failures: unknown[] = [];
  const controller = createCardFilterController<TestCard>({
    prepareCard(value) {
      value.prepared += 1;
    },
    async resolveStableUserId(value) {
      resolutions.push(value.id);
      return value.stableUserId;
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
      const frame = frames.shift();
      frame?.();
      await Promise.resolve();
    }
    await Promise.resolve();
  }

  return { controller, resolutions, failures, flush };
}

test("BL-002/007/AC-002/009 filters every matching stable ID without using display names", async () => {
  const harness = createHarness();
  const firstMatch = card("match-a", "stable-blocked");
  const secondMatch = card("match-b", "stable-blocked", "Other name");
  const sameNameOtherId = card("visible", "stable-visible");
  harness.controller.loadStableUserIds(new Set(["stable-blocked"]));

  harness.controller.enqueue(firstMatch);
  harness.controller.enqueue(secondMatch);
  harness.controller.enqueue(sameNameOtherId);
  await harness.flush();

  strictEqual(firstMatch.hidden, true);
  strictEqual(secondMatch.hidden, true);
  strictEqual(sameNameOtherId.hidden, false);
  deepStrictEqual(harness.resolutions.sort(), ["match-a", "match-b", "visible"]);
  deepStrictEqual(harness.failures, []);
});

test("BL-004/AC-003 dynamically enqueued matching cards are filtered", async () => {
  const harness = createHarness();
  harness.controller.loadStableUserIds(new Set(["stable-blocked"]));
  const initial = card("initial", "stable-visible");
  harness.controller.enqueue(initial);
  await harness.flush();
  strictEqual(initial.hidden, false);

  const dynamicallyAdded = card("dynamic", "stable-blocked");
  harness.controller.enqueue(dynamicallyAdded);
  await harness.flush();
  strictEqual(dynamicallyAdded.hidden, true);
  strictEqual(dynamicallyAdded.prepared, 1);
});

test("cards encountered before storage load are re-evaluated after load", async () => {
  const harness = createHarness();
  const earlyCard = card("early", "stable-blocked");
  harness.controller.enqueue(earlyCard);
  await harness.flush();

  strictEqual(earlyCard.hidden, false);
  strictEqual(harness.resolutions.length, 0);
  strictEqual(earlyCard.prepared, 1);

  harness.controller.loadStableUserIds(new Set(["stable-blocked"]));
  await harness.flush();
  strictEqual(earlyCard.hidden, true);
  strictEqual(harness.resolutions.length, 1);
  strictEqual(earlyCard.prepared, 2);
});
