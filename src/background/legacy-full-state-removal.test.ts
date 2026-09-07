import { match, strictEqual } from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { indexedDB } from "fake-indexeddb";

import { createBlacklistRepository } from "./blacklist-repository.ts";

class MemoryStorage {
  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: undefined };
  }

  async set(): Promise<void> {}

  async remove(): Promise<void> {}
}

async function productionTypeScriptFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      files.push(...(await productionTypeScriptFiles(url)));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test-support.ts")
    ) {
      files.push(url);
    }
  }
  return files;
}

test("BUG-016 production source contains no removed full-state operations or modules", async () => {
  const sourceRoot = new URL("../", import.meta.url);
  const removedOperation = /["'](?:snapshot|export-json|import-merge|import-replace|hydrate)["']/;
  for (const file of await productionTypeScriptFiles(sourceRoot)) {
    const source = await readFile(file, "utf8");
    strictEqual(
      removedOperation.test(source),
      false,
      `removed operation remains in ${fileURLToPath(file)}`,
    );
  }

  for (const modulePath of [
    "../ui/blacklist-snapshot-loader.ts",
    "../ui/committed-snapshot-controller.ts",
  ]) {
    strictEqual(existsSync(new URL(modulePath, import.meta.url)), false, modulePath);
  }
});

test("BUG-016 repository exposes no full-state read or replacement API", async () => {
  const repository = createBlacklistRepository({
    indexedDB,
    databaseName: `cocoon-no-full-state-${crypto.randomUUID()}`,
    storage: new MemoryStorage(),
  });
  strictEqual("hydrate" in repository, false);
  strictEqual("replaceAll" in repository, false);

  const contract = await readFile(
    new URL("./blacklist-repository-types.ts", import.meta.url),
    "utf8",
  );
  match(contract, /export interface BlacklistRepository/);
  strictEqual(/\bhydrate\s*\(/.test(contract), false);
  strictEqual(/\breplaceAll\s*\(/.test(contract), false);
});
