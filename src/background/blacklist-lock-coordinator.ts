import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type { BlacklistState } from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";

const { STORAGE_KEY, parseBlacklistState } =
  backgroundBlacklistState as typeof BlacklistStateModule;

export const BLACKLIST_LOCK_PORT_NAME = "cocoon.blacklist.lock.v2";
export const BLACKLIST_LOCK_NAME = "cocoon-blacklist-storage";
const LEASE_PROTOCOL_VERSION = 2 as const;
const ACQUIRED_MESSAGE = Object.freeze({
  version: LEASE_PROTOCOL_VERSION,
  type: "acquired",
});

interface LockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface PortEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
}

export interface BlacklistLockPort {
  readonly name: string;
  readonly sender?: {
    readonly id?: string;
    readonly tab?: { readonly id?: number };
    readonly frameId?: number;
  };
  readonly onDisconnect: PortEvent<() => void>;
  readonly onMessage: PortEvent<(message: unknown) => void>;
  postMessage(message: unknown): void;
  disconnect(): void;
}

export interface BlacklistLockCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  attachContentLease(port: BlacklistLockPort): boolean;
}

type LeaseRequest =
  | { readonly type: "release" }
  | { readonly type: "read"; readonly requestId: number }
  | {
      readonly type: "write";
      readonly requestId: number;
      readonly state: BlacklistState;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function parseLeaseRequest(value: unknown): LeaseRequest | null {
  if (!isRecord(value) || value.version !== LEASE_PROTOCOL_VERSION) {
    return null;
  }
  if (
    value.type === "release" &&
    hasExactKeys(value, ["type", "version"])
  ) {
    return { type: "release" };
  }
  if (
    (value.type === "read" || value.type === "write") &&
    Number.isSafeInteger(value.requestId) &&
    (value.requestId as number) >= 1
  ) {
    if (value.type === "read" &&
      hasExactKeys(value, ["requestId", "type", "version"])) {
      return { type: "read", requestId: value.requestId as number };
    }
    if (
      value.type === "write" &&
      hasExactKeys(value, ["requestId", "state", "type", "version"])
    ) {
      const parsed = parseBlacklistState(value.state);
      if (parsed.status === "valid") {
        return {
          type: "write",
          requestId: value.requestId as number,
          state: parsed.state,
        };
      }
    }
  }
  return null;
}

function isAuthorizedContentPort(
  port: BlacklistLockPort,
  runtimeId: string,
): boolean {
  const tabId = port.sender?.tab?.id;
  return port.name === BLACKLIST_LOCK_PORT_NAME &&
    port.sender?.id === runtimeId &&
    Number.isSafeInteger(tabId) &&
    (tabId as number) >= 0 &&
    port.sender?.frameId === 0;
}

function disconnectQuietly(
  port: BlacklistLockPort,
  reportFailure: () => void,
): void {
  try {
    port.disconnect();
  } catch {
    reportFailure();
  }
}

export function createBlacklistLockCoordinator(
  locks: LockManager,
  storage: LocalStorageArea,
  runtimeId: string,
  reportFailure: () => void,
): BlacklistLockCoordinator {
  async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return locks.request(
      BLACKLIST_LOCK_NAME,
      { mode: "exclusive" },
      operation,
    );
  }

  return {
    runExclusive,
    attachContentLease(port) {
      if (!isAuthorizedContentPort(port, runtimeId)) {
        if (port.name === BLACKLIST_LOCK_PORT_NAME) {
          disconnectQuietly(port, reportFailure);
        }
        return false;
      }

      let released = false;
      let acquired = false;
      let resolveRelease: (() => void) | undefined;
      let messageTail = Promise.resolve();
      const releaseSignal = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });
      const release = (): void => {
        if (released) {
          return;
        }
        released = true;
        resolveRelease?.();
      };
      const failClosed = (): void => {
        release();
        disconnectQuietly(port, reportFailure);
      };

      async function processLeaseRequest(
        previous: Promise<void>,
        request: Exclude<LeaseRequest, { readonly type: "release" }>,
      ): Promise<void> {
        try {
          await previous;
          if (released) {
            return;
          }
          if (request.type === "read") {
            const values = await storage.get(STORAGE_KEY);
            const parsed = parseBlacklistState(values[STORAGE_KEY] as unknown);
            port.postMessage({
              version: LEASE_PROTOCOL_VERSION,
              type: "read-result",
              requestId: request.requestId,
              status: parsed.status,
              state: parsed.state,
            });
            return;
          }
          let ok = true;
          try {
            await storage.set({ [STORAGE_KEY]: request.state });
          } catch {
            ok = false;
          }
          port.postMessage({
            version: LEASE_PROTOCOL_VERSION,
            type: "write-result",
            requestId: request.requestId,
            ok,
          });
        } catch {
          failClosed();
        }
      }

      port.onDisconnect.addListener(release);
      port.onMessage.addListener((message) => {
        if (!acquired || released) {
          failClosed();
          return;
        }
        const request = parseLeaseRequest(message);
        if (!request) {
          failClosed();
          return;
        }
        if (request.type === "release") {
          release();
          return;
        }
        messageTail = processLeaseRequest(messageTail, request);
      });

      void (async () => {
        try {
          await runExclusive(async () => {
            if (released) {
              return;
            }
            try {
              acquired = true;
              port.postMessage(ACQUIRED_MESSAGE);
              await releaseSignal;
              await messageTail;
            } catch {
              failClosed();
              await messageTail;
            }
          });
        } catch {
          release();
          reportFailure();
          disconnectQuietly(port, reportFailure);
        }
      })();
      return true;
    },
  };
}
