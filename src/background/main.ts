import { createBadgeController } from "./badge-controller.ts";
import {
  createBadgeRuntimeMessageListener,
  createBlacklistRuntimeMessageListener,
} from "./listeners.ts";
import { createBlacklistLockCoordinator } from "./blacklist-lock-coordinator.ts";
import { createBlacklistManagementController } from "./blacklist-management-controller.ts";
import { createStatusController } from "./status-controller.ts";

function reportBadgeFailure(): void {
  console.error("[Cocoon] 无法更新当前标签页的拦截计数。");
}

function reportBlacklistFailure(): void {
  console.error("[Cocoon] 本地黑名单协调操作失败。");
}

const blacklistLocalStorage = {
  async get(key: string) {
    return chrome.storage.local.get(key) as Promise<Record<string, unknown>>;
  },
  async set(items: Record<string, unknown>) {
    await chrome.storage.local.set(items);
  },
};

const blacklistLockCoordinator = createBlacklistLockCoordinator(
  {
    async request(name, options, callback) {
      return navigator.locks.request(name, options, async () => callback());
    },
  },
  blacklistLocalStorage,
  chrome.runtime.id,
  reportBlacklistFailure,
);

chrome.runtime.onConnect.addListener((port) => {
  blacklistLockCoordinator.attachContentLease({
    name: port.name,
    sender: port.sender,
    onDisconnect: {
      addListener(listener) {
        port.onDisconnect.addListener(listener);
      },
    },
    onMessage: {
      addListener(listener) {
        port.onMessage.addListener(listener);
      },
    },
    postMessage(message) {
      port.postMessage(message);
    },
    disconnect() {
      port.disconnect();
    },
  });
});

const badgeController = createBadgeController({
  storage: {
    async get(key) {
      return chrome.storage.session.get(key) as Promise<Record<string, unknown>>;
    },
    async set(items) {
      await chrome.storage.session.set(items);
    },
    async remove(key) {
      await chrome.storage.session.remove(key);
    },
  },
  action: {
    async setBadgeBackgroundColor(details) {
      await chrome.action.setBadgeBackgroundColor(details);
    },
    async setBadgeTextColor(details) {
      await chrome.action.setBadgeTextColor(details);
    },
    async setBadgeText(details) {
      await chrome.action.setBadgeText(details);
    },
  },
  locks: {
    async request(name, options, callback) {
      return navigator.locks.request(name, options, async () => callback());
    },
  },
});

const statusController = createStatusController(
  {
    async query(queryInfo) {
      return chrome.tabs.query(queryInfo);
    },
    async sendMessage(tabId, message) {
      return chrome.tabs.sendMessage(tabId, message);
    },
  },
  badgeController,
);

const blacklistManagementController = createBlacklistManagementController(
  blacklistLocalStorage,
  blacklistLockCoordinator,
  statusController,
);

chrome.runtime.onMessage.addListener(
  createBadgeRuntimeMessageListener(badgeController, reportBadgeFailure),
);
chrome.runtime.onMessage.addListener(
  createBlacklistRuntimeMessageListener(
    blacklistManagementController,
    chrome.runtime.id,
    reportBlacklistFailure,
  ),
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }
  void (async () => {
    if (!(await badgeController.clearForNavigation(tabId))) {
      reportBadgeFailure();
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if (!(await badgeController.clearForRemoval(tabId))) {
      reportBadgeFailure();
    }
  })();
});
