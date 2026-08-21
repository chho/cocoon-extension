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
  readonly interceptionBadge: boolean;
}

export interface FirstHideReporter {
  recordFirstHidden(): void;
}

export interface SitePluginMountContext {
  readonly url: URL;
  readonly badgeReporter: FirstHideReporter;
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
