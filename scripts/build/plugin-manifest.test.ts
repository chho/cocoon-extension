import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  composeManifest,
  parseBaseManifest,
  readBaseManifest,
  scanSitePlugins,
} from "./plugin-manifest.ts";

async function withPluginRoot(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cocoon-plugin-test-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePlugin(
  root: string,
  id: string,
  descriptor: unknown = { id, matches: [`https://${id}.example.com/*`] },
  options: { readonly entry?: boolean } = {},
): Promise<void> {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.json"), JSON.stringify(descriptor));
  if (options.entry !== false) {
    await writeFile(join(directory, "plugin.ts"), "export default {};\n");
  }
}

const SYMLINK_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

async function createSymlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type: "dir" | "file",
): Promise<boolean> {
  try {
    await symlink(target, path, type);
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

async function assertSymlinkRejected(
  root: string,
  relativePath: string,
): Promise<void> {
  await rejects(scanSitePlugins(root), (error: unknown) => {
    strictEqual(error instanceof Error, true);
    if (!(error instanceof Error)) {
      return false;
    }
    strictEqual(
      error.message,
      `[Cocoon plugin build] symbolic link is not allowed: ${relativePath}`,
    );
    return true;
  });
}

test("ARCH-004 scanner returns a strict descriptor and required local entry", async () => {
  await withPluginRoot(async (root) => {
    await writePlugin(root, "zhihu", {
      id: "zhihu",
      matches: ["https://www.zhihu.com/"],
    });
    const plugins = await scanSitePlugins(root);
    strictEqual(plugins.length, 1);
    deepStrictEqual(plugins[0]?.descriptor, {
      id: "zhihu",
      matches: ["https://www.zhihu.com/"],
    });
    strictEqual(plugins[0]?.entryPath.endsWith("/zhihu/plugin.ts"), true);
  });
});

test("ARCH-004 scanner rejects missing entries and malformed or extra descriptor keys", async () => {
  await withPluginRoot(async (root) => {
    await writePlugin(root, "missing-entry", undefined, { entry: false });
    await rejects(scanSitePlugins(root), /must contain both plugin\.json and plugin\.ts/);
  });

  for (const descriptor of [
    { id: "bad", matches: ["not-a-pattern"] },
    { id: "extra", matches: ["https://extra.example.com/*"], extra: true },
  ]) {
    await withPluginRoot(async (root) => {
      await writePlugin(root, String((descriptor as { id: string }).id), descriptor);
      await rejects(scanSitePlugins(root), /Cocoon plugin build/);
    });
  }
});

test("ARCH-004 scanner rejects descriptor-directory mismatches and duplicate match patterns", async () => {
  await withPluginRoot(async (root) => {
    await writePlugin(root, "directory", {
      id: "different",
      matches: ["https://different.example.com/*"],
    });
    await rejects(scanSitePlugins(root), /id must equal directory/);
  });

  await withPluginRoot(async (root) => {
    const duplicateMatch = "https://shared.example.com/*";
    await writePlugin(root, "first", { id: "first", matches: [duplicateMatch] });
    await writePlugin(root, "second", { id: "second", matches: [duplicateMatch] });
    await rejects(scanSitePlugins(root), /duplicate plugin match pattern/);
  });
});

test("ARCH-004 scanner never silently accepts nested or top-level orphan convention files", async () => {
  for (const orphanPath of ["plugin.ts", join("zhihu", "nested", "plugin.json")]) {
    await withPluginRoot(async (root) => {
      await writePlugin(root, "zhihu", {
        id: "zhihu",
        matches: ["https://www.zhihu.com/"],
      });
      const path = join(root, orphanPath);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, orphanPath.endsWith(".json") ? "{}" : "export {};\n");
      await rejects(scanSitePlugins(root), /orphan convention file/);
    });
  }
});

test("ARCH-001 scanner rejects a symlinked top-level plugin directory without following it", async (context) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "cocoon-plugin-external-"));
  try {
    await writePlugin(externalRoot, "linked", {
      id: "linked",
      matches: ["https://linked.example.com/*"],
    });
    await withPluginRoot(async (root) => {
      if (
        !await createSymlinkOrSkip(
          context,
          join(externalRoot, "linked"),
          join(root, "linked"),
          "dir",
        )
      ) {
        return;
      }
      await assertSymlinkRejected(root, "linked");
    });
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("ARCH-001 scanner rejects symlinked plugin.ts and plugin.json files", async (context) => {
  const externalRoot = await mkdtemp(join(tmpdir(), "cocoon-plugin-files-"));
  try {
    for (const fileName of ["plugin.ts", "plugin.json"] as const) {
      const externalPath = join(externalRoot, fileName);
      await writeFile(
        externalPath,
        fileName === "plugin.ts"
          ? "export default {};\n"
          : `${JSON.stringify({
            id: "safe",
            matches: ["https://safe.example.com/*"],
          })}\n`,
      );
      let symlinkCreated = false;
      await withPluginRoot(async (root) => {
        await writePlugin(root, "safe");
        const conventionPath = join(root, "safe", fileName);
        await rm(conventionPath);
        symlinkCreated = await createSymlinkOrSkip(
          context,
          externalPath,
          conventionPath,
          "file",
        );
        if (!symlinkCreated) {
          return;
        }
        await assertSymlinkRejected(root, join("safe", fileName));
      });
      if (!symlinkCreated) {
        return;
      }
    }
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test("ARCH-005 manifest composition generates exact stable content resources from descriptors", () => {
  const base = parseBaseManifest({
    manifest_version: 3,
    name: "Cocoon",
    version: "0.2.0",
    action: { default_popup: "popup/popup.html" },
    background: {
      service_worker: "assets/background.js",
      type: "module",
    },
    options_ui: {
      page: "options/options.html",
      open_in_tab: true,
    },
    permissions: ["storage"],
  });
  const manifest = composeManifest(
    base,
    [{ descriptor: { id: "zhihu", matches: ["https://www.zhihu.com/"] } }],
    { js: "assets/content.js", css: "assets/content.css" },
  );

  deepStrictEqual(manifest.content_scripts, [{
    matches: ["https://www.zhihu.com/"],
    js: ["assets/content.js"],
    css: ["assets/content.css"],
    run_at: "document_idle",
  }]);
  deepStrictEqual(manifest.permissions, ["storage"]);
  deepStrictEqual(manifest.options_ui, {
    page: "options/options.html",
    open_in_tab: true,
  });
  strictEqual("host_permissions" in manifest, false);
  strictEqual("content_scripts" in base, false);
});

test("MANAGE-004 actual source Manifest keeps Blob transfer free of downloads permission", async () => {
  const base = await readBaseManifest(join(
    import.meta.dirname,
    "../../public/manifest.json",
  ));
  const manifest = composeManifest(
    base,
    [{ descriptor: { id: "zhihu", matches: ["https://www.zhihu.com/"] } }],
    { js: "assets/content.js", css: "assets/content.css" },
  );

  deepStrictEqual(base.permissions, ["storage"]);
  deepStrictEqual(manifest.permissions, ["storage"]);
  strictEqual((manifest.permissions as readonly string[]).includes("downloads"), false);
  deepStrictEqual(manifest.options_ui, {
    page: "options/options.html",
    open_in_tab: true,
  });
});

test("BADGE-006 base Manifest requires the stable module Service Worker", () => {
  for (const background of [
    undefined,
    { service_worker: "assets/other.js", type: "module" },
    { service_worker: "assets/background.js" },
    {
      service_worker: "assets/background.js",
      type: "module",
      unexpected: true,
    },
  ]) {
    throws(
      () => parseBaseManifest({
        manifest_version: 3,
        name: "Cocoon",
        version: "0.2.0",
        background,
        permissions: ["storage"],
      }),
      /module service worker assets\/background\.js/,
    );
  }
});

test("MANAGE-001 base Manifest requires the exact tabbed options page contract", () => {
  for (const optionsUi of [
    undefined,
    { page: "options/options.html", open_in_tab: false },
    { page: "options/other.html", open_in_tab: true },
    { page: "options/options.html", open_in_tab: true, extra: true },
  ]) {
    throws(
      () => parseBaseManifest({
        manifest_version: 3,
        name: "Cocoon",
        version: "0.2.0",
        background: {
          service_worker: "assets/background.js",
          type: "module",
        },
        options_ui: optionsUi,
        permissions: ["storage"],
      }),
      /options_ui must be exactly options\/options\.html opened in a tab/,
    );
  }
});

test("ARCH-004 base Manifest rejects manually duplicated content_scripts", () => {
  throws(
    () => parseBaseManifest({
      manifest_version: 3,
      name: "Cocoon",
      version: "0.2.0",
      background: {
        service_worker: "assets/background.js",
        type: "module",
      },
      permissions: ["storage"],
      content_scripts: [],
    }),
    /must not define content_scripts/,
  );
});
