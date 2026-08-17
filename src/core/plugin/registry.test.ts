import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { SitePluginDescriptor } from "./contract.ts";
import {
  createPluginRegistry,
  selectPluginForUrl,
} from "./registry.ts";

const capabilities = {
  cardFiltering: true,
  commentFiltering: true,
  hoverEntry: true,
  remoteAccountBlock: true,
  audienceVoterExpansion: true,
} as const;

function discoveredPlugin(
  descriptor: SitePluginDescriptor,
  runtimeDescriptor: SitePluginDescriptor = descriptor,
  mount: () => void = () => {},
) {
  return {
    descriptor: { directoryId: descriptor.id, descriptor },
    runtime: {
      directoryId: descriptor.id,
      plugin: { descriptor: runtimeDescriptor, capabilities, mount },
    },
  };
}

test("ARCH-001/002 registry selects exactly one valid plugin", () => {
  const zhihu = discoveredPlugin({
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
  });
  const result = createPluginRegistry([zhihu.descriptor], [zhihu.runtime]);
  strictEqual(result.valid, true);
  if (!result.valid) return;

  const selection = selectPluginForUrl(
    result.registry,
    new URL("https://www.zhihu.com/"),
  );
  strictEqual(selection.status, "selected");
  if (selection.status === "selected") {
    strictEqual(selection.plugin.descriptor.id, "zhihu");
  }
});

test("ARCH-002 zero URL matches fail closed", () => {
  const zhihu = discoveredPlugin({
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
  });
  const result = createPluginRegistry([zhihu.descriptor], [zhihu.runtime]);
  if (!result.valid) throw new Error("Expected a valid registry.");
  deepStrictEqual(
    selectPluginForUrl(result.registry, new URL("https://example.com/")),
    { status: "no-match" },
  );
});

test("ARCH-002 overlapping URL matches report every plugin and select none", () => {
  const broad = discoveredPlugin({
    id: "example-broad",
    matches: ["https://*.example.com/*"],
  });
  const narrow = discoveredPlugin({
    id: "example-narrow",
    matches: ["https://www.example.com/*"],
  });
  const result = createPluginRegistry(
    [broad.descriptor, narrow.descriptor],
    [broad.runtime, narrow.runtime],
  );
  if (!result.valid) throw new Error("Expected a valid overlapping registry.");
  deepStrictEqual(
    selectPluginForUrl(result.registry, new URL("https://www.example.com/feed")),
    {
      status: "multiple-matches",
      pluginIds: ["example-broad", "example-narrow"],
    },
  );
});

test("ARCH-004 duplicate plugin IDs invalidate the registry", () => {
  const first = discoveredPlugin({
    id: "duplicate",
    matches: ["https://first.example.com/*"],
  });
  const secondDescriptor = {
    id: "duplicate",
    matches: ["https://second.example.com/*"],
  } as const;
  const result = createPluginRegistry(
    [
      first.descriptor,
      { directoryId: "second", descriptor: secondDescriptor },
    ],
    [
      first.runtime,
      {
        directoryId: "second",
        plugin: { descriptor: secondDescriptor, capabilities, mount() {} },
      },
    ],
  );
  strictEqual(result.valid, false);
  if (result.valid) return;
  strictEqual(
    result.errors.some((error) => error === "duplicate plugin id: duplicate"),
    true,
  );
});

test("ARCH-004 descriptor/runtime mismatch and orphan modules invalidate the registry", () => {
  const mismatch = discoveredPlugin(
    { id: "zhihu", matches: ["https://www.zhihu.com/"] },
    { id: "zhihu", matches: ["https://www.zhihu.com/*"] },
  );
  const mismatchResult = createPluginRegistry(
    [mismatch.descriptor],
    [mismatch.runtime],
  );
  strictEqual(mismatchResult.valid, false);
  if (!mismatchResult.valid) {
    strictEqual(
      mismatchResult.errors.includes("zhihu descriptor/runtime metadata mismatch"),
      true,
    );
  }

  const orphanResult = createPluginRegistry([mismatch.descriptor], []);
  strictEqual(orphanResult.valid, false);
});

test("ARCH-006 capability declarations are strict and do not accept permission metadata", () => {
  const descriptor = {
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
  } as const;
  const result = createPluginRegistry(
    [{ directoryId: "zhihu", descriptor }],
    [{
      directoryId: "zhihu",
      plugin: {
        descriptor,
        capabilities: { ...capabilities, permissions: ["tabs"] },
        mount() {},
      },
    }],
  );
  strictEqual(result.valid, false);
});
