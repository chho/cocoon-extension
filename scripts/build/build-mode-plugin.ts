import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Plugin, Rollup } from "vite";

const DIAGNOSTIC_MARKERS = /__cocoonDevDiagnostics|cocoonDevDiagnostics|cocoon-dev-diagnostics/;

function outputDirectory(mode: string): string {
  if (mode === "production") return "dist";
  if (mode === "diagnostic") return "dist-dev";
  throw new Error(`[Cocoon build] unsupported build mode: ${mode}`);
}

function assertProductionBundle(bundle: Rollup.OutputBundle): void {
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk") {
      const leakedModule = Object.entries(output.modules).find(
        ([id, module]) =>
          module.renderedLength > 0 && id.replaceAll("\\", "/").includes("/src/diagnostics/"),
      );
      if (leakedModule) {
        throw new Error(
          `[Cocoon build] production diagnostic leak: rendered module ${leakedModule[0]}`,
        );
      }
    }
    const source = output.type === "chunk" ? output.code : output.source;
    const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
    if (DIAGNOSTIC_MARKERS.test(text)) {
      throw new Error(`[Cocoon build] production diagnostic leak: marker in ${output.fileName}`);
    }
  }
}

function brandDiagnosticManifest(bundle: Rollup.OutputBundle): void {
  const asset = bundle["manifest.json"];
  if (asset?.type !== "asset" || typeof asset.source !== "string") {
    throw new Error("[Cocoon build] missing generated Manifest for diagnostic branding");
  }
  const manifest = JSON.parse(asset.source) as Record<string, unknown>;
  manifest.name = "Cocoon Dev";
  manifest.version_name = `${String(manifest.version)} Dev`;
  manifest.action = { ...(manifest.action as object), default_title: "Cocoon Dev" };
  delete manifest.key;
  asset.source = `${JSON.stringify(manifest, null, 2)}\n`;
}

export function createBuildModePlugin(): Plugin {
  let mode = "production";
  return {
    name: "cocoon-build-mode",
    config(config, environment) {
      mode = environment.mode;
      const outDir = outputDirectory(mode);
      return { build: { outDir: config.build?.outDir ?? outDir } };
    },
    configResolved(config) {
      const expected = resolve(realpathSync(config.root), outputDirectory(mode));
      const outputPath = resolve(config.root, config.build.outDir);
      const actual = resolve(realpathSync(dirname(outputPath)), basename(outputPath));
      if (actual !== expected || lstatSync(actual, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`[Cocoon build] output directory must be ${expected} (not a symlink)`);
      }
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (mode === "diagnostic") brandDiagnosticManifest(bundle);
        else assertProductionBundle(bundle);
      },
    },
  };
}
