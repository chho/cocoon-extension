import { createBadgeController } from "./badge-controller.ts";
import { createBadgeRuntimeMessageListener } from "./listeners.ts";

function reportBadgeFailure(): void {
  console.error("[Cocoon] 无法更新当前标签页的拦截计数。");
}

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

chrome.runtime.onMessage.addListener(
  createBadgeRuntimeMessageListener(badgeController, reportBadgeFailure),
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }
  void (async () => {
    if (!await badgeController.clearForNavigation(tabId)) {
      reportBadgeFailure();
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if (!await badgeController.clearForRemoval(tabId)) {
      reportBadgeFailure();
    }
  })();
});
