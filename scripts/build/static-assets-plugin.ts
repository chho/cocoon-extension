import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

import type { Plugin, Rollup } from "vite";

export interface StaticAsset {
  readonly sourcePath: string;
  readonly outputPath: string;
}

export interface StaticAssetsPluginOptions {
  readonly projectRoot: string;
  readonly assets: readonly StaticAsset[];
}

interface ResolvedStaticAsset extends StaticAsset {
  readonly absoluteSourcePath: string;
}

interface LoadedStaticAsset extends ResolvedStaticAsset {
  readonly source: Uint8Array;
}

function buildError(message: string, cause?: unknown): Error {
  return new Error(
    `[Cocoon static assets] ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function validatePortableRelativePath(path: string, label: string): void {
  const normalized = posix.normalize(path);
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    normalized !== path ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw buildError(`${label} must be a normalized, portable project-relative path: ${path}`);
  }
}

function pathWithinRoot(path: string, root: string): boolean {
  const pathRelativeToRoot = relative(root, path);
  return (
    pathRelativeToRoot.length > 0 &&
    pathRelativeToRoot !== ".." &&
    !pathRelativeToRoot.startsWith(`..${sep}`)
  );
}

function resolveAssets(options: StaticAssetsPluginOptions): readonly ResolvedStaticAsset[] {
  const projectRoot = resolve(options.projectRoot);
  const outputPaths = new Set<string>();

  return options.assets.map((asset, index) => {
    validatePortableRelativePath(asset.sourcePath, `assets[${index}].sourcePath`);
    validatePortableRelativePath(asset.outputPath, `assets[${index}].outputPath`);
    if (outputPaths.has(asset.outputPath)) {
      throw buildError(`duplicate output path: ${asset.outputPath}`);
    }
    outputPaths.add(asset.outputPath);

    const absoluteSourcePath = resolve(projectRoot, ...asset.sourcePath.split("/"));
    if (!pathWithinRoot(absoluteSourcePath, projectRoot)) {
      throw buildError(`source path escapes project root: ${asset.sourcePath}`);
    }
    return { ...asset, absoluteSourcePath };
  });
}

async function loadAsset(
  asset: ResolvedStaticAsset,
  projectRoot: string,
): Promise<LoadedStaticAsset> {
  try {
    const [stats, canonicalSourcePath, canonicalProjectRoot] = await Promise.all([
      lstat(asset.absoluteSourcePath),
      realpath(asset.absoluteSourcePath),
      realpath(projectRoot),
    ]);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw buildError(`source must be a regular file: ${asset.sourcePath}`);
    }
    const canonicalExpectedSourcePath = resolve(
      canonicalProjectRoot,
      ...asset.sourcePath.split("/"),
    );
    if (canonicalSourcePath !== canonicalExpectedSourcePath) {
      throw buildError(`source path must not contain symbolic links: ${asset.sourcePath}`);
    }
    if (!pathWithinRoot(canonicalSourcePath, canonicalProjectRoot)) {
      throw buildError(`source resolves outside project root: ${asset.sourcePath}`);
    }
    return {
      ...asset,
      source: await readFile(canonicalSourcePath),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[Cocoon static assets]")) {
      throw error;
    }
    throw buildError(`cannot read source file: ${asset.sourcePath}`, error);
  }
}

function assertOutputAvailable(bundle: Rollup.OutputBundle, outputPath: string): void {
  if (Object.hasOwn(bundle, outputPath)) {
    throw buildError(`output path conflicts with generated bundle entry: ${outputPath}`);
  }
}

export function createStaticAssetsPlugin(options: StaticAssetsPluginOptions): Plugin {
  const projectRoot = resolve(options.projectRoot);
  const assets = resolveAssets(options);
  let loadedAssets: readonly LoadedStaticAsset[] = [];

  return {
    name: "cocoon-static-assets",
    buildStart: {
      sequential: true,
      async handler() {
        for (const asset of assets) {
          this.addWatchFile(asset.absoluteSourcePath);
        }
        loadedAssets = await Promise.all(
          assets.map(async (asset) => await loadAsset(asset, projectRoot)),
        );
      },
    },
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        for (const asset of loadedAssets) {
          assertOutputAvailable(bundle, asset.outputPath);
        }
        for (const asset of loadedAssets) {
          this.emitFile({
            type: "asset",
            fileName: asset.outputPath,
            source: asset.source,
          });
        }
      },
    },
  };
}
