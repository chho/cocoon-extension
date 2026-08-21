import type {
  BadgeIncrementMessage,
  BadgeMessage,
  BadgeMessageResponse,
  BadgeResetMessage,
} from "../core/badge-message-contract.ts";

export interface BadgeReporter {
  reset(): Promise<void>;
  recordFirstHidden(): void;
}

export interface BadgeReporterDependencies {
  readonly generation: string;
  readonly sendMessage: (message: BadgeMessage) => Promise<unknown>;
  readonly schedule: (callback: () => void) => void;
  readonly reportFailure?: () => void;
}

function isSuccessfulResponse(value: unknown): value is BadgeMessageResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  return Object.keys(response).length === 1 && response.ok === true;
}

export function createBadgeReporter(
  dependencies: BadgeReporterDependencies,
): BadgeReporter {
  let pendingDelta = 0;
  let dispatchScheduled = false;

  function reportFailure(): void {
    if (dependencies.reportFailure) {
      dependencies.reportFailure();
      return;
    }
    console.error("[Cocoon] 无法更新当前页面的拦截计数。");
  }

  async function send(message: BadgeMessage): Promise<void> {
    try {
      const response = await dependencies.sendMessage(message);
      if (!isSuccessfulResponse(response)) {
        reportFailure();
      }
    } catch {
      reportFailure();
    }
  }

  async function sendIncrement(delta: number): Promise<void> {
    const message = {
      version: 1,
      type: "cocoon.badge.increment",
      generation: dependencies.generation,
      delta,
    } satisfies BadgeIncrementMessage;
    await send(message);
  }

  async function flushIncrement(): Promise<void> {
    dispatchScheduled = false;
    const delta = pendingDelta;
    pendingDelta = 0;
    if (!Number.isSafeInteger(delta) || delta <= 0) {
      return;
    }
    await sendIncrement(delta);
  }

  function scheduleIncrement(): void {
    if (dispatchScheduled) {
      return;
    }
    dispatchScheduled = true;
    try {
      dependencies.schedule(() => {
        void flushIncrement();
      });
    } catch {
      dispatchScheduled = false;
      pendingDelta = 0;
      reportFailure();
    }
  }

  return {
    async reset() {
      const message = {
        version: 1,
        type: "cocoon.badge.reset",
        generation: dependencies.generation,
      } satisfies BadgeResetMessage;
      await send(message);
    },
    recordFirstHidden() {
      if (pendingDelta === Number.MAX_SAFE_INTEGER) {
        void sendIncrement(pendingDelta);
        pendingDelta = 1;
        return;
      }
      pendingDelta += 1;
      scheduleIncrement();
    },
  };
}
