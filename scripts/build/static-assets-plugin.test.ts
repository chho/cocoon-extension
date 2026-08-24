import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { build, type InlineConfig, type Plugin, type Rollup } from "vite";

import { createStaticAssetsPlugin, type StaticAsset } from "./static-assets-plugin.ts";

interface BuildOutcome {
  readonly error: Error | null;
}

class WatchBuildQueue {
  readonly #completed: BuildOutcome[] = [];
  readonly #pending: Array<(outcome: BuildOutcome) => void> = [];
  #settled = false;

  constructor(watcher: Rollup.RollupWatcher) {
    watcher.on("event", (event) => {
      if (event.code === "START") {
        this.#settled = false;
      } else if (event.code === "ERROR" && !this.#settled) {
        this.#complete(new Error(event.error.message, { cause: event.error }));
      } else if (event.code === "END" && !this.#settled) {
        this.#complete(null);
      }
    });
  }

  async waitForSuccess(label: string): Promise<void> {
    const outcome = await Promise.race([
      this.#next(),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}`));
        }, 15_000);
        timeout.unref();
      }),
    ]);
    if (outcome.error) {
      throw outcome.error;
    }
  }

  #next(): Promise<BuildOutcome> {
    const outcome = this.#completed.shift();
    return outcome
      ? Promise.resolve(outcome)
      : new Promise((resolve) => {
          this.#pending.push(resolve);
        });
  }

  #complete(error: Error | null): void {
    this.#settled = true;
    const outcome = { error };
    const pending = this.#pending.shift();
    if (pending) {
      pending(outcome);
    } else {
      this.#completed.push(outcome);
    }
  }
}

function isRollupWatcher(
  result: Awaited<ReturnType<typeof build>>,
): result is Rollup.RollupWatcher {
  return !Array.isArray(result) && "on" in result && typeof result.on === "function";
}

async function createFixtureProject(): Promise<{
  readonly projectRoot: string;
  readonly entryPath: string;
  readonly outDir: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "cocoon-static-assets-"));
  const entryPath = join(projectRoot, "src/main.ts");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(entryPath, "globalThis.__STATIC_ASSET_FIXTURE__ = true;\n");
  return {
    projectRoot,
    entryPath,
    outDir: join(projectRoot, "dist"),
  };
}

function createBuildConfig(
  fixture: { readonly projectRoot: string; readonly entryPath: string; readonly outDir: string },
  assets: readonly StaticAsset[],
  watch = false,
  additionalPlugins: readonly Plugin[] = [],
): InlineConfig {
  return {
    configFile: false,
    root: fixture.projectRoot,
    publicDir: false,
    clearScreen: false,
    logLevel: "silent",
    plugins: [
      createStaticAssetsPlugin({ projectRoot: fixture.projectRoot, assets }),
      ...additionalPlugins,
    ],
    build: {
      outDir: fixture.outDir,
      emptyOutDir: true,
      ...(watch ? { watch: {} } : {}),
      rollupOptions: {
        input: fixture.entryPath,
        output: { entryFileNames: "assets/main.js" },
      },
    },
  };
}

const ICON_ASSET: StaticAsset = {
  sourcePath: "icons/icon-16.png",
  outputPath: "icons/icon-16.png",
};
const SYMLINK_UNAVAILABLE_CODES = new Set(["EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"]);

async function createSymlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type?: "dir" | "file",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    if (!SYMLINK_UNAVAILABLE_CODES.has(code)) {
      throw error;
    }
    context.skip(`symbolic links are unavailable on this platform or filesystem (${code})`);
    return false;
  }
}

test("static asset build emits exact bytes at a stable nested output path", async () => {
  const fixture = await createFixtureProject();
  try {
    const sourcePath = join(fixture.projectRoot, ICON_ASSET.sourcePath);
    const source = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await mkdir(join(fixture.projectRoot, "icons"));
    await writeFile(sourcePath, source);

    await build(createBuildConfig(fixture, [ICON_ASSET]));

    deepStrictEqual(await readFile(join(fixture.outDir, ICON_ASSET.outputPath)), source);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("static asset configuration rejects unsafe and duplicate output paths", () => {
  for (const outputPath of [
    "",
    "../icon.png",
    "/icons/icon.png",
    "icons\\icon.png",
    "icons//icon.png",
    "icons/./icon.png",
  ]) {
    throws(
      () =>
        createStaticAssetsPlugin({
          projectRoot: import.meta.dirname,
          assets: [{ sourcePath: "icon.png", outputPath }],
        }),
      /must be a normalized, portable project-relative path/,
    );
  }

  throws(
    () =>
      createStaticAssetsPlugin({
        projectRoot: import.meta.dirname,
        assets: [ICON_ASSET, { ...ICON_ASSET, sourcePath: "icons/other.png" }],
      }),
    /duplicate output path: icons\/icon-16\.png/,
  );
});

test("static asset build rejects an output emitted by a later plugin", async () => {
  const fixture = await createFixtureProject();
  try {
    await mkdir(join(fixture.projectRoot, "icons"));
    await writeFile(join(fixture.projectRoot, ICON_ASSET.sourcePath), "static-icon");
    const conflictingPlugin: Plugin = {
      name: "conflicting-static-output-fixture",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: ICON_ASSET.outputPath,
          source: "later-plugin-icon",
        });
      },
    };

    await rejects(
      build(createBuildConfig(fixture, [ICON_ASSET], false, [conflictingPlugin])),
      /output path conflicts with generated bundle entry: icons\/icon-16\.png/,
    );
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("static asset build rejects symlinked source files and parent directories", async (context) => {
  const fixture = await createFixtureProject();
  try {
    const directTargetPath = join(fixture.projectRoot, "direct-target.png");
    await mkdir(join(fixture.projectRoot, "icons"));
    await writeFile(directTargetPath, "direct-target");
    if (
      !(await createSymlinkOrSkip(
        context,
        directTargetPath,
        join(fixture.projectRoot, ICON_ASSET.sourcePath),
        "file",
      ))
    ) {
      return;
    }
    await rejects(
      build(createBuildConfig(fixture, [ICON_ASSET])),
      /source must be a regular file: icons\/icon-16\.png/,
    );

    await rm(join(fixture.projectRoot, "icons"), { recursive: true, force: true });
    const linkedDirectoryPath = join(fixture.projectRoot, "linked-icons");
    await mkdir(linkedDirectoryPath);
    await writeFile(join(linkedDirectoryPath, "icon-16.png"), "linked-parent");
    if (
      !(await createSymlinkOrSkip(
        context,
        linkedDirectoryPath,
        join(fixture.projectRoot, "icons"),
        "dir",
      ))
    ) {
      return;
    }
    await rejects(
      build(createBuildConfig(fixture, [ICON_ASSET])),
      /source path must not contain symbolic links: icons\/icon-16\.png/,
    );
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("static asset build fails closed for a missing source or generated output collision", async () => {
  const fixture = await createFixtureProject();
  try {
    await rejects(
      build(createBuildConfig(fixture, [ICON_ASSET])),
      /cannot read source file: icons\/icon-16\.png/,
    );

    await mkdir(join(fixture.projectRoot, "icons"));
    await writeFile(join(fixture.projectRoot, ICON_ASSET.sourcePath), "icon");
    await rejects(
      build(
        createBuildConfig(fixture, [
          { sourcePath: ICON_ASSET.sourcePath, outputPath: "assets/main.js" },
        ]),
      ),
      /output path conflicts with generated bundle entry: assets\/main\.js/,
    );
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("static asset watch rebuild emits changed source bytes", async () => {
  const fixture = await createFixtureProject();
  let watcher: Rollup.RollupWatcher | null = null;
  try {
    const sourcePath = join(fixture.projectRoot, ICON_ASSET.sourcePath);
    await mkdir(join(fixture.projectRoot, "icons"));
    await writeFile(sourcePath, "icon-v1");

    const result = await build(createBuildConfig(fixture, [ICON_ASSET], true));
    ok(isRollupWatcher(result), "watch build must return a Rollup watcher");
    watcher = result;
    const builds = new WatchBuildQueue(watcher);
    await builds.waitForSuccess("initial static asset build");
    strictEqual(await readFile(join(fixture.outDir, ICON_ASSET.outputPath), "utf8"), "icon-v1");

    const rebuild = builds.waitForSuccess("static asset change rebuild");
    await writeFile(sourcePath, "icon-v2");
    await rebuild;
    strictEqual(await readFile(join(fixture.outDir, ICON_ASSET.outputPath), "utf8"), "icon-v2");
  } finally {
    if (watcher) {
      await watcher.close();
    }
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
});
