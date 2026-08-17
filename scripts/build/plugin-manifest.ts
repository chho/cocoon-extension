import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { SitePluginDescriptor } from "../../src/core/plugin/contract.ts";
import { validatePluginDescriptor } from "../../src/core/plugin/descriptor.ts";

export interface ScannedSitePlugin {
  readonly directoryId: string;
  readonly directoryPath: string;
  readonly descriptorPath: string;
  readonly entryPath: string;
  readonly descriptor: SitePluginDescriptor;
}

export interface ContentScriptResources {
  readonly js: string;
  readonly css: string;
}

export type ExtensionManifest = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildError(message: string): Error {
  return new Error(`[Cocoon plugin build] ${message}`);
}

interface PluginConventionStructure {
  readonly pluginDirectoryNames: readonly string[];
  readonly conventionFiles: readonly string[];
}

async function inspectPluginConventionStructure(
  root: string,
): Promise<PluginConventionStructure> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink()) {
    throw buildError("symbolic link is not allowed: .");
  }
  if (!rootStats.isDirectory()) {
    throw buildError("plugins root must be a regular directory");
  }

  const pluginDirectoryNames: string[] = [];
  const conventionFiles: string[] = [];

  async function visit(directory: string, isRoot: boolean): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isSymbolicLink()) {
        throw buildError(`symbolic link is not allowed: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (isRoot) {
          pluginDirectoryNames.push(entry.name);
        }
        await visit(path, false);
        continue;
      }
      if (!entry.isFile()) {
        throw buildError(
          `unsupported filesystem entry: ${relativePath}; only regular files and directories are allowed`,
        );
      }
      if (entry.name === "plugin.ts" || entry.name === "plugin.json") {
        conventionFiles.push(path);
      }
    }
  }

  await visit(root, true);
  return {
    pluginDirectoryNames,
    conventionFiles: conventionFiles.sort(),
  };
}

export async function scanSitePlugins(
  pluginsRoot: string,
): Promise<readonly ScannedSitePlugin[]> {
  const { pluginDirectoryNames, conventionFiles } =
    await inspectPluginConventionStructure(pluginsRoot);
  const pluginDirectories = [...pluginDirectoryNames].sort((left, right) =>
    left.localeCompare(right)
  );
  const expectedConventionFiles = new Set<string>();
  const plugins: ScannedSitePlugin[] = [];

  for (const directory of pluginDirectories) {
    const directoryPath = join(pluginsRoot, directory);
    const descriptorPath = join(directoryPath, "plugin.json");
    const entryPath = join(directoryPath, "plugin.ts");
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const entryNames = new Set(entries.filter((entry) => entry.isFile()).map(({ name }) => name));
    const hasDescriptor = entryNames.has("plugin.json");
    const hasEntry = entryNames.has("plugin.ts");
    if (!hasDescriptor || !hasEntry) {
      throw buildError(
        `${directory} must contain both plugin.json and plugin.ts`,
      );
    }
    expectedConventionFiles.add(descriptorPath);
    expectedConventionFiles.add(entryPath);

    let rawDescriptor: unknown;
    try {
      rawDescriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as unknown;
    } catch (error) {
      throw buildError(
        `${relative(pluginsRoot, descriptorPath)} is not valid JSON: ${String(error)}`,
      );
    }
    const validation = validatePluginDescriptor(rawDescriptor);
    if (!validation.valid) {
      throw buildError(
        `${relative(pluginsRoot, descriptorPath)}: ${validation.errors.join("; ")}`,
      );
    }
    if (validation.descriptor.id !== directory) {
      throw buildError(
        `${relative(pluginsRoot, descriptorPath)} id must equal directory ${directory}`,
      );
    }

    plugins.push({
      directoryId: directory,
      directoryPath,
      descriptorPath,
      entryPath,
      descriptor: validation.descriptor,
    });
  }

  const orphan = conventionFiles.find((path) => !expectedConventionFiles.has(path));
  if (orphan) {
    throw buildError(`orphan convention file: ${relative(pluginsRoot, orphan)}`);
  }
  if (plugins.length === 0) {
    throw buildError("at least one site plugin is required");
  }

  const ids = new Set<string>();
  const matches = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.descriptor.id)) {
      throw buildError(`duplicate plugin id: ${plugin.descriptor.id}`);
    }
    ids.add(plugin.descriptor.id);
    for (const matchPattern of plugin.descriptor.matches) {
      if (matches.has(matchPattern)) {
        throw buildError(`duplicate plugin match pattern: ${matchPattern}`);
      }
      matches.add(matchPattern);
    }
  }

  return plugins;
}

export function parseBaseManifest(value: unknown): ExtensionManifest {
  if (!isRecord(value)) {
    throw buildError("public/manifest.json must contain an object");
  }
  if (value.manifest_version !== 3) {
    throw buildError("base Manifest must use manifest_version 3");
  }
  if (
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.version !== "string" ||
    !value.version
  ) {
    throw buildError("base Manifest must provide name and version");
  }
  if ("content_scripts" in value) {
    throw buildError("base Manifest must not define content_scripts");
  }
  if (
    !Array.isArray(value.permissions) ||
    value.permissions.some((permission) => typeof permission !== "string")
  ) {
    throw buildError("base Manifest permissions must be a string array");
  }
  return { ...value };
}

export function composeManifest(
  baseManifest: ExtensionManifest,
  plugins: readonly Pick<ScannedSitePlugin, "descriptor">[],
  resources: ContentScriptResources,
): ExtensionManifest {
  const matches = plugins.flatMap(({ descriptor }) => descriptor.matches);
  if (matches.length === 0) {
    throw buildError("cannot compose content_scripts without plugin matches");
  }
  if (!resources.js || !resources.css) {
    throw buildError("content script JS and CSS resources are required");
  }

  return {
    ...baseManifest,
    content_scripts: [
      {
        matches,
        js: [resources.js],
        css: [resources.css],
        run_at: "document_idle",
      },
    ],
  };
}

export async function readBaseManifest(path: string): Promise<ExtensionManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw buildError(`${basename(path)} is not valid JSON: ${String(error)}`);
  }
  return parseBaseManifest(value);
}
