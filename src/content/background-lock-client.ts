import {
  parseBlacklistState,
  type BlacklistState,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";

export const BLACKLIST_LOCK_PORT_NAME = "cocoon.blacklist.lock.v2";
const LEASE_PROTOCOL_VERSION = 2 as const;

interface RuntimePort {
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface RuntimeConnector {
  connect(connectInfo: { readonly name: string }): RuntimePort;
}

interface PendingRequest {
  readonly kind: "read" | "write";
  readonly resolve: (value: ParsedBlacklistState | void) => void;
  readonly reject: (error: Error) => void;
}

export interface BackgroundBlacklistLease {
  readState(): Promise<ParsedBlacklistState>;
  writeState(state: BlacklistState): Promise<void>;
}

export interface BackgroundBlacklistLockClient {
  runExclusive<T>(
    operation: (lease: BackgroundBlacklistLease) => Promise<T>,
  ): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isAcquiredMessage(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["type", "version"]) &&
    value.version === LEASE_PROTOCOL_VERSION && value.type === "acquired";
}

function parseReadResult(
  value: Record<string, unknown>,
): ParsedBlacklistState | null {
  if (
    !hasExactKeys(value, ["requestId", "state", "status", "type", "version"]) ||
    value.version !== LEASE_PROTOCOL_VERSION ||
    value.type !== "read-result" ||
    !Number.isSafeInteger(value.requestId) ||
    (value.requestId as number) < 1 ||
    (value.status !== "valid" && value.status !== "migrated" &&
      value.status !== "missing" && value.status !== "malformed")
  ) {
    return null;
  }
  const canonical = parseBlacklistState(value.state);
  if (canonical.status !== "valid") {
    return null;
  }
  return {
    status: value.status,
    state: canonical.state,
  };
}

function parseWriteResult(
  value: Record<string, unknown>,
): { readonly requestId: number; readonly ok: boolean } | null {
  if (
    !hasExactKeys(value, ["ok", "requestId", "type", "version"]) ||
    value.version !== LEASE_PROTOCOL_VERSION ||
    value.type !== "write-result" ||
    !Number.isSafeInteger(value.requestId) ||
    (value.requestId as number) < 1 ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  return { requestId: value.requestId as number, ok: value.ok };
}

function disconnectQuietly(port: RuntimePort): void {
  try {
    port.disconnect();
  } catch {
    // The callback result has precedence over lease cleanup transport failures.
  }
}

export function createBackgroundBlacklistLockClient(
  runtime: RuntimeConnector,
): BackgroundBlacklistLockClient {
  return {
    async runExclusive<T>(
      operation: (lease: BackgroundBlacklistLease) => Promise<T>,
    ) {
      const port = runtime.connect({ name: BLACKLIST_LOCK_PORT_NAME });
      const pending = new Map<number, PendingRequest>();
      let acquiredSettled = false;
      let disconnected = false;
      let nextRequestId = 1;
      let resolveAcquired: (() => void) | undefined;
      let rejectAcquired: ((error: Error) => void) | undefined;
      const acquired = new Promise<void>((resolve, reject) => {
        resolveAcquired = resolve;
        rejectAcquired = reject;
      });

      const failClosed = (message: string): void => {
        if (disconnected) {
          return;
        }
        disconnected = true;
        const error = new Error(message);
        if (!acquiredSettled) {
          acquiredSettled = true;
          rejectAcquired?.(error);
        }
        for (const request of pending.values()) {
          request.reject(error);
        }
        pending.clear();
        disconnectQuietly(port);
      };

      port.onDisconnect.addListener(() => {
        failClosed("Background blacklist lease disconnected.");
      });
      port.onMessage.addListener((message) => {
        if (!acquiredSettled && isAcquiredMessage(message)) {
          acquiredSettled = true;
          resolveAcquired?.();
          return;
        }
        if (!acquiredSettled || !isRecord(message)) {
          failClosed("Background blacklist lease sent an invalid message.");
          return;
        }
        const read = parseReadResult(message);
        if (read) {
          const requestId = message.requestId as number;
          const request = pending.get(requestId);
          if (!request || request.kind !== "read") {
            failClosed("Background blacklist lease sent an unexpected read result.");
            return;
          }
          pending.delete(requestId);
          request.resolve(read);
          return;
        }
        const write = parseWriteResult(message);
        if (write) {
          const request = pending.get(write.requestId);
          if (!request || request.kind !== "write") {
            failClosed("Background blacklist lease sent an unexpected write result.");
            return;
          }
          pending.delete(write.requestId);
          if (write.ok) {
            request.resolve();
          } else {
            request.reject(new Error("Background rejected the blacklist write."));
          }
          return;
        }
        failClosed("Background blacklist lease sent an unknown message.");
      });

      const request = <Result>(
        kind: PendingRequest["kind"],
        message: Record<string, unknown>,
      ): Promise<Result> => {
        if (disconnected) {
          return Promise.reject(new Error("Background blacklist lease is unavailable."));
        }
        const requestId = nextRequestId;
        nextRequestId += 1;
        return new Promise<Result>((resolve, reject) => {
          pending.set(requestId, {
            kind,
            resolve: resolve as (value: ParsedBlacklistState | void) => void,
            reject,
          });
          try {
            port.postMessage({
              version: LEASE_PROTOCOL_VERSION,
              type: kind,
              requestId,
              ...message,
            });
          } catch {
            pending.delete(requestId);
            failClosed("Unable to send a background blacklist lease request.");
            reject(new Error("Unable to send a background blacklist lease request."));
          }
        });
      };

      await acquired;
      const lease: BackgroundBlacklistLease = {
        readState() {
          return request<ParsedBlacklistState>("read", {});
        },
        writeState(state) {
          return request<void>("write", { state });
        },
      };

      let result: T;
      try {
        result = await operation(lease);
      } catch (error) {
        try {
          if (!disconnected) {
            port.postMessage({ version: LEASE_PROTOCOL_VERSION, type: "release" });
          }
        } catch {
          // Preserve the operation failure.
        }
        disconnectQuietly(port);
        throw error;
      }

      try {
        if (!disconnected) {
          port.postMessage({ version: LEASE_PROTOCOL_VERSION, type: "release" });
        }
      } catch {
        // A completed callback remains successful even if cleanup transport fails.
      }
      disconnectQuietly(port);
      return result;
    },
  };
}
