import type { SitePluginBootstrap } from "../core/plugin/bootstrap.ts";
import type { PluginBootstrapResult } from "../core/plugin/bootstrap.ts";
import type { BadgeReporter } from "./badge-reporter.ts";

export async function startSitePluginWithBadgeReset(
  bootstrap: SitePluginBootstrap,
  url: URL,
  badgeReporter: BadgeReporter,
): Promise<PluginBootstrapResult> {
  await badgeReporter.reset();
  return bootstrap.start({ url, badgeReporter });
}
