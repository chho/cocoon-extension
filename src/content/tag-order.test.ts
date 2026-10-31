import { deepStrictEqual, notStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TAG_ID, MAX_STABLE_ID_CODE_POINTS, type CocoonTag } from "./blacklist-state.ts";
import {
  TAG_ORDER_STORAGE_KEY,
  moveCustomTag,
  orderDrawerTags,
  parseTagOrderPreferences,
  saveTagOrder,
  type TagOrderDependencies,
  type TagOrderPreferences,
} from "./tag-order.ts";

const preferences = (tagIds: readonly string[]): TagOrderPreferences => ({
  schemaVersion: 1,
  tagIds,
});
const tag = (tagId: string, name = tagId): CocoonTag => ({ tagId, name });
const signal = () => new AbortController().signal;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function storage(initial?: unknown) {
  let stored: unknown = initial;
  const writes: TagOrderPreferences[] = [];
  const dependencies: TagOrderDependencies = {
    async read() {
      return stored;
    },
    async write(next) {
      writes.push(next);
      stored = next;
    },
    async withExclusiveLock(operation, abortSignal) {
      abortSignal.throwIfAborted();
      return operation();
    },
  };
  return { dependencies, writes };
}

test("TAG-019 missing preferences use an empty order without initializing storage", async () => {
  strictEqual(TAG_ORDER_STORAGE_KEY, "cocoonDrawerTagOrder");
  const { dependencies, writes } = storage();
  deepStrictEqual(parseTagOrderPreferences(await dependencies.read()), {
    status: "missing",
    preferences: preferences([]),
  });
  deepStrictEqual(writes, []);
});

test("TAG-019 malformed envelopes and invalid or duplicate IDs safely fall back", () => {
  for (const value of [
    null,
    false,
    [],
    {},
    { schemaVersion: 2, tagIds: [] },
    { schemaVersion: 1 },
    { tagIds: [] },
    { schemaVersion: 1, tagIds: [], extra: true },
    { schemaVersion: 1, tagIds: "one" },
    preferences(["one", "one"]),
    preferences([DEFAULT_TAG_ID]),
    preferences([""]),
    preferences([" "]),
    preferences([" one"]),
    preferences(["one\n"]),
    preferences(["x".repeat(MAX_STABLE_ID_CODE_POINTS + 1)]),
    preferences(["😀".repeat(MAX_STABLE_ID_CODE_POINTS + 1)]),
    { schemaVersion: 1, tagIds: [1] },
    { schemaVersion: 1, tagIds: Array<string>(1) },
  ]) {
    deepStrictEqual(parseTagOrderPreferences(value), {
      status: "malformed",
      preferences: preferences([]),
    });
  }
});

test("TAG-019 accepts stable Unicode IDs and copies the validated preference", () => {
  const ids = ["Case", "case", "😀".repeat(MAX_STABLE_ID_CODE_POINTS)];
  const parsed = parseTagOrderPreferences(preferences(ids));
  strictEqual(parsed.status, "valid");
  deepStrictEqual(parsed.preferences, preferences(ids));
  notStrictEqual(parsed.preferences.tagIds, ids);
  deepStrictEqual(parseTagOrderPreferences(preferences([])), {
    status: "valid",
    preferences: preferences([]),
  });
});

test("TAG-019 has no transfer-derived 2000-tag cap", async () => {
  const ids = Array.from({ length: 2001 }, (_, index) => `tag-${index}`);
  strictEqual(parseTagOrderPreferences(preferences(ids)).status, "valid");
  const { dependencies } = storage();
  deepStrictEqual(await saveTagOrder(dependencies, ids, signal()), preferences(ids));
  deepStrictEqual(
    orderDrawerTags(
      ids.map((id) => tag(id)),
      [...ids].reverse(),
    ),
    [...ids].reverse().map((id) => tag(id)),
  );
});

test("TAG-019 keeps default first and uses saved IDs once, never names", () => {
  const tags = [tag("one", "shared"), tag("two", "shared"), tag(DEFAULT_TAG_ID), tag("three")];
  deepStrictEqual(orderDrawerTags(tags, ["missing", "two", "two", DEFAULT_TAG_ID]), [
    tags[2],
    tags[1],
    tags[0],
    tags[3],
  ]);
  deepStrictEqual(orderDrawerTags(tags, []), [tags[2], tags[0], tags[1], tags[3]]);
  deepStrictEqual(
    tags.map(({ tagId }) => tagId),
    ["one", "two", DEFAULT_TAG_ID, "three"],
  );
  deepStrictEqual(orderDrawerTags([], ["missing"]), []);
  deepStrictEqual(orderDrawerTags([tag("one")], []), [tag("one")]);
});

test("TAG-019 reconciles create/delete/rename and removes deleted IDs on the next save", async () => {
  const { dependencies, writes } = storage(preferences(["two", "deleted", "one"]));
  const latest = parseTagOrderPreferences(await dependencies.read()).preferences;
  const tags = [tag(DEFAULT_TAG_ID), tag("one", "Renamed"), tag("two"), tag("new")];
  const ordered = orderDrawerTags(tags, latest.tagIds);
  deepStrictEqual(ordered, [tags[0], tags[2], tags[1], tags[3]]);
  const ids = ordered.filter(({ tagId }) => tagId !== DEFAULT_TAG_ID).map(({ tagId }) => tagId);
  await saveTagOrder(dependencies, ids, signal());
  deepStrictEqual(writes, [preferences(["two", "one", "new"])]);
});

test("TAG-019 moves only custom IDs before a known target or to the end", () => {
  const ids = Object.freeze([DEFAULT_TAG_ID, "one", "two", "three"]);
  deepStrictEqual(moveCustomTag(ids, "three", "one"), ["three", "one", "two"]);
  deepStrictEqual(moveCustomTag(ids, "one", "three"), ["two", "one", "three"]);
  deepStrictEqual(moveCustomTag(ids, "one", null), ["two", "three", "one"]);
  deepStrictEqual(moveCustomTag([DEFAULT_TAG_ID], "one", null), []);
  deepStrictEqual(moveCustomTag(["one"], "one", null), ["one"]);
  deepStrictEqual(ids, [DEFAULT_TAG_ID, "one", "two", "three"]);
});

test("TAG-019 invalid, protected, unknown and same-position moves are no-ops", () => {
  const ids = [DEFAULT_TAG_ID, "one", "two", "three"];
  const moves: readonly (readonly [string, string | null])[] = [
    [DEFAULT_TAG_ID, "one"],
    ["one", DEFAULT_TAG_ID],
    ["missing", "one"],
    ["one", "missing"],
    ["", null],
    ["one ", null],
    ["one", " two"],
    ["one", "one"],
    ["one", "two"],
    ["three", null],
    ["x".repeat(MAX_STABLE_ID_CODE_POINTS + 1), null],
  ];
  for (const [movedId, beforeId] of moves) {
    deepStrictEqual(moveCustomTag(ids, movedId, beforeId), ["one", "two", "three"]);
  }
});

test("TAG-019 rereads inside the lock and skips an identical valid order", async () => {
  const { dependencies, writes } = storage(preferences(["stale"]));
  let locked = false;
  const abortSignal = signal();
  const read = dependencies.read;
  const saving: TagOrderDependencies = {
    ...dependencies,
    async withExclusiveLock(operation, receivedSignal) {
      strictEqual(receivedSignal, abortSignal);
      await dependencies.write(preferences(["latest"]));
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    async read() {
      strictEqual(locked, true);
      return read();
    },
  };
  deepStrictEqual(await saveTagOrder(saving, ["latest"], abortSignal), preferences(["latest"]));
  strictEqual(writes.length, 1);
});

test("TAG-019 rejects invalid desired input before any lock/read/write", async () => {
  const { dependencies, writes } = storage({ corrupt: true });
  let locks = 0;
  const saving: TagOrderDependencies = {
    ...dependencies,
    async withExclusiveLock(operation) {
      locks += 1;
      return operation();
    },
  };
  for (const ids of [[DEFAULT_TAG_ID], ["one", "one"], [" invalid"], [""]]) {
    await rejects(saveTagOrder(saving, ids, signal()), /invalid/i);
  }
  strictEqual(locks, 0);
  deepStrictEqual(writes, []);
  deepStrictEqual(await dependencies.read(), { corrupt: true });
});

test("TAG-019 valid desired input can replace missing or malformed preferences", async () => {
  for (const initial of [undefined, { corrupt: true }]) {
    const { dependencies, writes } = storage(initial);
    deepStrictEqual(await saveTagOrder(dependencies, [], signal()), preferences([]));
    deepStrictEqual(writes, [preferences([])]);
  }
});

test("TAG-019 serializes concurrent saves and the last successful order wins", async () => {
  const { dependencies, writes } = storage();
  const firstRead = deferred();
  const releaseRead = deferred();
  let tail = Promise.resolve();
  let reads = 0;
  const saving: TagOrderDependencies = {
    ...dependencies,
    async withExclusiveLock(operation, abortSignal) {
      const previous = tail;
      const release = deferred();
      tail = release.promise;
      await previous;
      try {
        abortSignal.throwIfAborted();
        return await operation();
      } finally {
        release.resolve();
      }
    },
    async read() {
      reads += 1;
      if (reads === 1) {
        firstRead.resolve();
        await releaseRead.promise;
      }
      return dependencies.read();
    },
  };
  const firstIds = ["one", "two"];
  const first = saveTagOrder(saving, firstIds, signal());
  await firstRead.promise;
  firstIds.reverse();
  const second = saveTagOrder(saving, ["two", "one"], signal());
  strictEqual(reads, 1);
  releaseRead.resolve();
  deepStrictEqual(await Promise.all([first, second]), [
    preferences(["one", "two"]),
    preferences(["two", "one"]),
  ]);
  deepStrictEqual(writes, [preferences(["one", "two"]), preferences(["two", "one"])]);
  deepStrictEqual(await dependencies.read(), preferences(["two", "one"]));
});

test("TAG-019 abort before or during a read prevents writing", async () => {
  for (const alreadyAborted of [true, false]) {
    const controller = new AbortController();
    const { dependencies, writes } = storage();
    if (alreadyAborted) controller.abort();
    const saving: TagOrderDependencies = {
      ...dependencies,
      async read() {
        controller.abort();
        return dependencies.read();
      },
    };
    await rejects(saveTagOrder(saving, ["one"], controller.signal), { name: "AbortError" });
    deepStrictEqual(writes, []);
  }
});

test("TAG-019 abort releases a lock-held read before it settles and a later save succeeds", async () => {
  const controller = new AbortController();
  const { dependencies, writes } = storage();
  const started = deferred(),
    delayedRead = deferred();
  let held = false,
    reads = 0;
  const saving: TagOrderDependencies = {
    ...dependencies,
    async withExclusiveLock(operation) {
      strictEqual(held, false);
      held = true;
      try {
        return await operation();
      } finally {
        held = false;
      }
    },
    async read() {
      if (++reads === 1) {
        started.resolve();
        await delayedRead.promise;
      }
      return dependencies.read();
    },
  };
  const first = saveTagOrder(saving, ["stale"], controller.signal).catch((error: unknown) => error);
  try {
    await started.promise;
    controller.abort();
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    strictEqual(held, false, "aborted read must release the lock without settling storage");
    await saveTagOrder(saving, ["latest"], signal());
  } finally {
    delayedRead.resolve();
    await first;
  }
  deepStrictEqual(writes, [preferences(["latest"])]);
  deepStrictEqual(await dependencies.read(), preferences(["latest"]));
});

test("TAG-019 an issued write completes even when aborted and resolves saved preferences", async () => {
  const controller = new AbortController();
  const { dependencies } = storage();
  const saving: TagOrderDependencies = {
    ...dependencies,
    async write(next) {
      controller.abort();
      await dependencies.write(next);
    },
  };
  deepStrictEqual(await saveTagOrder(saving, ["one"], controller.signal), preferences(["one"]));
  deepStrictEqual(await dependencies.read(), preferences(["one"]));
});

test("TAG-019 lock/read/write failures propagate without claiming a new saved order", async () => {
  const failure = new Error("storage unavailable");
  for (const boundary of ["lock", "read", "write"]) {
    const { dependencies, writes } = storage(preferences(["old"]));
    const saving: TagOrderDependencies = {
      ...dependencies,
      async withExclusiveLock(operation, abortSignal) {
        if (boundary === "lock") throw failure;
        return dependencies.withExclusiveLock(operation, abortSignal);
      },
      async read() {
        if (boundary === "read") throw failure;
        return dependencies.read();
      },
      async write(next) {
        if (boundary === "write") throw failure;
        await dependencies.write(next);
      },
    };
    await rejects(saveTagOrder(saving, ["new"], signal()), (error) => error === failure);
    deepStrictEqual(writes, []);
    deepStrictEqual(await dependencies.read(), preferences(["old"]));
  }
});

test("TAG-019 a fresh reader restores saved order and later authoritative updates", async () => {
  const { dependencies } = storage();
  await saveTagOrder(dependencies, ["two", "one"], signal());
  const tags = [tag("one"), tag(DEFAULT_TAG_ID), tag("two")];
  const readFreshOrder = async () => {
    const fresh = parseTagOrderPreferences(await dependencies.read());
    return orderDrawerTags(tags, fresh.preferences.tagIds);
  };
  deepStrictEqual(await readFreshOrder(), [tags[1], tags[2], tags[0]]);
  await saveTagOrder({ ...dependencies }, ["one", "two"], signal());
  deepStrictEqual(await readFreshOrder(), [tags[1], tags[0], tags[2]]);
});
