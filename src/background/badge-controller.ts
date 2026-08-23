import type {
  BadgeIncrementMessage,
  BadgeMessage,
  BadgeMessageResponse,
  BadgeResetMessage,
} from "../core/badge-message-contract.ts";

const MESSAGE_VERSION = 1;
const RESET_MESSAGE_TYPE = "cocoon.badge.reset";
const INCREMENT_MESSAGE_TYPE = "cocoon.badge.increment";
const STORAGE_KEY_PREFIX = "cocoonBadgeTab:";
const LOCK_NAME_PREFIX = "cocoon-badge-tab:";
const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const BADGE_BACKGROUND_COLOR = "#5F6368";

export interface BadgeSessionState {
  readonly generation: string;
  readonly count: number;
}

export interface BadgeSessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface BadgeAction {
  setBadgeBackgroundColor(details: {
    readonly tabId: number;
    readonly color: string;
  }): Promise<void>;
  setBadgeText(details: { readonly tabId: number; readonly text: string }): Promise<void>;
}

export interface BadgeLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface BadgeMessageSender {
  readonly tab?: { readonly id?: number };
  readonly frameId?: number;
}

export interface BadgeControllerDependencies {
  readonly storage: BadgeSessionStorage;
  readonly action: BadgeAction;
  readonly locks: BadgeLockManager;
}

export type BadgeStatusStateRead =
  | { readonly status: "valid"; readonly state: BadgeSessionState }
  | { readonly status: "missing" }
  | { readonly status: "invalid" };

export interface BadgeController {
  handleMessage(
    message: unknown,
    sender: BadgeMessageSender,
  ): Promise<BadgeMessageResponse>;
  clearForNavigation(tabId: number): Promise<boolean>;
  clearForRemoval(tabId: number): Promise<boolean>;
  getStatusState(tabId: number): Promise<BadgeStatusStateRead>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isGeneration(value: unknown): value is string {
  return typeof value === "string" && GENERATION_PATTERN.test(value);
}

export function parseBadgeMessage(value: unknown): BadgeMessage | null {
  if (!isRecord(value) || value.version !== MESSAGE_VERSION) {
    return null;
  }

  if (
    value.type === RESET_MESSAGE_TYPE &&
    hasExactKeys(value, ["version", "type", "generation"]) &&
    isGeneration(value.generation)
  ) {
    return {
      version: 1,
      type: RESET_MESSAGE_TYPE,
      generation: value.generation,
    } satisfies BadgeResetMessage;
  }

  if (
    value.type === INCREMENT_MESSAGE_TYPE &&
    hasExactKeys(value, ["version", "type", "generation", "delta"]) &&
    isGeneration(value.generation) &&
    Number.isSafeInteger(value.delta) &&
    (value.delta as number) > 0
  ) {
    return {
      version: 1,
      type: INCREMENT_MESSAGE_TYPE,
      generation: value.generation,
      delta: value.delta as number,
    } satisfies BadgeIncrementMessage;
  }

  return null;
}

export function getMainFrameTabId(sender: BadgeMessageSender): number | null {
  const tabId = sender.tab?.id;
  return Number.isSafeInteger(tabId) && (tabId as number) >= 0 &&
      sender.frameId === 0
    ? tabId as number
    : null;
}

function parseBadgeSessionState(value: unknown): BadgeSessionState | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["generation", "count"]) ||
    !isGeneration(value.generation) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0
  ) {
    return null;
  }
  return {
    generation: value.generation,
    count: value.count as number,
  };
}

export function badgeStorageKey(tabId: number): string {
  return `${STORAGE_KEY_PREFIX}${tabId}`;
}

export function formatBadgeCount(count: number): string {
  if (count === 0) {
    return "";
  }
  return count >= 1_000 ? "999+" : String(count);
}

export function createBadgeController(
  dependencies: BadgeControllerDependencies,
): BadgeController {
  async function withTabLock<T>(
    tabId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return dependencies.locks.request(
      `${LOCK_NAME_PREFIX}${tabId}`,
      { mode: "exclusive" },
      operation,
    );
  }

  async function updateBadge(tabId: number, count: number): Promise<void> {
    if (count > 0) {
      await dependencies.action.setBadgeBackgroundColor({
        tabId,
        color: BADGE_BACKGROUND_COLOR,
      });
    }
    await dependencies.action.setBadgeText({
      tabId,
      text: formatBadgeCount(count),
    });
  }

  async function reset(
    tabId: number,
    message: BadgeResetMessage,
  ): Promise<boolean> {
    try {
      return await withTabLock(tabId, async () => {
        const state: BadgeSessionState = {
          generation: message.generation,
          count: 0,
        };
        await dependencies.storage.set({ [badgeStorageKey(tabId)]: state });
        await updateBadge(tabId, 0);
        return true;
      });
    } catch {
      return false;
    }
  }

  async function increment(
    tabId: number,
    message: BadgeIncrementMessage,
  ): Promise<boolean> {
    try {
      return await withTabLock(tabId, async () => {
        const key = badgeStorageKey(tabId);
        const values = await dependencies.storage.get(key);
        const state = parseBadgeSessionState(values[key]);
        if (!state || state.generation !== message.generation) {
          return false;
        }
        const nextCount = state.count + message.delta;
        if (!Number.isSafeInteger(nextCount)) {
          return false;
        }
        const nextState: BadgeSessionState = {
          generation: state.generation,
          count: nextCount,
        };
        await dependencies.storage.set({ [key]: nextState });
        await updateBadge(tabId, nextCount);
        return true;
      });
    } catch {
      return false;
    }
  }

  async function clear(
    tabId: number,
    clearAction: boolean,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      return false;
    }
    try {
      return await withTabLock(tabId, async () => {
        await dependencies.storage.remove(badgeStorageKey(tabId));
        if (clearAction) {
          await updateBadge(tabId, 0);
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  return {
    async handleMessage(message, sender) {
      const parsedMessage = parseBadgeMessage(message);
      const tabId = getMainFrameTabId(sender);
      if (!parsedMessage || tabId === null) {
        return { ok: false };
      }

      const ok = parsedMessage.type === RESET_MESSAGE_TYPE
        ? await reset(tabId, parsedMessage)
        : await increment(tabId, parsedMessage);
      return { ok };
    },
    clearForNavigation(tabId) {
      return clear(tabId, true);
    },
    clearForRemoval(tabId) {
      return clear(tabId, false);
    },
    async getStatusState(tabId) {
      if (!Number.isSafeInteger(tabId) || tabId < 0) {
        return { status: "invalid" };
      }
      try {
        const key = badgeStorageKey(tabId);
        const values = await dependencies.storage.get(key);
        if (!(key in values)) {
          return { status: "missing" };
        }
        const state = parseBadgeSessionState(values[key]);
        return state
          ? { status: "valid", state }
          : { status: "invalid" };
      } catch {
        return { status: "invalid" };
      }
    },
  };
}
