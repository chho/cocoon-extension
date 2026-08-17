import { createSitePluginBootstrap } from "../core/plugin/bootstrap.ts";
import { discoverSitePluginRegistry } from "../core/plugin/discovery.ts";

async function startContentScript(): Promise<void> {
  const bootstrap = createSitePluginBootstrap(discoverSitePluginRegistry());
  const result = await bootstrap.start({ url: new URL(window.location.href) });

  if (result.status === "invalid-registry") {
    console.error("[Cocoon] 站点插件注册表无效，内容脚本已安全停止。");
  } else if (result.status === "multiple-matches") {
    console.error("[Cocoon] 当前页面匹配多个站点插件，内容脚本已安全停止。");
  } else if (result.status === "mount-failed") {
    console.error("[Cocoon] 站点插件启动失败。", result.error);
  }
}

void startContentScript();
