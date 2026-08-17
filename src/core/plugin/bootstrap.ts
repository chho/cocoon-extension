import type { SitePluginMountContext } from "./contract.ts";
import {
  selectPluginForUrl,
  type PluginRegistryResult,
} from "./registry.ts";

export type PluginBootstrapResult =
  | { readonly status: "mounted"; readonly pluginId: string }
  | { readonly status: "no-match" }
  | {
      readonly status: "multiple-matches";
      readonly pluginIds: readonly string[];
    }
  | {
      readonly status: "invalid-registry";
      readonly errors: readonly string[];
    }
  | {
      readonly status: "mount-failed";
      readonly pluginId: string;
      readonly error: unknown;
    };

export interface SitePluginBootstrap {
  start(context: SitePluginMountContext): Promise<PluginBootstrapResult>;
}

export function createSitePluginBootstrap(
  registryResult: PluginRegistryResult,
): SitePluginBootstrap {
  let started: Promise<PluginBootstrapResult> | null = null;

  async function run(
    context: SitePluginMountContext,
  ): Promise<PluginBootstrapResult> {
    if (!registryResult.valid) {
      return {
        status: "invalid-registry",
        errors: registryResult.errors,
      };
    }

    const selection = selectPluginForUrl(registryResult.registry, context.url);
    if (selection.status !== "selected") {
      return selection;
    }

    try {
      await selection.plugin.mount(context);
      return {
        status: "mounted",
        pluginId: selection.plugin.descriptor.id,
      };
    } catch (error) {
      return {
        status: "mount-failed",
        pluginId: selection.plugin.descriptor.id,
        error,
      };
    }
  }

  return {
    start(context) {
      started ??= run(context);
      return started;
    },
  };
}
