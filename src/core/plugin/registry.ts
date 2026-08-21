import type {
  SitePlugin,
  SitePluginCapabilities,
  SitePluginDescriptor,
} from "./contract.ts";
import {
  urlMatchesChromePattern,
  validatePluginDescriptor,
} from "./descriptor.ts";

const CAPABILITY_KEYS = [
  "cardFiltering",
  "commentFiltering",
  "hoverEntry",
  "remoteAccountBlock",
  "audienceVoterExpansion",
  "interceptionBadge",
] as const satisfies readonly (keyof SitePluginCapabilities)[];

export interface DiscoveredDescriptor {
  readonly directoryId: string;
  readonly descriptor: unknown;
}

export interface DiscoveredPluginRuntime {
  readonly directoryId: string;
  readonly plugin: unknown;
}

export interface PluginRegistry {
  readonly plugins: readonly SitePlugin[];
}

export type PluginRegistryResult =
  | { readonly valid: true; readonly registry: PluginRegistry }
  | { readonly valid: false; readonly errors: readonly string[] };

export type PluginSelection =
  | { readonly status: "selected"; readonly plugin: SitePlugin }
  | { readonly status: "no-match" }
  | {
      readonly status: "multiple-matches";
      readonly pluginIds: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function sameDescriptor(
  left: SitePluginDescriptor,
  right: SitePluginDescriptor,
): boolean {
  return left.id === right.id &&
    left.matches.length === right.matches.length &&
    left.matches.every((pattern, index) => pattern === right.matches[index]);
}

function validateCapabilities(value: unknown): SitePluginCapabilities | null {
  if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS)) {
    return null;
  }
  if (CAPABILITY_KEYS.some((key) => typeof value[key] !== "boolean")) {
    return null;
  }
  return {
    cardFiltering: value.cardFiltering as boolean,
    commentFiltering: value.commentFiltering as boolean,
    hoverEntry: value.hoverEntry as boolean,
    remoteAccountBlock: value.remoteAccountBlock as boolean,
    audienceVoterExpansion: value.audienceVoterExpansion as boolean,
    interceptionBadge: value.interceptionBadge as boolean,
  };
}

function validateRuntimePlugin(value: unknown): SitePlugin | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["descriptor", "capabilities", "mount"]) ||
    typeof value.mount !== "function"
  ) {
    return null;
  }
  const descriptor = validatePluginDescriptor(value.descriptor);
  const capabilities = validateCapabilities(value.capabilities);
  if (!descriptor.valid || !capabilities) {
    return null;
  }
  return {
    descriptor: descriptor.descriptor,
    capabilities,
    mount: value.mount as SitePlugin["mount"],
  };
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function createPluginRegistry(
  discoveredDescriptors: readonly DiscoveredDescriptor[],
  discoveredRuntimes: readonly DiscoveredPluginRuntime[],
): PluginRegistryResult {
  const errors: string[] = [];
  const descriptorsByDirectory = new Map<string, SitePluginDescriptor>();
  const runtimesByDirectory = new Map<string, SitePlugin>();

  for (const duplicate of duplicateValues(
    discoveredDescriptors.map(({ directoryId }) => directoryId),
  )) {
    errors.push(`duplicate descriptor directory: ${duplicate}`);
  }
  for (const duplicate of duplicateValues(
    discoveredRuntimes.map(({ directoryId }) => directoryId),
  )) {
    errors.push(`duplicate runtime directory: ${duplicate}`);
  }

  for (const discovered of discoveredDescriptors) {
    const validation = validatePluginDescriptor(discovered.descriptor);
    if (!validation.valid) {
      errors.push(
        ...validation.errors.map(
          (error) => `${discovered.directoryId}/plugin.json: ${error}`,
        ),
      );
      continue;
    }
    descriptorsByDirectory.set(discovered.directoryId, validation.descriptor);
    if (validation.descriptor.id !== discovered.directoryId) {
      errors.push(
        `${discovered.directoryId}/plugin.json id must match its directory`,
      );
    }
  }

  for (const discovered of discoveredRuntimes) {
    const plugin = validateRuntimePlugin(discovered.plugin);
    if (!plugin) {
      errors.push(`${discovered.directoryId}/plugin.ts has an invalid runtime contract`);
      continue;
    }
    runtimesByDirectory.set(discovered.directoryId, plugin);
  }

  const directories = new Set([
    ...descriptorsByDirectory.keys(),
    ...runtimesByDirectory.keys(),
  ]);
  const plugins: SitePlugin[] = [];
  for (const directoryId of [...directories].sort()) {
    const descriptor = descriptorsByDirectory.get(directoryId);
    const runtime = runtimesByDirectory.get(directoryId);
    if (!descriptor) {
      errors.push(`${directoryId} has plugin.ts but no valid plugin.json`);
      continue;
    }
    if (!runtime) {
      errors.push(`${directoryId} has plugin.json but no valid plugin.ts`);
      continue;
    }
    if (!sameDescriptor(descriptor, runtime.descriptor)) {
      errors.push(`${directoryId} descriptor/runtime metadata mismatch`);
      continue;
    }
    plugins.push({
      descriptor,
      capabilities: runtime.capabilities,
      mount: runtime.mount,
    });
  }

  for (const duplicate of duplicateValues(
    [...descriptorsByDirectory.values()].map(({ id }) => id),
  )) {
    errors.push(`duplicate plugin id: ${duplicate}`);
  }
  for (const duplicate of duplicateValues(
    [...descriptorsByDirectory.values()].flatMap(({ matches }) => matches),
  )) {
    errors.push(`duplicate plugin match pattern: ${duplicate}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors: [...new Set(errors)] };
  }
  return { valid: true, registry: { plugins } };
}

export function selectPluginForUrl(
  registry: PluginRegistry,
  url: URL,
): PluginSelection {
  const matches = registry.plugins.filter((plugin) =>
    plugin.descriptor.matches.some((pattern) =>
      urlMatchesChromePattern(url, pattern)
    )
  );
  if (matches.length === 0) {
    return { status: "no-match" };
  }
  if (matches.length > 1) {
    return {
      status: "multiple-matches",
      pluginIds: matches.map(({ descriptor }) => descriptor.id),
    };
  }
  return { status: "selected", plugin: matches[0]! };
}
