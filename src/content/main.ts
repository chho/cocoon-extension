import { startSitePluginWithBadgeReset } from "./badge-bootstrap.ts";
import { createBadgeReporter } from "./badge-reporter.ts";
import { createSitePluginBootstrap } from "../core/plugin/bootstrap.ts";
import { discoverSitePluginRegistry } from "../core/plugin/discovery.ts";
import { registerContentStatusPing } from "./status-ping.ts";

async function startContentScript(): Promise<void> {
  const generation = crypto.randomUUID();
  const badgeReporter = createBadgeReporter({
    generation,
    async sendMessage(message) {
      return chrome.runtime.sendMessage(message);
    },
    schedule(callback) {
      queueMicrotask(callback);
    },
  });
  const bootstrap = createSitePluginBootstrap(discoverSitePluginRegistry());
  const result = await startSitePluginWithBadgeReset(
    bootstrap,
    new URL(window.location.href),
    badgeReporter,
  );

  if (result.status === "mounted") {
    registerContentStatusPing(generation);
  } else if (result.status === "invalid-registry") {
    console.error("[Cocoon] 站点插件注册表无效，内容脚本已安全停止。");
  } else if (result.status === "multiple-matches") {
    console.error("[Cocoon] 当前页面匹配多个站点插件，内容脚本已安全停止。");
  } else if (result.status === "mount-failed") {
    console.error("[Cocoon] 站点插件启动失败。", result.error);
  }
}

void startContentScript();
