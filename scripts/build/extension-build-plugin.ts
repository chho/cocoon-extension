import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import type { Plugin, Rollup } from "vite";

import {
  composeManifest,
  readBaseManifest,
  scanSitePlugins,
  type ContentScriptResources,
  type ExtensionManifest,
  type ScannedSitePlugin,
} from "./plugin-manifest.ts";

export interface ExtensionBuildPluginOptions {
  readonly projectRoot: string;
  readonly pluginsRoot?: string;
  readonly baseManifestPath?: string;
  readonly discoveryModulePath?: string;
  readonly contentResources?: ContentScriptResources;
}

const DEFAULT_CONTENT_RESOURCES: ContentScriptResources = {
  js: "assets/content.js",
  css: "assets/content.css",
};
const BACKGROUND_RESOURCE = "assets/background.js";

interface ModulePathIdentity {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
}

function lexicalModulePath(id: string): string {
  const queryIndex = id.indexOf("?");
  return resolve(queryIndex === -1 ? id : id.slice(0, queryIndex));
}

function canonicalModulePath(lexicalPath: string): string {
  try {
    return realpathSync.native(lexicalPath);
  } catch {
    return lexicalPath;
  }
}

function identifyModule(id: string): ModulePathIdentity {
  const lexicalPath = lexicalModulePath(id);
  return {
    lexicalPath,
    canonicalPath: canonicalModulePath(lexicalPath),
  };
}

function pathWithinRoot(path: string, root: string): boolean {
  const pathRelativeToRoot = relative(root, path);
  return Boolean(pathRelativeToRoot) &&
    pathRelativeToRoot !== ".." &&
    !pathRelativeToRoot.startsWith(`..${sep}`);
}

function conventionModulePath(
  path: string,
  pluginsRoot: string,
): string | null {
  if (!pathWithinRoot(path, pluginsRoot)) {
    return null;
  }

  const modulePath = relative(pluginsRoot, path);
  const segments = modulePath.split(sep);
  return segments.length === 2 &&
      (segments[1] === "plugin.ts" || segments[1] === "plugin.json")
    ? modulePath
    : null;
}

function lexicalConventionModulePath(
  module: ModulePathIdentity,
  pluginsRoot: ModulePathIdentity,
): string | null {
  return conventionModulePath(module.lexicalPath, pluginsRoot.lexicalPath) ??
    conventionModulePath(module.lexicalPath, pluginsRoot.canonicalPath);
}

function formatPluginPaths(paths: readonly string[]): string {
  return [...paths].sort().join(", ");
}

function assertSamePluginModules(
  actualPaths: ReadonlySet<string>,
  expectedPaths: ReadonlySet<string>,
  graphName: string,
): void {
  const missing = [...expectedPaths].filter((path) => !actualPaths.has(path));
  const unexpected = [...actualPaths].filter((path) => !expectedPaths.has(path));
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const details: string[] = [];
  if (missing.length > 0) {
    details.push(
      `missing ${graphName} modules: ${formatPluginPaths(missing)}`,
    );
  }
  if (unexpected.length > 0) {
    details.push(
      `unexpected ${graphName} modules: ${formatPluginPaths(unexpected)}`,
    );
  }
  throw new Error(
    `[Cocoon build] Manifest/runtime plugin set mismatch (${details.join("; ")})`,
  );
}

interface ConventionModuleIdentity extends ModulePathIdentity {
  readonly conventionPath: string;
  readonly foundLexically: boolean;
}

function identifyConventionModule(
  id: string,
  pluginsRoot: ModulePathIdentity,
): ConventionModuleIdentity | null {
  const module = identifyModule(id);
  const lexicalConventionPath = lexicalConventionModulePath(
    module,
    pluginsRoot,
  );
  const canonicalConventionPath = conventionModulePath(
    module.canonicalPath,
    pluginsRoot.canonicalPath,
  );
  const conventionPath = lexicalConventionPath ?? canonicalConventionPath;
  return conventionPath
    ? {
      ...module,
      conventionPath,
      foundLexically: lexicalConventionPath !== null,
    }
    : null;
}

function expectedPluginModules(
  plugins: readonly ScannedSitePlugin[],
  pluginsRoot: ModulePathIdentity,
): ReadonlyMap<string, ConventionModuleIdentity> {
  const modules = plugins.flatMap(({ descriptorPath, entryPath }) => [
    identifyConventionModule(descriptorPath, pluginsRoot),
    identifyConventionModule(entryPath, pluginsRoot),
  ]);
  const expected = new Map<string, ConventionModuleIdentity>();
  for (const module of modules) {
    if (!module) {
      throw new Error(
        "[Cocoon build] scanned plugin convention path is outside plugins root",
      );
    }
    expected.set(module.conventionPath, module);
  }
  return expected;
}

function collectDiscoveryConventionModules(
  importedIds: readonly string[],
  pluginsRoot: ModulePathIdentity,
): ReadonlyMap<string, ConventionModuleIdentity> {
  const modules = new Map<string, ConventionModuleIdentity>();
  for (const id of importedIds) {
    const module = identifyConventionModule(id, pluginsRoot);
    if (module) {
      modules.set(module.conventionPath, module);
    }
  }
  return modules;
}

function collectContentConventionModules(
  moduleIds: readonly string[],
  pluginsRoot: ModulePathIdentity,
  discoveredModules: ReadonlyMap<string, ConventionModuleIdentity>,
): ReadonlyMap<string, ConventionModuleIdentity> {
  const modules = new Map<string, ConventionModuleIdentity>();
  const discoveredByCanonicalPath = new Map<
    string,
    ConventionModuleIdentity[]
  >();
  for (const module of discoveredModules.values()) {
    const aliases = discoveredByCanonicalPath.get(module.canonicalPath) ?? [];
    aliases.push(module);
    discoveredByCanonicalPath.set(module.canonicalPath, aliases);
  }

  for (const id of moduleIds) {
    const moduleIdentity = identifyModule(id);
    const module = identifyConventionModule(id, pluginsRoot);
    if (module) {
      modules.set(module.conventionPath, module);
    }
    for (
      const discoveredModule of
        discoveredByCanonicalPath.get(moduleIdentity.canonicalPath) ?? []
    ) {
      modules.set(discoveredModule.conventionPath, discoveredModule);
    }
  }
  return modules;
}

function assertRuntimePluginGraph(
  context: Rollup.PluginContext,
  contentChunk: Rollup.OutputChunk,
  discoveryModulePath: ModulePathIdentity,
  pluginsRoot: ModulePathIdentity,
  plugins: readonly ScannedSitePlugin[],
): void {
  const discoveryId = [...context.getModuleIds()].find((id) => {
    const module = identifyModule(id);
    return module.lexicalPath === discoveryModulePath.lexicalPath ||
      module.canonicalPath === discoveryModulePath.canonicalPath;
  });
  const discoveryInfo = discoveryId
    ? context.getModuleInfo(discoveryId)
    : null;
  if (!discoveryInfo) {
    throw new Error(
      "[Cocoon build] plugin discovery module is absent from the bundle graph",
    );
  }

  const expectedModules = expectedPluginModules(plugins, pluginsRoot);
  const discoveredModules = collectDiscoveryConventionModules(
    discoveryInfo.importedIds,
    pluginsRoot,
  );
  const escapedDiscoveryModules = [...discoveredModules.values()].filter(
    (module) =>
      module.foundLexically &&
      !pathWithinRoot(module.canonicalPath, pluginsRoot.canonicalPath),
  );
  if (escapedDiscoveryModules.length > 0) {
    throw new Error(
      `[Cocoon build] unexpected runtime convention modules resolve outside plugins root: ${
        formatPluginPaths(
          escapedDiscoveryModules.map(({ conventionPath }) => conventionPath),
        )
      }`,
    );
  }

  const expectedPaths = new Set(expectedModules.keys());
  const discoveredPaths = new Set(discoveredModules.keys());
  assertSamePluginModules(
    discoveredPaths,
    expectedPaths,
    "runtime",
  );

  const contentModules = collectContentConventionModules(
    Object.keys(contentChunk.modules),
    pluginsRoot,
    discoveredModules,
  );
  assertSamePluginModules(
    new Set(contentModules.keys()),
    expectedPaths,
    "content.js convention",
  );
}

export function createExtensionBuildPlugin(
  options: ExtensionBuildPluginOptions,
): Plugin {
  const projectRoot = lexicalModulePath(options.projectRoot);
  const pluginsRoot = identifyModule(
    options.pluginsRoot ?? resolve(projectRoot, "src/plugins"),
  );
  const baseManifestPath = identifyModule(
    options.baseManifestPath ?? resolve(projectRoot, "public/manifest.json"),
  );
  const discoveryModulePath = identifyModule(
    options.discoveryModulePath ??
      resolve(projectRoot, "src/core/plugin/discovery.ts"),
  );
  const contentResources = options.contentResources ?? DEFAULT_CONTENT_RESOURCES;
  let plugins: readonly ScannedSitePlugin[] = [];
  let baseManifest: ExtensionManifest = {};
  let descriptorLexicalPaths = new Set<string>();
  let descriptorCanonicalPaths = new Set<string>();

  return {
    name: "cocoon-extension-manifest",
    buildStart: {
      sequential: true,
      async handler() {
        this.addWatchFile(pluginsRoot.lexicalPath);
        this.addWatchFile(baseManifestPath.lexicalPath);
        this.addWatchFile(discoveryModulePath.lexicalPath);

        const scannedPlugins = await scanSitePlugins(pluginsRoot.lexicalPath);
        const scannedManifest = await readBaseManifest(
          baseManifestPath.lexicalPath,
        );
        plugins = scannedPlugins;
        baseManifest = scannedManifest;
        const descriptorModules = plugins.map(({ descriptorPath }) =>
          identifyModule(descriptorPath)
        );
        descriptorLexicalPaths = new Set(
          descriptorModules.map(({ lexicalPath }) => lexicalPath),
        );
        descriptorCanonicalPaths = new Set(
          descriptorModules.map(({ canonicalPath }) => canonicalPath),
        );

        for (const plugin of plugins) {
          this.addWatchFile(plugin.directoryPath);
          this.addWatchFile(plugin.descriptorPath);
          this.addWatchFile(plugin.entryPath);
        }
      },
    },
    shouldTransformCachedModule({ id }) {
      const module = identifyModule(id);
      if (
        module.lexicalPath === discoveryModulePath.lexicalPath ||
        module.canonicalPath === discoveryModulePath.canonicalPath ||
        descriptorLexicalPaths.has(module.lexicalPath) ||
        descriptorCanonicalPaths.has(module.canonicalPath)
      ) {
        return true;
      }
      return null;
    },
    generateBundle(_outputOptions, bundle) {
      const contentChunk = bundle[contentResources.js];
      if (contentChunk?.type !== "chunk" || !contentChunk.isEntry) {
        throw new Error(
          `[Cocoon build] missing stable ${contentResources.js} entry`,
        );
      }
      if (
        contentChunk.imports.length > 0 ||
        contentChunk.dynamicImports.length > 0
      ) {
        throw new Error(
          "[Cocoon build] content.js must be self-contained without shared or dynamic chunks",
        );
      }
      if (bundle[contentResources.css]?.type !== "asset") {
        throw new Error(
          `[Cocoon build] missing stable ${contentResources.css} asset`,
        );
      }
      const backgroundChunk = bundle[BACKGROUND_RESOURCE];
      if (backgroundChunk?.type !== "chunk" || !backgroundChunk.isEntry) {
        throw new Error(
          `[Cocoon build] missing stable ${BACKGROUND_RESOURCE} entry`,
        );
      }
      if (
        backgroundChunk.imports.length > 0 ||
        backgroundChunk.dynamicImports.length > 0
      ) {
        throw new Error(
          "[Cocoon build] background.js must be self-contained without shared or dynamic chunks",
        );
      }

      assertRuntimePluginGraph(
        this,
        contentChunk,
        discoveryModulePath,
        pluginsRoot,
        plugins,
      );
      const manifest = composeManifest(baseManifest, plugins, contentResources);
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}
