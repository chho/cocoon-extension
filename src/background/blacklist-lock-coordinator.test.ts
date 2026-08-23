import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  STORAGE_KEY,
  createInitialState,
  type BlacklistState,
} from "../content/blacklist-state.ts";
import {
  createBackgroundBlacklistLockClient,
  type BackgroundBlacklistLease,
} from "../content/background-lock-client.ts";
import {
  BLACKLIST_LOCK_NAME,
  BLACKLIST_LOCK_PORT_NAME,
  createBlacklistLockCoordinator,
  type BlacklistLockPort,
} from "./blacklist-lock-coordinator.ts";

class FifoLockManager {
  readonly names: string[] = [];
  readonly #tails = new Map<string, Promise<void>>();

  async request<T>(
    name: string,
    _options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T> {
    this.names.push(name);
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
      if (this.#tails.get(name) === current) this.#tails.delete(name);
    }
  }
}

class MemoryStorage {
  value: unknown = createInitialState();
  readonly sets: unknown[] = [];
  getGate: Promise<void> | null = null;
  setGate: Promise<void> | null = null;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.getGate) await this.getGate;
    return { [key]: this.value };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.setGate) await this.setGate;
    this.value = items[STORAGE_KEY];
    this.sets.push(this.value);
  }
}

interface PortHarness {
  readonly server: BlacklistLockPort;
  readonly client: {
    readonly onDisconnect: { addListener(listener: () => void): void };
    readonly onMessage: { addListener(listener: (message: unknown) => void): void };
    postMessage(message: unknown): void;
    disconnect(): void;
  };
  disconnectFromWorker(): void;
  failReleasePost(): void;
}

function createPortHarness(runtimeId = "runtime-id"): PortHarness {
  const serverMessages: Array<(message: unknown) => void> = [];
  const clientMessages: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let disconnected = false;
  let releasePostFails = false;
  const disconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    for (const listener of disconnectListeners) listener();
  };
  return {
    server: {
      name: BLACKLIST_LOCK_PORT_NAME,
      sender: { id: runtimeId, tab: { id: 4 }, frameId: 0 },
      onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
      onMessage: { addListener: (listener) => serverMessages.push(listener) },
      postMessage(message) {
        if (disconnected) throw new Error("disconnected");
        for (const listener of clientMessages) listener(message);
      },
      disconnect,
    },
    client: {
      onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
      onMessage: { addListener: (listener) => clientMessages.push(listener) },
      postMessage(message) {
        if (disconnected) throw new Error("disconnected");
        if (
          releasePostFails && typeof message === "object" && message !== null &&
          (message as { readonly type?: unknown }).type === "release"
        ) {
          throw new Error("release transport failed");
        }
        for (const listener of serverMessages) listener(message);
      },
      disconnect,
    },
    disconnectFromWorker: disconnect,
    failReleasePost() {
      releasePostFails = true;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createHarness() {
  const locks = new FifoLockManager();
  const storage = new MemoryStorage();
  const failures: number[] = [];
  const coordinator = createBlacklistLockCoordinator(
    locks,
    storage,
    "runtime-id",
    () => failures.push(1),
  );
  return { locks, storage, failures, coordinator };
}

function connectClient(
  coordinator: ReturnType<typeof createBlacklistLockCoordinator>,
  port: PortHarness,
) {
  return createBackgroundBlacklistLockClient({
    connect({ name }) {
      strictEqual(name, BLACKLIST_LOCK_PORT_NAME);
      strictEqual(coordinator.attachContentLease(port.server), true);
      return port.client;
    },
  });
}

test("POPUP-005 lease-bound reads and writes remain inside the FIFO background lock", async () => {
  const harness = createHarness();
  const firstPort = createPortHarness();
  const secondPort = createPortHarness();
  const first = connectClient(harness.coordinator, firstPort);
  const second = connectClient(harness.coordinator, secondPort);
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const firstRun = first.runExclusive(async (lease) => {
    events.push("content-1");
    const parsed = await lease.readState();
    strictEqual(parsed.status, "valid");
    await firstGate;
    const next = { ...parsed.state, authors: [] } satisfies BlacklistState;
    await lease.writeState(next);
  });
  const management = harness.coordinator.runExclusive(async () => {
    events.push("management");
  });
  const secondRun = second.runExclusive(async (lease) => {
    events.push("content-2");
    await lease.readState();
  });
  await settle();
  deepStrictEqual(events, ["content-1"]);
  releaseFirst?.();
  await Promise.all([firstRun, management, secondRun]);
  deepStrictEqual(events, ["content-1", "management", "content-2"]);
  strictEqual(harness.storage.sets.length, 1);
  strictEqual(harness.locks.names.every((name) => name === BLACKLIST_LOCK_NAME), true);
  deepStrictEqual(harness.failures, []);
});

test("POPUP-005 disconnect after acquisition makes a late content write impossible", async () => {
  const harness = createHarness();
  const port = createPortHarness();
  const client = connectClient(harness.coordinator, port);
  let lease: BackgroundBlacklistLease | undefined;
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const content = client.runExclusive(async (acquiredLease) => {
    lease = acquiredLease;
    await blocked;
    await acquiredLease.writeState(createInitialState());
  });
  await settle();

  const events: string[] = [];
  const management = harness.coordinator.runExclusive(async () => {
    events.push("management");
  });
  await settle();
  deepStrictEqual(events, []);
  port.disconnectFromWorker();
  await management;
  deepStrictEqual(events, ["management"]);
  unblock?.();
  await rejects(content, /lease is unavailable|disconnected/i);
  await rejects(lease?.writeState(createInitialState()) ?? Promise.resolve(), /unavailable/i);
  strictEqual(harness.storage.sets.length, 0);
});

test("POPUP-005 worker disconnect rejects pending lease reads and waits for in-flight writes", async () => {
  for (const kind of ["read", "write"] as const) {
    const harness = createHarness();
    let releaseStorage: (() => void) | undefined;
    const storageGate = new Promise<void>((resolve) => { releaseStorage = resolve; });
    if (kind === "read") harness.storage.getGate = storageGate;
    else harness.storage.setGate = storageGate;
    const port = createPortHarness();
    const client = connectClient(harness.coordinator, port);
    const content = client.runExclusive(async (lease) => {
      if (kind === "read") await lease.readState();
      else await lease.writeState(createInitialState());
    });
    await settle();
    port.disconnectFromWorker();
    let managementRan = false;
    const management = harness.coordinator.runExclusive(async () => {
      managementRan = true;
    });
    await settle();
    strictEqual(managementRan, false, kind);
    releaseStorage?.();
    await rejects(content, /disconnected/i);
    await management;
    strictEqual(managementRan, true, kind);
  }
});

test("POPUP-005 failed release transport cannot replace an acknowledged callback result", async () => {
  const harness = createHarness();
  const port = createPortHarness();
  port.failReleasePost();
  const client = connectClient(harness.coordinator, port);
  const result = await client.runExclusive(async (lease) => {
    await lease.readState();
    return "completed";
  });
  strictEqual(result, "completed");
  let ran = false;
  await harness.coordinator.runExclusive(async () => { ran = true; });
  strictEqual(ran, true);
});

test("POPUP-005 malformed writes and unknown lease messages fail closed without storage writes", async () => {
  for (const message of [
    { version: 2, type: "write", requestId: 1, state: { schemaVersion: 4 } },
    { version: 2, type: "unexpected" },
    { version: 1, type: "release" },
  ]) {
    const harness = createHarness();
    const port = createPortHarness();
    strictEqual(harness.coordinator.attachContentLease(port.server), true);
    await settle();
    port.client.postMessage(message);
    await settle();
    strictEqual(harness.storage.sets.length, 0);
    let ran = false;
    await harness.coordinator.runExclusive(async () => { ran = true; });
    strictEqual(ran, true);
  }
});

test("POPUP-005 only authorized main-frame content ports enter the lock", () => {
  const harness = createHarness();
  for (const sender of [
    { id: "other", tab: { id: 1 }, frameId: 0 },
    { id: "runtime-id", tab: { id: 1 }, frameId: 1 },
    { id: "runtime-id", frameId: 0 },
  ]) {
    const port = createPortHarness();
    strictEqual(harness.coordinator.attachContentLease({ ...port.server, sender }), false);
  }
  deepStrictEqual(harness.locks.names, []);
});
