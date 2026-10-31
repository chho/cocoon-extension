import type * as Contract from "./contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundContract from "./contract.ts?background-copy";
import { createDiagnosticStore, type DiagnosticStore } from "./storage.ts";

const { DIAGNOSTIC_CHANNEL, parseDiagnosticRequest } = backgroundContract as typeof Contract;
const RESPONSE_TIMEOUT_MS = 1_500;

interface DiagnosticSender {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}

interface ListenerDependencies {
  store: DiagnosticStore;
  runtimeId: string;
  scheduleTimeout: (callback: () => void, milliseconds: number) => () => void;
}

function authorized(sender: DiagnosticSender, runtimeId: string): boolean {
  const tabId = sender.tab?.id;
  return (
    sender.id === runtimeId &&
    sender.url === "https://www.zhihu.com/" &&
    sender.frameId === 0 &&
    Number.isSafeInteger(tabId) &&
    (tabId as number) >= 0
  );
}

function startResponse(
  request: Contract.DiagnosticRequest,
  sendResponse: (response: { ok: boolean }) => void,
  dependencies: ListenerDependencies,
): void {
  const controller = new AbortController();
  let responded = false;
  let cancelTimeout = () => {};
  const respond = (ok: boolean) => {
    if (responded) return;
    responded = true;
    cancelTimeout();
    try {
      sendResponse({ ok });
    } catch {
      /* The content document may already be gone. */
    }
  };
  cancelTimeout = dependencies.scheduleTimeout(() => {
    controller.abort();
    respond(false);
  }, RESPONSE_TIMEOUT_MS);
  void (async () => {
    let ok = false;
    try {
      ok = await dependencies.store.handle(request, controller.signal);
    } catch {
      /* Diagnostic failures are isolated. */
    }
    respond(ok);
  })();
}

export function createDiagnosticMessageListener(dependencies: ListenerDependencies) {
  return (
    message: unknown,
    sender: DiagnosticSender,
    sendResponse: (response: { ok: boolean }) => void,
  ): boolean => {
    try {
      if (!authorized(sender, dependencies.runtimeId)) return false;
      const request = parseDiagnosticRequest(message);
      if (!request) return false;
      startResponse(request, sendResponse, dependencies);
      return true;
    } catch {
      return false;
    }
  };
}

export function installDiagnosticBackground(): void {
  try {
    const store = createDiagnosticStore({
      storage: {
        async get(key) {
          return chrome.storage.local.get(key) as Promise<Record<string, unknown>>;
        },
        async set(items) {
          await chrome.storage.local.set(items);
        },
        async remove(key) {
          await chrome.storage.local.remove(key);
        },
      },
      locks: {
        async request(name, options, callback) {
          return navigator.locks.request(name, options, async () => callback());
        },
      },
      now: Date.now,
    });
    chrome.runtime.onMessage.addListener(
      createDiagnosticMessageListener({
        store,
        runtimeId: chrome.runtime.id,
        scheduleTimeout(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      }),
    );
    // Retention uses startup/requests, never a timer that assumes worker permanence.
    void store.handle(
      { channel: DIAGNOSTIC_CHANNEL, operation: "prune" },
      AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
    );
  } catch {
    // Missing diagnostic infrastructure must never prevent primary worker startup.
  }
}
