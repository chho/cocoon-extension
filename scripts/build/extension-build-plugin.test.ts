import { deepStrictEqual, match, ok, rejects } from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";

import { build, type InlineConfig, type Rollup } from "vite";

import { createExtensionBuildPlugin } from "./extension-build-plugin.ts";

interface FixtureRuntimeState {
  readonly descriptorMatches: readonly string[];
  readonly runtimeMatches: readonly string[];
  readonly markers: readonly string[];
}

interface PendingBuild {
  readonly resolve: (outcome: BuildOutcome) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface BuildOutcome {
  readonly error: Error | null;
}

interface FixtureProjectPaths {
  readonly projectRoot: string;
  readonly pluginsRoot: string;
  readonly discoveryPath: string;
  readonly contentEntryPath: string;
  readonly baseManifestPath: string;
  readonly outDir: string;
}

interface BuildOutputSnapshot {
  readonly manifest: string;
  readonly contentJavaScript: string;
  readonly contentCss: string;
}

class WatchBuildQueue {
  readonly #pending: PendingBuild[] = [];
  readonly #completed: BuildOutcome[] = [];
  #currentBuildSettled = false;

  constructor(watcher: Rollup.RollupWatcher) {
    watcher.on("event", (event) => {
      this.#handleEvent(event);
    });
  }

  async waitForSuccessfulBuild(label: string): Promise<void> {
    const outcome = await this.waitForBuildOutcome(label);
    if (outcome.error) {
      throw outcome.error;
    }
  }

  async waitForFailedBuild(label: string): Promise<Error> {
    const outcome = await this.waitForBuildOutcome(label);
    if (!outcome.error) {
      throw new Error(`Expected ${label} to fail, but it succeeded`);
    }
    return outcome.error;
  }

  waitForBuildOutcome(
    label: string,
    timeoutMs = 15_000,
  ): Promise<BuildOutcome> {
    const completed = this.#completed.shift();
    if (completed) {
      return Promise.resolve(completed);
    }

    return new Promise((resolve, reject) => {
      const pending: PendingBuild = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.#pending.indexOf(pending);
          if (index !== -1) {
            this.#pending.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.#pending.push(pending);
    });
  }

  cancel(): void {
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Watch build queue closed"));
    }
  }

  #complete(error: Error | null): void {
    const outcome = { error };
    const pending = this.#pending.shift();
    if (!pending) {
      this.#completed.push(outcome);
      return;
    }
    clearTimeout(pending.timeout);
    pending.resolve(outcome);
  }

  #handleEvent(event: Rollup.RollupWatcherEvent): void {
    if (event.code === "START") {
      this.#currentBuildSettled = false;
      return;
    }
    if (event.code === "ERROR") {
      if (!this.#currentBuildSettled) {
        this.#complete(new Error(event.error.message, { cause: event.error }));
        this.#currentBuildSettled = true;
      }
      return;
    }
    if (event.code === "END" && !this.#currentBuildSettled) {
      this.#complete(null);
      this.#currentBuildSettled = true;
    }
  }
}

function isRollupWatcher(
  result: Awaited<ReturnType<typeof build>>,
): result is Rollup.RollupWatcher {
  return !Array.isArray(result) &&
    "on" in result &&
    typeof result.on === "function";
}

function parseFixtureState(value: unknown): FixtureRuntimeState {
  if (typeof value !== "object" || value === null) {
    throw new Error("Fixture content bundle did not expose runtime state");
  }
  const state = value as Record<string, unknown>;
  for (const key of ["descriptorMatches", "runtimeMatches", "markers"] as const) {
    if (
      !Array.isArray(state[key]) ||
      state[key].some((item) => typeof item !== "string")
    ) {
      throw new Error(`Fixture runtime state has invalid ${key}`);
    }
  }
  return {
    descriptorMatches: state.descriptorMatches as string[],
    runtimeMatches: state.runtimeMatches as string[],
    markers: state.markers as string[],
  };
}

async function writeFixturePlugin(
  directory: string,
  id: string,
  match: string,
  marker: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "plugin.json"),
    `${JSON.stringify({ id, matches: [match] })}\n`,
  );
  await writeFile(
    join(directory, "plugin.ts"),
    `import descriptor from "./plugin.json";\n` +
      `import "./plugin.css";\n` +
      `export default { descriptor, marker: ${JSON.stringify(marker)} };\n`,
  );
  await writeFile(join(directory, "plugin.css"), `.${id} { color: black; }\n`);
}

async function writeFixtureProject(
  projectRoot: string,
): Promise<FixtureProjectPaths> {
  const pluginsRoot = join(projectRoot, "src/plugins");
  const discoveryPath = join(projectRoot, "src/core/plugin/discovery.ts");
  const contentEntryPath = join(projectRoot, "src/content/main.ts");
  const baseManifestPath = join(projectRoot, "public/manifest.json");
  const outDir = join(projectRoot, "dist");

  await mkdir(join(projectRoot, "src/core/plugin"), { recursive: true });
  await mkdir(join(projectRoot, "src/content"), { recursive: true });
  await mkdir(join(projectRoot, "public"), { recursive: true });
  await writeFile(
    baseManifestPath,
    `${JSON.stringify({
      manifest_version: 3,
      name: "Cocoon build fixture",
      version: "0.2.0",
      permissions: ["storage"],
    })}\n`,
  );
  await writeFile(
    discoveryPath,
    `interface DescriptorModule { default: { id: string; matches: string[] } }\n` +
      `interface RuntimeModule { default: { descriptor: { matches: string[] }; marker: string } }\n` +
      `const descriptorModules = import.meta.glob<DescriptorModule>("../../plugins/*/plugin.json", { eager: true });\n` +
      `const pluginModules = import.meta.glob<RuntimeModule>("../../plugins/*/plugin.ts", { eager: true });\n` +
      `export const runtimeDescriptors = Object.values(descriptorModules).map((module) => module.default);\n` +
      `export const runtimePlugins = Object.values(pluginModules).map((module) => module.default);\n`,
  );
  await writeFile(
    contentEntryPath,
    `import { runtimeDescriptors, runtimePlugins } from "../core/plugin/discovery.ts";\n` +
      `const target = globalThis as typeof globalThis & { __COCOON_WATCH_FIXTURE__?: unknown };\n` +
      `target.__COCOON_WATCH_FIXTURE__ = {\n` +
      `  descriptorMatches: runtimeDescriptors.flatMap(({ matches }) => matches),\n` +
      `  runtimeMatches: runtimePlugins.flatMap(({ descriptor }) => descriptor.matches),\n` +
      `  markers: runtimePlugins.map(({ marker }) => marker),\n` +
      `};\n`,
  );

  return {
    projectRoot,
    pluginsRoot,
    discoveryPath,
    contentEntryPath,
    baseManifestPath,
    outDir,
  };
}

function createFixtureBuildConfig(
  fixture: FixtureProjectPaths,
  watch: boolean,
): InlineConfig {
  return {
    configFile: false,
    root: fixture.projectRoot,
    publicDir: false,
    clearScreen: false,
    logLevel: "silent",
    plugins: [
      createExtensionBuildPlugin({
        projectRoot: fixture.projectRoot,
        pluginsRoot: fixture.pluginsRoot,
        baseManifestPath: fixture.baseManifestPath,
        discoveryModulePath: fixture.discoveryPath,
      }),
    ],
    build: {
      outDir: fixture.outDir,
      emptyOutDir: true,
      minify: false,
      ...(watch ? { watch: {} } : {}),
      rollupOptions: {
        input: { content: fixture.contentEntryPath },
        output: {
          entryFileNames: "assets/[name].js",
          chunkFileNames: "assets/[name].js",
          assetFileNames: "assets/[name][extname]",
        },
      },
    },
  };
}

const SYMLINK_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

async function createDirectorySymlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unknown";
    if (!SYMLINK_UNAVAILABLE_CODES.has(code)) {
      throw error;
    }
    context.skip(
      `symbolic links are unavailable on this platform or filesystem (${code})`,
    );
    return false;
  }
}

async function readBuildOutputSnapshot(
  outDir: string,
): Promise<BuildOutputSnapshot> {
  return {
    manifest: await readFile(join(outDir, "manifest.json"), "utf8"),
    contentJavaScript: await readFile(
      join(outDir, "assets/content.js"),
      "utf8",
    ),
    contentCss: await readFile(join(outDir, "assets/content.css"), "utf8"),
  };
}

async function readBuiltState(
  outDir: string,
): Promise<{
  readonly manifestMatches: readonly string[];
  readonly runtime: FixtureRuntimeState;
}> {
  const manifestValue = JSON.parse(
    await readFile(join(outDir, "manifest.json"), "utf8"),
  ) as unknown;
  if (typeof manifestValue !== "object" || manifestValue === null) {
    throw new Error("Fixture Manifest is not an object");
  }
  const contentScripts = (manifestValue as Record<string, unknown>)
    .content_scripts;
  if (!Array.isArray(contentScripts) || contentScripts.length !== 1) {
    throw new Error("Fixture Manifest has invalid content_scripts");
  }
  const contentScript = contentScripts[0];
  if (typeof contentScript !== "object" || contentScript === null) {
    throw new Error("Fixture Manifest content script is invalid");
  }
  const matches = (contentScript as Record<string, unknown>).matches;
  if (
    !Array.isArray(matches) ||
    matches.some((match) => typeof match !== "string")
  ) {
    throw new Error("Fixture Manifest matches are invalid");
  }

  const sandbox: Record<string, unknown> = {};
  runInNewContext(
    await readFile(join(outDir, "assets/content.js"), "utf8"),
    sandbox,
  );
  return {
    manifestMatches: matches as string[],
    runtime: parseFixtureState(sandbox.__COCOON_WATCH_FIXTURE__),
  };
}

async function assertBuildState(
  outDir: string,
  expectedMatches: readonly string[],
  expectedMarkers: readonly string[],
): Promise<void> {
  const built = await readBuiltState(outDir);
  deepStrictEqual([...built.manifestMatches].sort(), [...expectedMatches].sort());
  deepStrictEqual(
    [...built.runtime.descriptorMatches].sort(),
    [...expectedMatches].sort(),
  );
  deepStrictEqual(
    [...built.runtime.runtimeMatches].sort(),
    [...expectedMatches].sort(),
  );
  deepStrictEqual([...built.runtime.markers].sort(), [...expectedMarkers].sort());
}

async function waitForBuildState(
  builds: WatchBuildQueue,
  outDir: string,
  expectedMatches: readonly string[],
  expectedMarkers: readonly string[],
  label: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const outcome = await builds.waitForBuildOutcome(
      label,
      Math.max(1, deadline - Date.now()),
    );
    if (outcome.error) {
      lastError = outcome.error;
      continue;
    }
    try {
      await assertBuildState(outDir, expectedMatches, expectedMarkers);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(`Timed out waiting for ${label} to reach the expected state`, {
    cause: lastError,
  });
}

test("ARCH-001 clean Vite build rejects a symlinked plugin before Manifest emission", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cocoon-build-symlink-"));
  try {
    const fixture = await writeFixtureProject(projectRoot);
    const linkedPluginPath = join(fixture.pluginsRoot, "linked");
    const externalPluginPath = join(projectRoot, "external-linked-plugin");
    await mkdir(fixture.pluginsRoot, { recursive: true });
    await writeFixturePlugin(
      externalPluginPath,
      "linked",
      "https://linked.example.com/*",
      "external-linked-runtime",
    );
    if (
      !await createDirectorySymlinkOrSkip(
        context,
        externalPluginPath,
        linkedPluginPath,
      )
    ) {
      return;
    }

    await rejects(
      build(createFixtureBuildConfig(fixture, false)),
      /\[Cocoon plugin build\] symbolic link is not allowed: linked/,
    );
    await rejects(
      readFile(join(fixture.outDir, "manifest.json"), "utf8"),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ARCH-001/004 build watch keeps eager runtime discovery and Manifest scope in sync", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cocoon-build-watch-"));
  const alphaMatch = "https://alpha.example.com/*";
  const betaMatch = "https://beta.example.com/*";
  const changedBetaMatch = "https://changed-beta.example.com/*";
  let watcher: Rollup.RollupWatcher | null = null;
  let builds: WatchBuildQueue | null = null;

  try {
    const fixture = await writeFixtureProject(projectRoot);
    const { outDir, pluginsRoot } = fixture;
    await writeFixturePlugin(
      join(pluginsRoot, "alpha"),
      "alpha",
      alphaMatch,
      "alpha-runtime-v1",
    );

    const result = await build(createFixtureBuildConfig(fixture, true));
    ok(isRollupWatcher(result), "Vite watch build must return a Rollup watcher");
    watcher = result;
    builds = new WatchBuildQueue(watcher);

    await builds.waitForSuccessfulBuild("initial fixture build");
    await assertBuildState(outDir, [alphaMatch], ["alpha-runtime-v1"]);

    const stagedBetaPath = join(projectRoot, "staged-beta");
    await writeFixturePlugin(
      stagedBetaPath,
      "beta",
      betaMatch,
      "beta-runtime-v1",
    );
    const addedBuild = builds.waitForSuccessfulBuild("plugin addition rebuild");
    await rename(stagedBetaPath, join(pluginsRoot, "beta"));
    await addedBuild;
    await assertBuildState(
      outDir,
      [alphaMatch, betaMatch],
      ["alpha-runtime-v1", "beta-runtime-v1"],
    );

    const stagedDescriptorPath = join(projectRoot, "staged-plugin.json");
    await writeFile(
      stagedDescriptorPath,
      `${JSON.stringify({ id: "beta", matches: [changedBetaMatch] })}\n`,
    );
    const changedBuild = builds.waitForSuccessfulBuild(
      "descriptor match rebuild",
    );
    await rename(
      stagedDescriptorPath,
      join(pluginsRoot, "beta/plugin.json"),
    );
    await changedBuild;
    await assertBuildState(
      outDir,
      [alphaMatch, changedBetaMatch],
      ["alpha-runtime-v1", "beta-runtime-v1"],
    );

    const removedBetaPath = join(projectRoot, "removed-beta");
    const removedBuild = builds.waitForSuccessfulBuild("plugin removal rebuild");
    await rename(join(pluginsRoot, "beta"), removedBetaPath);
    await removedBuild;
    await assertBuildState(outDir, [alphaMatch], ["alpha-runtime-v1"]);
  } finally {
    builds?.cancel();
    if (watcher) {
      await watcher.close();
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("ARCH-001/004 Vite watch rejects a symlinked plugin and recovers atomically", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cocoon-watch-symlink-"));
  const alphaMatch = "https://alpha.example.com/*";
  const linkedMatch = "https://linked.example.com/*";
  let watcher: Rollup.RollupWatcher | null = null;
  let builds: WatchBuildQueue | null = null;

  try {
    const fixture = await writeFixtureProject(projectRoot);
    await writeFixturePlugin(
      join(fixture.pluginsRoot, "alpha"),
      "alpha",
      alphaMatch,
      "alpha-runtime-v1",
    );
    const externalPluginPath = join(projectRoot, "external-linked-plugin");
    await writeFixturePlugin(
      externalPluginPath,
      "linked",
      linkedMatch,
      "linked-runtime-v1",
    );

    const result = await build(createFixtureBuildConfig(fixture, true));
    ok(isRollupWatcher(result), "Vite watch build must return a Rollup watcher");
    watcher = result;
    builds = new WatchBuildQueue(watcher);

    await builds.waitForSuccessfulBuild("initial symlink recovery fixture build");
    await assertBuildState(
      fixture.outDir,
      [alphaMatch],
      ["alpha-runtime-v1"],
    );
    const successfulOutput = await readBuildOutputSnapshot(fixture.outDir);

    const linkedPluginPath = join(fixture.pluginsRoot, "linked");
    if (
      !await createDirectorySymlinkOrSkip(
        context,
        externalPluginPath,
        linkedPluginPath,
      )
    ) {
      return;
    }
    const buildError = await builds.waitForFailedBuild(
      "symlink rejection rebuild",
    );
    match(
      buildError.message,
      /\[Cocoon plugin build\] symbolic link is not allowed: linked/,
    );
    deepStrictEqual(
      await readBuildOutputSnapshot(fixture.outDir),
      successfulOutput,
      "failed rebuild must leave the previous Manifest and assets unchanged",
    );

    await rm(linkedPluginPath);
    await rename(externalPluginPath, linkedPluginPath);
    await waitForBuildState(
      builds,
      fixture.outDir,
      [alphaMatch, linkedMatch],
      ["alpha-runtime-v1", "linked-runtime-v1"],
      "normal plugin recovery rebuild",
    );
  } finally {
    builds?.cancel();
    if (watcher) {
      await watcher.close();
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});
