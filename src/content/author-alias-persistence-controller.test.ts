import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  parseBlacklistState,
  type BlacklistState,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";
import { createAuthorAliasPersistenceController } from "./author-alias-persistence-controller.ts";

const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const TIMESTAMP = "2026-08-14T12:00:00.000Z";

function author(userId: string, memberHashId: string | null = null) {
  return {
    userId,
    memberHashId,
    authorNameAtCapture: `Name ${userId}`,
    tagId: "default",
    blacklistedAt: TIMESTAMP,
    blockSource: "direct" as const,
  };
}

function stateWith(
  ...authors: BlacklistState["authors"]
): BlacklistState {
  return { ...createInitialState(), authors };
}

function createHarness(options: {
  readonly initial?: BlacklistState;
  readonly resolvedUserId?: string | null;
  readonly parsedState?: ParsedBlacklistState;
  readonly beforeLock?: () => void;
  readonly failLock?: boolean;
  readonly failRead?: boolean;
  readonly failWrite?: boolean;
} = {}) {
  let stored = options.initial ?? stateWith(author("canonical-token"));
  const requestedHashes: string[] = [];
  let locks = 0;
  let reads = 0;
  let writes = 0;
  let applies = 0;
  const controller = createAuthorAliasPersistenceController({
    async resolveMemberUserId(memberHashId) {
      requestedHashes.push(memberHashId);
      return options.resolvedUserId === undefined
        ? "canonical-token"
        : options.resolvedUserId;
    },
    async withExclusiveLock(operation) {
      locks += 1;
      options.beforeLock?.();
      if (options.failLock) {
        throw new Error("lock failed");
      }
      return operation();
    },
    async readState() {
      reads += 1;
      if (options.failRead) {
        throw new Error("read failed");
      }
      return options.parsedState ?? parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      if (options.failWrite) {
        throw new Error("write failed");
      }
      stored = state;
    },
    applyPersistedState() {
      applies += 1;
    },
  });

  return {
    controller,
    requestedHashes,
    state: () => stored,
    replaceState(state: BlacklistState) {
      stored = state;
    },
    counts: () => ({ locks, reads, writes, applies }),
  };
}

test("BUG-008 alias persistence requires exact member GET proof before storage work", async () => {
  const harness = createHarness();
  const result = await harness.controller.persistMemberHashAlias(HASH_A);

  strictEqual(result.status, "persisted");
  deepStrictEqual(harness.requestedHashes, [HASH_A]);
  deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 1, applies: 1 });
});

test("BUG-008 alias persistence re-reads under lock and preserves intervening state", async () => {
  const initial = stateWith(author("canonical-token"));
  const intervening = stateWith(
    author("canonical-token"),
    author("intervening-user", HASH_B),
  );
  let harness: ReturnType<typeof createHarness>;
  harness = createHarness({
    initial,
    beforeLock() {
      harness.replaceState(intervening);
    },
  });

  const result = await harness.controller.persistMemberHashAlias(HASH_A);
  strictEqual(result.status, "persisted");
  deepStrictEqual(harness.state().authors, [
    { ...intervening.authors[0]!, memberHashId: HASH_A },
    intervening.authors[1],
  ]);
});

test("BUG-008 alias backfill changes one field in one atomic write", async () => {
  const initial = stateWith(author("canonical-token"), author("other-token", HASH_B));
  const harness = createHarness({ initial });
  const before = structuredClone(initial);

  const result = await harness.controller.persistMemberHashAlias(HASH_A);
  strictEqual(result.status, "persisted");
  deepStrictEqual(harness.state(), {
    ...before,
    authors: [
      { ...before.authors[0]!, memberHashId: HASH_A },
      before.authors[1],
    ],
  });
  deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 1, applies: 1 });
});

test("BUG-008 an already-owned alias is idempotent", async () => {
  const initial = stateWith(author("canonical-token", HASH_A));
  const harness = createHarness({ initial });
  const result = await harness.controller.persistMemberHashAlias(HASH_A);

  deepStrictEqual(result, { status: "unchanged" });
  strictEqual(harness.state(), initial);
  deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 0, applies: 0 });
});

test("BUG-008 missing or self-identical member tokens fail before storage", async () => {
  for (const resolvedUserId of [null, HASH_A]) {
    const harness = createHarness({ resolvedUserId });
    deepStrictEqual(
      await harness.controller.persistMemberHashAlias(HASH_A),
      { status: "failed" },
    );
    deepStrictEqual(harness.counts(), { locks: 0, reads: 0, writes: 0, applies: 0 });
  }
});

test("BUG-008 unknown tokens and hash ownership conflicts never backfill", async () => {
  for (const initial of [
    stateWith(author("different-token")),
    stateWith(author("canonical-token"), author("other-token", HASH_A)),
    stateWith(author("canonical-token"), author(HASH_A)),
    stateWith(author("canonical-token", HASH_B)),
  ]) {
    const harness = createHarness({ initial });
    deepStrictEqual(
      await harness.controller.persistMemberHashAlias(HASH_A),
      { status: "failed" },
    );
    strictEqual(harness.state(), initial);
    deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 0, applies: 0 });
  }
});

test("BUG-008 malformed state fails without a write or runtime apply", async () => {
  const harness = createHarness({
    parsedState: { status: "malformed", state: createInitialState() },
  });
  deepStrictEqual(
    await harness.controller.persistMemberHashAlias(HASH_A),
    { status: "failed" },
  );
  deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 0, applies: 0 });
});

test("BUG-008 lock and read failures do not write or apply", async () => {
  for (const options of [{ failLock: true }, { failRead: true }] as const) {
    const harness = createHarness(options);
    deepStrictEqual(
      await harness.controller.persistMemberHashAlias(HASH_A),
      { status: "failed" },
    );
    strictEqual(harness.counts().writes, 0);
    strictEqual(harness.counts().applies, 0);
  }
});

test("BUG-008 write failure does not apply an unpersisted alias", async () => {
  const initial = stateWith(author("canonical-token"));
  const harness = createHarness({ initial, failWrite: true });
  deepStrictEqual(
    await harness.controller.persistMemberHashAlias(HASH_A),
    { status: "failed" },
  );
  strictEqual(harness.state(), initial);
  deepStrictEqual(harness.counts(), { locks: 1, reads: 1, writes: 1, applies: 0 });
});
