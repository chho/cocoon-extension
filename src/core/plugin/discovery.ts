import type {
  SitePluginDescriptorModule,
  SitePluginModule,
} from "./contract.ts";
import {
  createPluginRegistry,
  type PluginRegistryResult,
} from "./registry.ts";

const pluginModules = import.meta.glob<SitePluginModule>(
  "../../plugins/*/plugin.ts",
  { eager: true },
);
const descriptorModules = import.meta.glob<SitePluginDescriptorModule>(
  "../../plugins/*/plugin.json",
  { eager: true },
);

function directoryIdFromDiscoveryPath(path: string): string | null {
  return /\/plugins\/([^/]+)\/plugin\.(?:ts|json)$/.exec(path)?.[1] ?? null;
}

export function discoverSitePluginRegistry(): PluginRegistryResult {
  const descriptors = Object.entries(descriptorModules).map(
    ([path, module]) => ({
      directoryId: directoryIdFromDiscoveryPath(path) ?? path,
      descriptor: module.default,
    }),
  );
  const runtimes = Object.entries(pluginModules).map(([path, module]) => ({
    directoryId: directoryIdFromDiscoveryPath(path) ?? path,
    plugin: module.default,
  }));
  return createPluginRegistry(descriptors, runtimes);
}
