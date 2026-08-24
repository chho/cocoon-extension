import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { readBaseManifest } from "./plugin-manifest.ts";

const ICON_SIZES = [16, 32, 48, 128] as const;
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const projectRoot = resolve(import.meta.dirname, "../..");

function iconManifestEntries(): Readonly<Record<string, string>> {
  return Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]));
}

test("extension branding Manifest declares every generated icon for the extension and action", async () => {
  const manifest = await readBaseManifest(join(projectRoot, "public/manifest.json"));
  const expectedIcons = iconManifestEntries();
  deepStrictEqual(manifest.icons, expectedIcons);

  const action = manifest.action;
  strictEqual(typeof action, "object");
  strictEqual(action === null, false);
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    throw new Error("base Manifest action must be an object");
  }
  deepStrictEqual((action as Readonly<Record<string, unknown>>).default_icon, expectedIcons);
});

test("extension branding source assets are exact-size RGBA PNG files", async () => {
  for (const size of ICON_SIZES) {
    const icon = await readFile(join(projectRoot, `icons/icon-${size}.png`));
    strictEqual(icon.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true);
    strictEqual(icon.toString("ascii", 12, 16), "IHDR");
    strictEqual(icon.readUInt32BE(16), size);
    strictEqual(icon.readUInt32BE(20), size);
    strictEqual(icon[24], 8, `icon-${size}.png must use 8-bit channels`);
    strictEqual(icon[25], 6, `icon-${size}.png must use RGBA color type`);
  }
});
