import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createSitePluginBootstrap } from "./bootstrap.ts";
import { createPluginRegistry } from "./registry.ts";

const badgeReporter = {
  recordFirstHidden() {},
};

const capabilities = {
  cardFiltering: true,
  commentFiltering: true,
  hoverEntry: true,
  remoteAccountBlock: true,
  audienceVoterExpansion: true,
  interceptionBadge: true,
} as const;

function validRegistry(
  entries: readonly {
    readonly id: string;
    readonly matches: readonly string[];
    readonly mount: () => void | Promise<void>;
  }[],
) {
  return createPluginRegistry(
    entries.map(({ id, matches }) => ({
      directoryId: id,
      descriptor: { id, matches },
    })),
    entries.map(({ id, matches, mount }) => ({
      directoryId: id,
      plugin: {
        descriptor: { id, matches },
        capabilities,
        mount,
      },
    })),
  );
}

test("ARCH-002 bootstrap mounts the selected plugin exactly once across repeated starts", async () => {
  let mounts = 0;
  const bootstrap = createSitePluginBootstrap(validRegistry([{
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
    mount() {
      mounts += 1;
    },
  }]));
  const context = {
    url: new URL("https://www.zhihu.com/"),
    badgeReporter,
  };

  const first = bootstrap.start(context);
  const second = bootstrap.start(context);
  strictEqual(first, second);
  deepStrictEqual(await Promise.all([first, second]), [
    { status: "mounted", pluginId: "zhihu" },
    { status: "mounted", pluginId: "zhihu" },
  ]);
  strictEqual(mounts, 1);
});

test("ARCH-002 zero and multiple matches mount nothing", async () => {
  let mounts = 0;
  const noMatch = createSitePluginBootstrap(validRegistry([{
    id: "zhihu",
    matches: ["https://www.zhihu.com/"],
    mount() {
      mounts += 1;
    },
  }]));
  deepStrictEqual(
    await noMatch.start({
      url: new URL("https://example.com/"),
      badgeReporter,
    }),
    { status: "no-match" },
  );

  const multiple = createSitePluginBootstrap(validRegistry([
    {
      id: "broad",
      matches: ["https://*.example.com/*"],
      mount() {
        mounts += 1;
      },
    },
    {
      id: "narrow",
      matches: ["https://www.example.com/*"],
      mount() {
        mounts += 1;
      },
    },
  ]));
  deepStrictEqual(
    await multiple.start({
      url: new URL("https://www.example.com/"),
      badgeReporter,
    }),
    { status: "multiple-matches", pluginIds: ["broad", "narrow"] },
  );
  strictEqual(mounts, 0);
});

test("ARCH-002 invalid registries fail closed before any runtime can mount", async () => {
  let mounts = 0;
  const registry = createPluginRegistry(
    [
      {
        directoryId: "first",
        descriptor: { id: "shared", matches: ["https://first.example.com/*"] },
      },
      {
        directoryId: "second",
        descriptor: { id: "shared", matches: ["https://second.example.com/*"] },
      },
    ],
    [
      {
        directoryId: "first",
        plugin: {
          descriptor: { id: "shared", matches: ["https://first.example.com/*"] },
          capabilities,
          mount() {
            mounts += 1;
          },
        },
      },
      {
        directoryId: "second",
        plugin: {
          descriptor: { id: "shared", matches: ["https://second.example.com/*"] },
          capabilities,
          mount() {
            mounts += 1;
          },
        },
      },
    ],
  );
  const result = await createSitePluginBootstrap(registry).start({
    url: new URL("https://first.example.com/"),
    badgeReporter,
  });
  strictEqual(result.status, "invalid-registry");
  strictEqual(mounts, 0);
});
