import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_STORAGE_KEY,
  RETENTION_MS,
  type DiagnosticIncident,
} from "./contract.ts";
import { createDiagnosticStore, type DiagnosticStorage, type DiagnosticLocks } from "./storage.ts";

const now = RETENTION_MS * 2;
function incident(id: string, savedAt = now): DiagnosticIncident {
  return {
    schemaVersion: 1,
    pageId: "page-1",
    id,
    savedAt,
    reason: "manual",
    truncated: 0,
    events: [],
  };
}
function harness() {
  let values: Record<string, unknown> = {};
  let locked = false;
  let tail = Promise.resolve();
  const locks: DiagnosticLocks = {
    async request(_name, options, callback) {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        options.signal?.throwIfAborted();
        locked = true;
        return await callback();
      } finally {
        locked = false;
        release();
      }
    },
  };
  const storage: DiagnosticStorage = {
    async get() {
      assert.ok(locked);
      return structuredClone(values);
    },
    async set(items) {
      assert.ok(locked);
      values = structuredClone(items);
    },
    async remove(key) {
      assert.ok(locked);
      delete values[key];
    },
  };
  const dependencies = { storage, locks, now: () => now };
  return {
    dependencies,
    store: createDiagnosticStore(dependencies),
    read: () => values[DIAGNOSTIC_STORAGE_KEY] as DiagnosticIncident[] | undefined,
    seed(value: unknown) {
      values = { [DIAGNOSTIC_STORAGE_KEY]: value };
    },
  };
}

test("concurrent saves reread under one lock, deduplicate, retain newest three and survive restart", async () => {
  const h = harness();
  const save = (value: DiagnosticIncident) =>
    h.store.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "save", incident: value });
  assert.deepEqual(
    await Promise.all([
      save(incident("a", now - 30)),
      save(incident("b", now - 20)),
      save(incident("c", now - 10)),
      save(incident("d")),
    ]),
    [true, true, true, true],
  );
  assert.deepEqual(
    h.read()?.map(({ id }) => id),
    ["d", "c", "b"],
  );
  assert.equal(await save(incident("d", now - 100)), true);
  assert.equal(h.read()?.[0].savedAt, now);
  assert.equal(await save(incident("d")), true);
  assert.equal(h.read()?.length, 3);
  const restarted = createDiagnosticStore(h.dependencies);
  assert.equal(await restarted.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "prune" }), true);
  assert.deepEqual(
    h.read()?.map(({ id }) => id),
    ["d", "c", "b"],
  );
  assert.equal(await restarted.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "clear" }), true);
  assert.equal(h.read(), undefined);
});

test("prune validates stored schema and time; save rejects expired/future input", async () => {
  const h = harness();
  h.seed([
    incident("expired", now - RETENTION_MS),
    incident("future", now + 1),
    { ...incident("invalid"), cookie: "no" },
    incident("fresh"),
    incident("fresh", now - 1),
  ]);
  assert.equal(await h.store.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "prune" }), true);
  assert.deepEqual(h.read(), [incident("fresh")]);
  for (const savedAt of [now + 1, now - RETENTION_MS]) {
    assert.equal(
      await h.store.handle({
        channel: DIAGNOSTIC_CHANNEL,
        operation: "save",
        incident: incident("rejected", savedAt),
      }),
      false,
    );
  }
  assert.deepEqual(h.read(), [incident("fresh")]);
});

test("read/write/lock failures are contained and cancellation before write is honored", async () => {
  const h = harness();
  for (const operation of ["get", "set", "remove"] as const) {
    const storage = {
      ...h.dependencies.storage,
      [operation]: async () => {
        throw new Error("sensitive payload");
      },
    };
    const store = createDiagnosticStore({ ...h.dependencies, storage });
    assert.equal(
      await store.handle({
        channel: DIAGNOSTIC_CHANNEL,
        operation: operation === "remove" ? "clear" : "prune",
      }),
      false,
    );
  }
  const failingLock = createDiagnosticStore({
    ...h.dependencies,
    locks: {
      async request() {
        throw new Error("lock");
      },
    },
  });
  assert.equal(
    await failingLock.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "prune" }),
    false,
  );
  const abort = new AbortController();
  const store = createDiagnosticStore({
    ...h.dependencies,
    storage: {
      ...h.dependencies.storage,
      async get() {
        abort.abort();
        return {};
      },
    },
  });
  assert.equal(
    await store.handle({ channel: DIAGNOSTIC_CHANNEL, operation: "prune" }, abort.signal),
    false,
  );
  assert.equal(h.read(), undefined);
});
