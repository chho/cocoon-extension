import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { PLATFORM_BLOCK_PREFERENCE_KEY } from "../core/platform-block-preference.ts";
import { bootstrapPlatformBlockSetting } from "./platform-block-setting.ts";

const html = await readFile(new URL("../../options/options.html", import.meta.url), "utf8");
const css = await readFile(new URL("./options.css", import.meta.url), "utf8");
const tooltipCopy =
  "不勾选：只在 Cocoon 中屏蔽这些人。勾选后：还会在他们所在的网站上拉黑他们，就像你在那个网站手动拉黑一样。只有支持此功能的网站插件才会执行。如果网站不支持或拉黑失败，Cocoon 仍会屏蔽他们。以后在 Cocoon 中取消屏蔽，还需要去对应网站单独解除拉黑。";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function setup(
  options: {
    initial?: unknown;
    get?: () => Promise<Record<string, unknown>>;
    set?: (items: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const controller = bootstrapPlatformBlockSetting({
    document,
    storage: {
      async get(key) {
        reads.push(key);
        return options.get ? options.get() : { [key]: options.initial };
      },
      async set(items) {
        writes.push(items);
        await options.set?.(items);
      },
    },
    setTimeout(callback, milliseconds) {
      strictEqual(milliseconds, 5000);
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const checkbox = document.querySelector<HTMLInputElement>("#block-voters-on-platform");
  const status = document.querySelector<HTMLElement>("#platform-block-status");
  const help = document.querySelector<HTMLButtonElement>("#platform-block-help");
  const tooltip = document.querySelector<HTMLElement>("#platform-block-tooltip");
  if (!checkbox || !status || !help || !tooltip) throw new Error("Setting controls missing");
  return {
    dom,
    document,
    checkbox,
    status,
    help,
    tooltip,
    writes,
    reads,
    timers,
    controller,
    toggle() {
      checkbox.click();
    },
    timeout() {
      for (const callback of [...timers.values()]) callback();
    },
    cleanup() {
      controller.destroy();
      dom.window.close();
    },
  };
}

test("UI-010 places the default-off option above list filters without a settings section or idle note", async () => {
  const ui = setup();
  try {
    strictEqual(ui.checkbox.disabled, true);
    await settle();
    strictEqual(ui.checkbox.checked, false);
    strictEqual(ui.checkbox.disabled, false);
    deepStrictEqual(ui.writes, []);
    deepStrictEqual(ui.reads, [PLATFORM_BLOCK_PREFERENCE_KEY]);
    deepStrictEqual(
      [...ui.document.querySelectorAll("main > section")].map((section) => section.className),
      ["authors-panel", "tags-panel", "transfer-panel"],
    );
    strictEqual(ui.document.querySelector("#settings-heading"), null);
    strictEqual(ui.checkbox.closest("section")?.className, "authors-panel");
    const row = ui.checkbox.closest(".platform-block-setting");
    strictEqual(row?.previousElementSibling?.className, "section-heading");
    strictEqual(ui.status.nextElementSibling?.className, "toolbar");
    strictEqual(ui.status.textContent, "");
    strictEqual(
      ui.checkbox.labels?.[0]?.textContent?.trim(),
      "批量拉黑点赞者时，同时在对应平台拉黑",
    );
  } finally {
    ui.cleanup();
  }
});

test("UI-010 shrinks the visible help icon while retaining a 24px hit target and hides empty status", () => {
  const button = css.match(/\.setting-help-button\s*\{([^}]+)\}/)?.[1] ?? "";
  match(button, /width: 24px/);
  match(button, /height: 24px/);
  match(button, /font-size: 10px/);
  match(button, /border: 0/);
  match(css, /\.setting-help-button::before\s*\{[^}]*inset: 5px/);
  match(css, /\.setting-status:empty\s*\{\s*display: none/);
});

test("VOTER-015 saves complete independent objects, restores saved state, and can turn off", async () => {
  const pending = deferred<void>();
  const ui = setup({ set: () => pending.promise });
  try {
    await settle();
    ui.toggle();
    strictEqual(ui.checkbox.disabled, true);
    ui.toggle();
    strictEqual(ui.writes.length, 1);
    deepStrictEqual(ui.writes[0], {
      [PLATFORM_BLOCK_PREFERENCE_KEY]: { version: 1, blockVotersOnPlatform: true },
    });
    pending.resolve();
    await settle();
    strictEqual(ui.checkbox.checked, true);
    strictEqual(ui.checkbox.disabled, false);
    strictEqual(ui.status.textContent, "");
    ui.toggle();
    await settle();
    deepStrictEqual(ui.writes[1], {
      [PLATFORM_BLOCK_PREFERENCE_KEY]: { version: 1, blockVotersOnPlatform: false },
    });
  } finally {
    ui.cleanup();
  }
  const restored = setup({ initial: { version: 1, blockVotersOnPlatform: true } });
  try {
    await settle();
    strictEqual(restored.checkbox.checked, true);
  } finally {
    restored.cleanup();
  }
});

test("VOTER-015 write failure restores the persisted value and allows retry", async () => {
  const ui = setup({
    initial: { version: 1, blockVotersOnPlatform: true },
    set: async () => {
      throw new Error("failed");
    },
  });
  try {
    await settle();
    ui.toggle();
    await settle();
    strictEqual(ui.checkbox.checked, true);
    strictEqual(ui.checkbox.disabled, false);
    match(ui.status.textContent ?? "", /未保存/);
    strictEqual(ui.timers.size, 0);
  } finally {
    ui.cleanup();
  }
});

test("VOTER-015 read failure stays off without writing or enabling an unknown setting", async () => {
  const ui = setup({
    get: async () => {
      throw new Error("failed");
    },
  });
  try {
    await settle();
    strictEqual(ui.checkbox.checked, false);
    strictEqual(ui.checkbox.disabled, true);
    match(ui.status.textContent ?? "", /无法读取/);
    deepStrictEqual(ui.writes, []);
    strictEqual(ui.timers.size, 0);
  } finally {
    ui.cleanup();
  }
});

test("VOTER-015 pending reads and writes are bounded; late results never claim success", async () => {
  const read = deferred<Record<string, unknown>>();
  const loading = setup({ get: () => read.promise });
  try {
    loading.timeout();
    await settle();
    match(loading.status.textContent ?? "", /无法读取/);
    read.resolve({ [PLATFORM_BLOCK_PREFERENCE_KEY]: { version: 1, blockVotersOnPlatform: true } });
    await settle();
    strictEqual(loading.checkbox.checked, false);
    strictEqual(loading.checkbox.disabled, true);
  } finally {
    loading.cleanup();
  }
  const write = deferred<void>();
  const saving = setup({ set: () => write.promise });
  try {
    await settle();
    saving.toggle();
    saving.timeout();
    await settle();
    strictEqual(saving.checkbox.checked, false);
    strictEqual(saving.checkbox.disabled, true);
    match(saving.status.textContent ?? "", /未确认/);
    write.resolve();
    await settle();
    match(saving.status.textContent ?? "", /未确认/);
    strictEqual(saving.timers.size, 0);
  } finally {
    saving.cleanup();
  }
});

test("VOTER-015 tooltip supports hover, keyboard focus and Escape without changing preference", async () => {
  const ui = setup();
  try {
    await settle();
    strictEqual(ui.tooltip.textContent?.replace(/\s+/g, " ").trim(), tooltipCopy);
    strictEqual(ui.tooltip.getAttribute("role"), "tooltip");
    strictEqual(ui.help.getAttribute("aria-describedby"), ui.tooltip.id);
    strictEqual(ui.tooltip.hidden, true);
    ui.help.focus();
    strictEqual(ui.tooltip.hidden, false);
    ui.help.dispatchEvent(
      new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    strictEqual(ui.tooltip.hidden, true);
    strictEqual(ui.document.activeElement, ui.help);
    ui.help.blur();
    ui.help.parentElement?.dispatchEvent(new ui.dom.window.MouseEvent("mouseenter"));
    strictEqual(ui.tooltip.hidden, false);
    ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    strictEqual(ui.tooltip.hidden, true);
    ui.help.parentElement?.dispatchEvent(new ui.dom.window.MouseEvent("mouseleave"));
    ui.help.focus();
    strictEqual(ui.tooltip.hidden, false);
    ui.help.blur();
    strictEqual(ui.tooltip.hidden, true);
    deepStrictEqual(ui.writes, []);
  } finally {
    ui.cleanup();
  }
});

test("VOTER-015 teardown removes listeners and timers and ignores pending completion", async () => {
  const pending = deferred<void>();
  const ui = setup({ set: () => pending.promise });
  try {
    await settle();
    ui.toggle();
    ui.help.focus();
    ui.controller.destroy();
    strictEqual(ui.timers.size, 0);
    strictEqual(ui.tooltip.hidden, true);
    const message = ui.status.textContent;
    pending.resolve();
    await settle();
    strictEqual(ui.status.textContent, message);
    ui.help.blur();
    ui.help.focus();
    strictEqual(ui.tooltip.hidden, true);
    strictEqual(ui.writes.length, 1);
  } finally {
    ui.cleanup();
  }
});
