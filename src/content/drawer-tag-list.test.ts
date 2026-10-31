import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createDrawerTagList, type TagOrderEnvironment } from "./drawer-tag-list.ts";
import type { CocoonTag } from "./blacklist-state.ts";

const tags: CocoonTag[] = [
  { tagId: "default", name: "default" },
  { tagId: "a", name: "A" },
  { tagId: "b", name: "B" },
];
const preferences = (tagIds: string[]) => ({ schemaVersion: 1 as const, tagIds });
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function setup(environment: TagOrderEnvironment) {
  const dom = new JSDOM(
    '<body><aside class="cocoon-tag-drawer" data-phase="open"><div id="tags"></div></aside></body>',
  );
  const container = dom.window.document.getElementById("tags")!;
  let selected = 0,
    deleted = 0;
  const view = createDrawerTagList(
    container,
    {
      getTags: () => tags,
      getStatus: () => "open",
      selectTag() {
        selected++;
      },
      deleteTag() {
        deleted++;
      },
    },
    environment,
  );
  const ids = () =>
    [...container.querySelectorAll<HTMLElement>(".cocoon-tag-item")].map(
      (item) => item.dataset.tagId,
    );
  function moveA(key = "ArrowRight") {
    const button = [...container.querySelectorAll<HTMLElement>(".cocoon-tag-choice")].find(
      (b) => b.textContent === "A",
    )!;
    button.focus();
    button.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return {
    dom,
    container,
    view,
    ids,
    moveA,
    actions: () => ({ selected, deleted }),
    close() {
      view.destroy();
      dom.window.close();
    },
  };
}

test("TAG-019 keyboard reorder saves and a fresh drawer restores it without selecting/deleting", async () => {
  let stored: unknown;
  const environment: TagOrderEnvironment = {
    read: async () => stored,
    save: async (tagIds) => {
      stored = preferences([...tagIds]);
      return preferences([...tagIds]);
    },
    subscribe: () => () => {},
    scheduleDeadline: () => () => {},
  };
  const first = setup(environment);
  try {
    await settle();
    deepStrictEqual(first.ids(), ["default", "a", "b"]);
    first.moveA();
    await settle();
    deepStrictEqual(first.ids(), ["default", "b", "a"]);
    deepStrictEqual(first.actions(), { selected: 0, deleted: 0 });
    strictEqual(first.dom.window.document.activeElement?.textContent, "A");
  } finally {
    first.close();
  }
  const second = setup(environment);
  try {
    await settle();
    deepStrictEqual(second.ids(), ["default", "b", "a"]);
  } finally {
    second.close();
  }
});

test("TAG-019 failures and timeout restore persisted order; later storage notification is authoritative", async () => {
  let notify: (value: unknown) => void = () => {};
  const deadlines = new Set<() => void>();
  let fail = true;
  const h = setup({
    read: async () => preferences(["a", "b"]),
    save: async () => {
      if (fail) throw new Error("unavailable");
      return new Promise(() => {});
    },
    subscribe: (callback) => {
      notify = callback;
      return () => {
        notify = () => {};
      };
    },
    scheduleDeadline: (callback) => {
      deadlines.add(callback);
      return () => {
        deadlines.delete(callback);
      };
    },
  });
  try {
    await settle();
    h.moveA();
    await settle();
    deepStrictEqual(h.ids(), ["default", "a", "b"]);
    strictEqual(h.dom.window.document.querySelector(".cocoon-tag-order-error") !== null, true);
    fail = false;
    h.moveA();
    [...deadlines].forEach((callback) => callback());
    await settle();
    deepStrictEqual(h.ids(), ["default", "a", "b"]);
    notify(preferences(["b", "a"]));
    deepStrictEqual(h.ids(), ["default", "b", "a"]);
    strictEqual(deadlines.size, 0);
  } finally {
    h.close();
  }
});

test("TAG-020 BFCache pauses pending saves and subscriptions, then restores usable ordering", async () => {
  let stored = preferences(["a", "b"]),
    subscriptions = 0,
    saves = 0;
  const timers = new Set<() => void>();
  const h = setup({
    read: async () => stored,
    save: async (ids) => {
      saves++;
      if (saves === 1) return new Promise(() => {});
      stored = preferences([...ids]);
      return stored;
    },
    subscribe: () => {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    scheduleDeadline: (callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  try {
    await settle();
    h.moveA();
    h.dom.window.dispatchEvent(
      new h.dom.window.PageTransitionEvent("pagehide", { persisted: true }),
    );
    await settle();
    strictEqual(subscriptions, 0);
    strictEqual(timers.size, 0);
    stored = preferences(["b", "a"]);
    h.dom.window.dispatchEvent(
      new h.dom.window.PageTransitionEvent("pageshow", { persisted: true }),
    );
    await settle();
    deepStrictEqual(h.ids(), ["default", "b", "a"]);
    strictEqual(subscriptions, 1);
    h.moveA("ArrowLeft");
    await settle();
    strictEqual(saves, 2);
    deepStrictEqual(h.ids(), ["default", "a", "b"]);
  } finally {
    h.close();
  }
  strictEqual(subscriptions, 0);
  strictEqual(timers.size, 0);
});

test("TAG-019 stale reads/results cannot replace a newer notification or steal focus in a reopened drawer", async () => {
  let notify: (value: unknown) => void = () => {};
  let resolveRead: (value: unknown) => void = () => {};
  let finishSave: (value: ReturnType<typeof preferences>) => void = () => {};
  const h = setup({
    read: () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    save: () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    subscribe: (callback) => {
      notify = callback;
      return () => {};
    },
    scheduleDeadline: () => () => {},
  });
  try {
    notify(preferences(["a", "b"]));
    resolveRead(preferences(["b", "a"]));
    await settle();
    deepStrictEqual(h.ids(), ["default", "a", "b"]);
    h.moveA();
    h.view.render();
    const input = h.dom.window.document.createElement("input");
    h.container.after(input);
    input.focus();
    notify(preferences(["a", "b"]));
    finishSave(preferences(["b", "a"]));
    await settle();
    deepStrictEqual(h.ids(), ["default", "a", "b"]);
    strictEqual(h.dom.window.document.activeElement, input);
    strictEqual(h.dom.window.document.querySelector('[role="status"]')?.textContent, "");
  } finally {
    h.close();
  }
});
