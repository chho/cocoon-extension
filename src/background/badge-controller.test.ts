import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeMessage } from "../core/badge-message-contract.ts";
import {
  BADGE_BACKGROUND_COLOR,
  badgeStorageKey,
  createBadgeController,
  formatBadgeCount,
  getMainFrameTabId,
  parseBadgeMessage,
  type BadgeAction,
  type BadgeLockManager,
  type BadgeSessionStorage,
} from "./badge-controller.ts";

const GENERATION_A = "generation_A_123456";
const GENERATION_B = "generation_B_123456";

function resetMessage(generation = GENERATION_A): BadgeMessage {
  return {
    version: 1,
    type: "cocoon.badge.reset",
    generation,
  };
}

function incrementMessage(
  delta: number,
  generation = GENERATION_A,
): BadgeMessage {
  return {
    version: 1,
    type: "cocoon.badge.increment",
    generation,
    delta,
  };
}

class MemorySessionStorage implements BadgeSessionStorage {
  readonly values = new Map<string, unknown>();
  failGet = false;
  failSet = false;
  failRemove = false;
  yieldDuringGet = false;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.failGet) {
      throw new Error("get failed");
    }
    if (this.yieldDuringGet) {
      await Promise.resolve();
    }
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) {
      throw new Error("set failed");
    }
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, value);
    }
  }

  async remove(key: string): Promise<void> {
    if (this.failRemove) {
      throw new Error("remove failed");
    }
    this.values.delete(key);
  }
}

class MemoryAction implements BadgeAction {
  readonly textByTab = new Map<number, string>();
  readonly calls: Array<{ readonly tabId: number; readonly text: string }> = [];
  readonly backgroundCalls: Array<{
    readonly tabId: number;
    readonly color: string;
  }> = [];
  failText = false;
  failBackground = false;

  async setBadgeBackgroundColor(details: {
    readonly tabId: number;
    readonly color: string;
  }): Promise<void> {
    if (this.failBackground) {
      throw new Error("background action failed");
    }
    this.backgroundCalls.push(details);
  }

  async setBadgeText(details: {
    readonly tabId: number;
    readonly text: string;
  }): Promise<void> {
    if (this.failText) {
      throw new Error("text action failed");
    }
    this.calls.push(details);
    this.textByTab.set(details.tabId, details.text);
  }
}

class NamedExclusiveLocks implements BadgeLockManager {
  readonly #tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    _options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(name) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(name, current);
    await previous;
    try {
      return await callback();
    } finally {
      release?.();
      if (this.#tails.get(name) === current) {
        this.#tails.delete(name);
      }
    }
  }
}

function createHarness() {
  const storage = new MemorySessionStorage();
  const action = new MemoryAction();
  const locks = new NamedExclusiveLocks();
  const controller = createBadgeController({ storage, action, locks });
  return { storage, action, locks, controller };
}

function storedState(
  storage: MemorySessionStorage,
  tabId: number,
): { readonly generation: string; readonly count: number } | undefined {
  return storage.values.get(badgeStorageKey(tabId)) as
    | { readonly generation: string; readonly count: number }
    | undefined;
}

const MAIN_FRAME_SENDER = { tab: { id: 7 }, frameId: 0 } as const;

test("BADGE-006 strictly parses versioned messages and rejects extra or invalid fields", () => {
  deepStrictEqual(parseBadgeMessage(resetMessage()), resetMessage());
  deepStrictEqual(parseBadgeMessage(incrementMessage(3)), incrementMessage(3));

  const invalidMessages: readonly unknown[] = [
    null,
    [],
    {},
    { version: 2, type: "cocoon.badge.reset", generation: GENERATION_A },
    { version: 1, type: "unknown", generation: GENERATION_A },
    { ...resetMessage(), extra: true },
    { ...resetMessage(), generation: "short" },
    { ...resetMessage(), generation: "generation with spaces" },
    { ...resetMessage(), generation: "g".repeat(129) },
    { ...resetMessage(), generation: "generation_opaque_用户" },
    { ...incrementMessage(1), extra: true },
    incrementMessage(0),
    incrementMessage(-1),
    incrementMessage(1.5),
    incrementMessage(Number.MAX_SAFE_INTEGER + 1),
  ];
  for (const message of invalidMessages) {
    strictEqual(parseBadgeMessage(message), null);
  }
});

test("BADGE-006 accepts only non-negative integer tab IDs from main-frame senders", () => {
  strictEqual(getMainFrameTabId(MAIN_FRAME_SENDER), 7);
  for (const sender of [
    {},
    { tab: {} },
    { tab: { id: -1 }, frameId: 0 },
    { tab: { id: 1.5 }, frameId: 0 },
    { tab: { id: 7 } },
    { tab: { id: 7 }, frameId: 1 },
  ]) {
    strictEqual(getMainFrameTabId(sender), null);
  }
});

test("BADGE-004/006 invalid messages and senders have no state or Action effects", async () => {
  const harness = createHarness();
  for (const [message, sender] of [
    [{ type: "unknown" }, MAIN_FRAME_SENDER],
    [resetMessage(), {}],
    [incrementMessage(1), { tab: { id: 7 }, frameId: 2 }],
  ] as const) {
    deepStrictEqual(
      await harness.controller.handleMessage(message, sender),
      { ok: false },
    );
  }
  strictEqual(harness.storage.values.size, 0);
  strictEqual(harness.action.calls.length, 0);
});

test("BADGE-001/004 resets and increments isolated per-tab exact session counts", async () => {
  const harness = createHarness();
  deepStrictEqual(
    await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER),
    { ok: true },
  );
  deepStrictEqual(
    await harness.controller.handleMessage(incrementMessage(2), MAIN_FRAME_SENDER),
    { ok: true },
  );
  deepStrictEqual(
    await harness.controller.handleMessage(
      resetMessage(GENERATION_B),
      { tab: { id: 8 }, frameId: 0 },
    ),
    { ok: true },
  );
  deepStrictEqual(
    await harness.controller.handleMessage(
      incrementMessage(5, GENERATION_B),
      { tab: { id: 8 }, frameId: 0 },
    ),
    { ok: true },
  );

  deepStrictEqual(storedState(harness.storage, 7), {
    generation: GENERATION_A,
    count: 2,
  });
  deepStrictEqual(storedState(harness.storage, 8), {
    generation: GENERATION_B,
    count: 5,
  });
  deepStrictEqual(Object.keys(storedState(harness.storage, 7) ?? {}).sort(), [
    "count",
    "generation",
  ]);
  strictEqual(harness.action.textByTab.get(7), "2");
  strictEqual(harness.action.textByTab.get(8), "5");
  deepStrictEqual(harness.action.backgroundCalls, [
    { tabId: 7, color: BADGE_BACKGROUND_COLOR },
    { tabId: 8, color: BADGE_BACKGROUND_COLOR },
  ]);
});

test("BADGE-004 concurrent increments serialize without lost updates", async () => {
  const harness = createHarness();
  harness.storage.yieldDuringGet = true;
  await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);

  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      harness.controller.handleMessage(incrementMessage(1), MAIN_FRAME_SENDER)
    ),
  );
  strictEqual(responses.every(({ ok }) => ok), true);
  strictEqual(storedState(harness.storage, 7)?.count, 40);
  strictEqual(harness.action.textByTab.get(7), "40");
});

test("BADGE-004 serialized reset rejects stale old-generation deltas", async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);

  const beforeResetIncrement = harness.controller.handleMessage(
    incrementMessage(2),
    MAIN_FRAME_SENDER,
  );
  const reset = harness.controller.handleMessage(
    resetMessage(GENERATION_B),
    MAIN_FRAME_SENDER,
  );
  const staleIncrement = harness.controller.handleMessage(
    incrementMessage(100),
    MAIN_FRAME_SENDER,
  );
  const currentIncrement = harness.controller.handleMessage(
    incrementMessage(3, GENERATION_B),
    MAIN_FRAME_SENDER,
  );

  deepStrictEqual(await Promise.all([
    beforeResetIncrement,
    reset,
    staleIncrement,
    currentIncrement,
  ]), [
    { ok: true },
    { ok: true },
    { ok: false },
    { ok: true },
  ]);
  deepStrictEqual(storedState(harness.storage, 7), {
    generation: GENERATION_B,
    count: 3,
  });
});

test("BADGE-004 navigation rejects stale generations and removal cleans only the addressed tab", async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  await harness.controller.handleMessage(incrementMessage(4), MAIN_FRAME_SENDER);
  await harness.controller.handleMessage(
    resetMessage(GENERATION_B),
    { tab: { id: 8 }, frameId: 0 },
  );

  strictEqual(await harness.controller.clearForNavigation(7), true);
  strictEqual(storedState(harness.storage, 7), undefined);
  strictEqual(harness.action.textByTab.get(7), "");
  strictEqual(storedState(harness.storage, 8)?.count, 0);
  deepStrictEqual(
    await harness.controller.handleMessage(incrementMessage(10), MAIN_FRAME_SENDER),
    { ok: false },
  );

  await harness.controller.handleMessage(
    resetMessage(GENERATION_B),
    MAIN_FRAME_SENDER,
  );
  deepStrictEqual(
    await harness.controller.handleMessage(incrementMessage(10), MAIN_FRAME_SENDER),
    { ok: false },
  );
  deepStrictEqual(
    await harness.controller.handleMessage(
      incrementMessage(2, GENERATION_B),
      MAIN_FRAME_SENDER,
    ),
    { ok: true },
  );
  strictEqual(storedState(harness.storage, 7)?.count, 2);

  strictEqual(await harness.controller.clearForRemoval(8), true);
  strictEqual(storedState(harness.storage, 8), undefined);
});

test("BADGE-004 a fresh controller resumes authoritative session state after worker restart", async () => {
  const harness = createHarness();
  await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  await harness.controller.handleMessage(incrementMessage(9), MAIN_FRAME_SENDER);

  const restartedController = createBadgeController({
    storage: harness.storage,
    action: harness.action,
    locks: harness.locks,
  });
  deepStrictEqual(
    await restartedController.handleMessage(incrementMessage(4), MAIN_FRAME_SENDER),
    { ok: true },
  );
  strictEqual(storedState(harness.storage, 7)?.count, 13);
  strictEqual(harness.action.textByTab.get(7), "13");
});

test("BADGE-005 formats 0, 1, 999, 1000, and larger exact values", async () => {
  deepStrictEqual(
    [0, 1, 999, 1_000, 50_000].map(formatBadgeCount),
    ["", "1", "999", "999+", "999+"],
  );

  const harness = createHarness();
  await harness.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  await harness.controller.handleMessage(incrementMessage(1_000), MAIN_FRAME_SENDER);
  strictEqual(storedState(harness.storage, 7)?.count, 1_000);
  strictEqual(harness.action.textByTab.get(7), "999+");
  await harness.controller.handleMessage(incrementMessage(50_000), MAIN_FRAME_SENDER);
  strictEqual(storedState(harness.storage, 7)?.count, 51_000);
  strictEqual(harness.action.textByTab.get(7), "999+");
});

test("BADGE-006 corrupt or overflowing session state fails safely", async () => {
  const corruptStates: readonly unknown[] = [
    null,
    {},
    { generation: GENERATION_A, count: -1 },
    { generation: GENERATION_A, count: 1.5 },
    { generation: "short", count: 1 },
    { generation: GENERATION_A, count: 1, extra: true },
  ];
  for (const corruptState of corruptStates) {
    const harness = createHarness();
    harness.storage.values.set(badgeStorageKey(7), corruptState);
    deepStrictEqual(
      await harness.controller.handleMessage(incrementMessage(1), MAIN_FRAME_SENDER),
      { ok: false },
    );
    strictEqual(harness.action.calls.length, 0);
    strictEqual(harness.storage.values.get(badgeStorageKey(7)), corruptState);
  }

  const overflow = createHarness();
  overflow.storage.values.set(badgeStorageKey(7), {
    generation: GENERATION_A,
    count: Number.MAX_SAFE_INTEGER,
  });
  deepStrictEqual(
    await overflow.controller.handleMessage(incrementMessage(1), MAIN_FRAME_SENDER),
    { ok: false },
  );
  strictEqual(storedState(overflow.storage, 7)?.count, Number.MAX_SAFE_INTEGER);
});

test("POPUP-001/002 status reads distinguish missing, malformed, and exact large counts", async () => {
  const harness = createHarness();
  deepStrictEqual(await harness.controller.getStatusState(7), { status: "missing" });
  harness.storage.values.set(badgeStorageKey(7), {
    generation: GENERATION_A,
    count: 12_345,
  });
  deepStrictEqual(await harness.controller.getStatusState(7), {
    status: "valid",
    state: { generation: GENERATION_A, count: 12_345 },
  });
  for (const invalid of [
    { generation: GENERATION_A, count: 1, extra: true },
    { generation: GENERATION_A, count: -1 },
    { generation: "short", count: 1 },
  ]) {
    harness.storage.values.set(badgeStorageKey(7), invalid);
    deepStrictEqual(await harness.controller.getStatusState(7), { status: "invalid" });
  }
  harness.storage.failGet = true;
  deepStrictEqual(await harness.controller.getStatusState(7), { status: "invalid" });
});

test("BADGE-006 storage and Action failures report failure without rolling back committed counts", async () => {
  const storageFailure = createHarness();
  storageFailure.storage.failSet = true;
  deepStrictEqual(
    await storageFailure.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER),
    { ok: false },
  );
  strictEqual(storageFailure.storage.values.size, 0);
  strictEqual(storageFailure.action.calls.length, 0);

  const actionFailure = createHarness();
  actionFailure.action.failText = true;
  deepStrictEqual(
    await actionFailure.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER),
    { ok: false },
  );
  deepStrictEqual(storedState(actionFailure.storage, 7), {
    generation: GENERATION_A,
    count: 0,
  });
  actionFailure.action.failText = false;
  await actionFailure.controller.handleMessage(incrementMessage(2), MAIN_FRAME_SENDER);
  actionFailure.action.failText = true;
  deepStrictEqual(
    await actionFailure.controller.handleMessage(incrementMessage(3), MAIN_FRAME_SENDER),
    { ok: false },
  );
  strictEqual(storedState(actionFailure.storage, 7)?.count, 5);

  const readFailure = createHarness();
  await readFailure.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  readFailure.storage.failGet = true;
  deepStrictEqual(
    await readFailure.controller.handleMessage(incrementMessage(1), MAIN_FRAME_SENDER),
    { ok: false },
  );
  strictEqual(storedState(readFailure.storage, 7)?.count, 0);

  const backgroundFailure = createHarness();
  await backgroundFailure.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  backgroundFailure.action.failBackground = true;
  deepStrictEqual(
    await backgroundFailure.controller.handleMessage(
      incrementMessage(1),
      MAIN_FRAME_SENDER,
    ),
    { ok: false },
  );
  strictEqual(storedState(backgroundFailure.storage, 7)?.count, 1);
  strictEqual(backgroundFailure.action.calls.length, 1);

  const clearFailure = createHarness();
  await clearFailure.controller.handleMessage(resetMessage(), MAIN_FRAME_SENDER);
  clearFailure.storage.failRemove = true;
  strictEqual(await clearFailure.controller.clearForNavigation(7), false);
  strictEqual(await clearFailure.controller.clearForRemoval(7), false);
  strictEqual(storedState(clearFailure.storage, 7)?.count, 0);

  const navigationActionFailure = createHarness();
  await navigationActionFailure.controller.handleMessage(
    resetMessage(),
    MAIN_FRAME_SENDER,
  );
  navigationActionFailure.action.failText = true;
  strictEqual(
    await navigationActionFailure.controller.clearForNavigation(7),
    false,
  );
  strictEqual(storedState(navigationActionFailure.storage, 7), undefined);
});
