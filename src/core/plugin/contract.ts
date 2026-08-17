export interface SitePluginDescriptor {
  readonly id: string;
  readonly matches: readonly string[];
}

/**
 * Capabilities describe behavior implemented by a mounted plugin. They are
 * informational and never add Chrome permissions or Manifest match patterns.
 */
export interface SitePluginCapabilities {
  readonly cardFiltering: boolean;
  readonly commentFiltering: boolean;
  readonly hoverEntry: boolean;
  readonly remoteAccountBlock: boolean;
  readonly audienceVoterExpansion: boolean;
}

export interface SitePluginMountContext {
  readonly url: URL;
}

export interface SitePlugin {
  readonly descriptor: SitePluginDescriptor;
  readonly capabilities: SitePluginCapabilities;
  mount(context: SitePluginMountContext): void | Promise<void>;
}

export interface SitePluginModule {
  readonly default: unknown;
}

export interface SitePluginDescriptorModule {
  readonly default: unknown;
}
