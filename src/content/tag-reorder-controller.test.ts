import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createTagReorderController } from "./tag-reorder-controller.ts";
import { renderTagList } from "./tag-list.ts";

function eventDriver(dom: JSDOM) {
  const pointer = (type: string, target: EventTarget, x = 20, y = 50) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      isPrimary: { value: true },
      pointerType: { value: "mouse" },
    });
    target.dispatchEvent(event);
    return event;
  };
  const click = (target: EventTarget, detail = 1) => {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail });
    target.dispatchEvent(event);
    return event;
  };
  const key = (target: EventTarget, key: string, altKey = false) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      altKey,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { pointer, click, key };
}

function installGeometry(dom: JSDOM, custom: HTMLElement) {
  const rect = (left: number, top: number, width: number, height: number) =>
    new dom.window.DOMRect(left, top, width, height);
  custom.getBoundingClientRect = () => rect(10, 40, 180, 100);
  Object.defineProperties(custom, { clientWidth: { value: 180 }, clientHeight: { value: 100 } });
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    const chip = custom.querySelector<HTMLElement>(`[data-tag-id="${id}"]`)!;
    chip.getBoundingClientRect = () =>
      rect(10 + (index % 2) * 90, 40 + Math.floor(index / 2) * 40 - custom.scrollTop, 80, 30);
  }
}

function installScheduling(dom: JSDOM) {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { run: () => void; delay: number | undefined }>();
  dom.window.requestAnimationFrame = (callback) => {
    frames.set(++id, callback);
    return id;
  };
  dom.window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  dom.window.setTimeout = (handler, delay) => {
    if (typeof handler !== "function") throw new Error("Expected callback timer");
    timers.set(++id, { run: handler as () => void, delay });
    return id;
  };
  dom.window.clearTimeout = (id) => {
    if (id !== undefined) timers.delete(id);
  };
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { frames, timers, flush };
}

function installPointerCapture(container: HTMLElement): () => number | null {
  let capture: number | null = null;
  container.setPointerCapture = (id) => {
    capture = id;
  };
  container.hasPointerCapture = (id) => capture === id;
  container.releasePointerCapture = () => {
    capture = null;
  };
  return () => capture;
}

function fixture(overrides: Partial<Parameters<typeof createTagReorderController>[1]> = {}) {
  const dom = new JSDOM('<div class="cocoon-tag-list"></div>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const container = document.querySelector<HTMLElement>(".cocoon-tag-list")!;
  let clicks = 0;
  renderTagList(
    container,
    ["default", "a", "b", "c", "d"].map((tagId) => ({ tagId, name: tagId })),
    {
      selectTag() {
        clicks++;
      },
      deleteTag() {
        clicks++;
      },
    },
  );
  const custom = container;
  custom.style.position = "relative";
  custom.style.overflow = "auto";
  const moves: [string, string | null][] = [];
  const messages: string[] = [];
  let enabled = true;
  const capture = installPointerCapture(container);
  const { frames, timers, flush } = installScheduling(dom);
  installGeometry(dom, custom);
  container.addEventListener("click", () => {
    clicks++;
  });
  const controller = createTagReorderController(container, {
    isEnabled: () => enabled,
    move: (id, before) => {
      moves.push([id, before]);
    },
    announce: (message) => {
      messages.push(message);
    },
    ...overrides,
  });
  const choice = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-tag-id="${id}"] .cocoon-tag-choice`)!;
  const { pointer, click, key } = eventDriver(dom);
  const start = () => {
    pointer("pointerdown", choice("a"));
    pointer("pointermove", container, 30, 50);
    flush();
  };
  const close = () => {
    controller.destroy();
    dom.window.close();
  };
  return {
    dom,
    container,
    custom,
    moves,
    messages,
    controller,
    choice,
    pointer,
    click,
    key,
    flush,
    start,
    close,
    frames,
    timers,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    clicks: () => clicks,
    capture,
  };
}

test("default/delete cannot drag; threshold preserves ordinary selection", () => {
  const f = fixture();
  try {
    for (const target of [f.choice("default"), f.custom.querySelector(".cocoon-tag-delete")!]) {
      f.pointer("pointerdown", target);
      f.pointer("pointermove", f.container, 130, 100);
      strictEqual(f.controller.isDragging(), false);
      f.pointer("pointerup", f.container, 130, 100);
    }
    f.pointer("pointerdown", f.choice("a"));
    f.pointer("pointermove", f.container, 23, 52);
    strictEqual(f.controller.isDragging(), false);
    f.pointer("pointerup", f.choice("a"), 23, 52);
    f.click(f.choice("a"));
    strictEqual(f.clicks(), 1);
    deepStrictEqual(f.moves, []);
  } finally {
    f.close();
  }
});

test("wrapped-row drop uses stable IDs without moving live DOM and guards only release click", () => {
  const f = fixture();
  try {
    f.start();
    strictEqual(f.capture(), 1);
    f.pointer("pointermove", f.container, 120, 95);
    f.flush();
    ok(f.custom.querySelector('[data-tag-id="d"]')!.classList.contains("cocoon-tag-drop-before"));
    deepStrictEqual(
      [...f.custom.querySelectorAll('.cocoon-tag-item:not([data-tag-id="default"])')].map(
        (item) => (item as HTMLElement).dataset.tagId,
      ),
      ["a", "b", "c", "d"],
    );
    f.pointer("pointerup", f.container, 120, 95);
    deepStrictEqual(f.moves, [["a", "d"]]);
    strictEqual(f.capture(), null);
    strictEqual(f.click(f.dom.window.document.body).defaultPrevented, true);
    strictEqual(f.clicks(), 0);
    f.click(f.choice("b"), 0);
    strictEqual(f.clicks(), 1);
    f.pointer("pointerdown", f.choice("b"));
    f.pointer("pointerup", f.choice("b"));
    f.click(f.choice("b"));
    strictEqual(f.clicks(), 2);
    ok(f.messages.length > 0);
  } finally {
    f.close();
  }
});

test("returning C to its own rectangle below the A/B row does not reorder", () => {
  const f = fixture();
  try {
    f.custom.querySelector('[data-tag-id="d"]')!.remove();
    f.pointer("pointerdown", f.choice("c"), 20, 95);
    f.pointer("pointermove", f.container, 120, 50);
    f.flush();
    strictEqual(f.controller.isDragging(), true);
    f.pointer("pointermove", f.container, 20, 95);
    f.flush();
    strictEqual(f.custom.querySelector(".cocoon-tag-drop-before,.cocoon-tag-drop-after"), null);
    f.pointer("pointerup", f.container, 20, 95);
    deepStrictEqual(f.moves, []);
    strictEqual(f.click(f.choice("c")).defaultPrevented, true);
    strictEqual(f.clicks(), 0);
    strictEqual(f.capture(), null);
  } finally {
    f.close();
  }
});

test("BUG-024 default is an excluded drop area and preview never covers it", () => {
  const f = fixture();
  try {
    f.choice("default").parentElement!.getBoundingClientRect = () =>
      new f.dom.window.DOMRect(10, 105, 48, 23);
    f.start();
    f.pointer("pointermove", f.container, 20, 100);
    f.flush();
    const preview = f.container.querySelector<HTMLElement>(".cocoon-tag-drag-preview")!;
    strictEqual(
      preview.style.visibility,
      "hidden",
      "overlapping preview must be hidden even outside default",
    );
    f.pointer("pointermove", f.container, 120, 95);
    f.flush();
    strictEqual(preview.style.visibility, "visible");
    f.pointer("pointermove", f.container, 20, 115);
    f.flush();
    strictEqual(f.container.querySelector(".cocoon-tag-drop-before,.cocoon-tag-drop-after"), null);
    f.pointer("pointerup", f.container, 20, 115);
    f.click(f.choice("default"));
    deepStrictEqual(f.moves, []);
    strictEqual(f.clicks(), 0);
    strictEqual(f.capture(), null);
  } finally {
    f.close();
  }
});

test("external release and no-op drop never move; preview remains clipped and noninteractive", () => {
  const f = fixture();
  try {
    f.start();
    f.pointer("pointermove", f.container, 500, 500);
    f.flush();
    const ghost = f.container.querySelector<HTMLElement>(".cocoon-tag-drag-preview")!;
    ok(ghost);
    strictEqual(ghost.getAttribute("aria-hidden"), "true");
    strictEqual(ghost.matches(".cocoon-tag-item,[data-tag-id]"), false);
    strictEqual(ghost.style.pointerEvents, "none");
    ok(
      [...ghost.querySelectorAll<HTMLButtonElement>("button")].every(
        (button) => button.tabIndex === -1,
      ),
    );
    ok(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) <= 180);
    ok(parseFloat(ghost.style.top) + parseFloat(ghost.style.height) <= 100);
    f.pointer("pointerup", f.container, 500, 500);
    strictEqual(f.click(f.dom.window.document.body).defaultPrevented, true);
    f.start();
    f.pointer("pointerup", f.container, 30, 50);
    deepStrictEqual(f.moves, []);
    strictEqual(f.container.querySelector(".cocoon-tag-drag-preview"), null);
  } finally {
    f.close();
  }
});

test("Escape, lost capture, pointercancel and explicit cancellation clean up and guard replacement DOM", () => {
  const f = fixture();
  try {
    let escapes = 0;
    f.dom.window.addEventListener(
      "keydown",
      () => {
        escapes++;
      },
      true,
    );
    f.start();
    strictEqual(f.key(f.choice("a"), "Escape").defaultPrevented, true);
    strictEqual(escapes, 0);
    strictEqual(f.controller.cancel(), false);
    f.key(f.choice("a"), "Escape");
    strictEqual(escapes, 1);
    for (const event of ["lostpointercapture", "pointercancel"]) {
      f.start();
      f.pointer(event, f.container);
      strictEqual(f.controller.isDragging(), false);
      strictEqual(f.click(f.choice("a")).defaultPrevented, true);
    }
    f.start();
    strictEqual(f.controller.cancel(), true);
    f.custom.replaceChildren();
    strictEqual(f.click(f.container).defaultPrevented, true);
    strictEqual(f.clicks(), 0);
    strictEqual(f.capture(), null);
    strictEqual(f.frames.size, 0);
    deepStrictEqual(f.moves, []);
  } finally {
    f.close();
  }
});

test("pending disables pointer/keyboard moves and cancels in-flight release", () => {
  const f = fixture();
  try {
    f.start();
    f.setEnabled(false);
    f.pointer("pointerup", f.container, 170, 95);
    strictEqual(f.controller.isDragging(), false);
    strictEqual(f.click(f.choice("a")).defaultPrevented, true);
    strictEqual(f.clicks(), 0);
    f.start();
    strictEqual(f.controller.isDragging(), false);
    f.choice("a").focus();
    f.key(f.choice("a"), "ArrowRight", true);
    deepStrictEqual(f.moves, []);
  } finally {
    f.close();
  }
});

test("Alt arrows move custom focus only; boundaries, Enter, Space and default are untouched", () => {
  const f = fixture();
  try {
    f.choice("b").focus();
    strictEqual(f.key(f.choice("b"), "ArrowLeft", true).defaultPrevented, true);
    strictEqual(f.dom.window.document.activeElement, f.choice("b"));
    f.key(f.choice("b"), "ArrowRight", true);
    deepStrictEqual(f.moves, [
      ["b", "a"],
      ["b", "d"],
    ]);
    f.choice("d").focus();
    f.key(f.choice("d"), "ArrowLeft", true);
    f.choice("c").focus();
    f.key(f.choice("c"), "ArrowRight", true);
    deepStrictEqual(f.moves.slice(2), [
      ["d", "c"],
      ["c", null],
    ]);
    for (const id of ["a", "d", "default"]) {
      f.choice(id).focus();
      f.key(f.choice(id), id === "a" ? "ArrowLeft" : "ArrowRight", true);
      strictEqual(f.key(f.choice(id), "Enter").defaultPrevented, false);
      strictEqual(f.key(f.choice(id), " ").defaultPrevented, false);
    }
    strictEqual(f.moves.length, 4);
  } finally {
    f.close();
  }
});

test("native scroll refreshes geometry; destroy and pagehide remove resources", () => {
  const f = fixture();
  try {
    f.start();
    f.custom.scrollTop = 40;
    f.custom.dispatchEvent(new f.dom.window.Event("scroll"));
    f.flush();
    f.pointer("pointerup", f.container, 170, 55);
    deepStrictEqual(f.moves, [["a", null]]);
    f.start();
    f.controller.destroy();
    strictEqual(f.capture(), null);
    strictEqual(f.frames.size, 0);
    strictEqual(f.timers.size, 0);
    strictEqual(f.container.querySelector(".cocoon-tag-drag-preview"), null);
    f.click(f.choice("a"));
    strictEqual(f.clicks(), 1);
    f.start();
    strictEqual(f.controller.isDragging(), false);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    g.start();
    g.dom.window.dispatchEvent(new g.dom.window.Event("pagehide"));
    strictEqual(g.capture(), null);
    strictEqual(g.frames.size, 0);
    strictEqual(g.timers.size, 0);
    strictEqual(g.container.querySelector(".cocoon-tag-drag-preview"), null);
  } finally {
    g.close();
  }
});

test("persisted pagehide clears transient resources and pageshow reuses pointer and keyboard bindings", () => {
  const f = fixture();
  try {
    f.start();
    f.pointer("pointermove", f.container, 120, 95);
    f.setEnabled(false);
    f.dom.window.dispatchEvent(
      new f.dom.window.PageTransitionEvent("pagehide", { persisted: true }),
    );
    strictEqual(f.controller.isDragging(), false);
    strictEqual(f.capture(), null);
    strictEqual(f.frames.size, 0);
    strictEqual(f.timers.size, 0);
    strictEqual(f.container.querySelector(".cocoon-tag-drag-preview"), null);
    f.click(f.choice("a"));
    strictEqual(f.clicks(), 1);
    f.start();
    strictEqual(f.controller.isDragging(), false);
    deepStrictEqual(f.moves, []);

    f.dom.window.dispatchEvent(
      new f.dom.window.PageTransitionEvent("pageshow", { persisted: true }),
    );
    f.setEnabled(true);
    f.start();
    strictEqual(f.controller.isDragging(), true);
    f.pointer("pointerup", f.container, 120, 95);
    f.choice("b").focus();
    f.key(f.choice("b"), "ArrowLeft", true);
    deepStrictEqual(f.moves, [
      ["a", "d"],
      ["b", "a"],
    ]);
  } finally {
    f.close();
  }
});

test("cancel guard survives rerender, ends at a fresh gesture or a bounded post-release timer", () => {
  const f = fixture();
  try {
    f.start();
    f.controller.cancel();
    strictEqual([...f.timers.values()][0]?.delay, 30_000);
    f.pointer("pointerup", f.dom.window.document.body);
    const timer = [...f.timers.values()][0]!;
    strictEqual(timer.delay, 1500);
    f.click(f.choice("b"), 0);
    strictEqual(f.clicks(), 1);
    timer.run();
    strictEqual(f.timers.size, 0);
    f.click(f.choice("b"));
    strictEqual(f.clicks(), 2);
    f.start();
    f.controller.cancel();
    f.pointer("pointerdown", f.choice("b"));
    f.pointer("pointerup", f.choice("b"));
    f.click(f.choice("b"));
    strictEqual(f.clicks(), 3);
  } finally {
    f.close();
  }
});

test("preview/drop bounds intersect the viewport and clipped ancestor", () => {
  const f = fixture();
  try {
    Object.defineProperty(f.dom.window, "innerWidth", { value: 160 });
    const clippingParent = f.dom.window.document.createElement("div");
    f.container.before(clippingParent);
    clippingParent.append(f.container);
    clippingParent.style.overflow = "hidden";
    clippingParent.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 200, 100);
    Object.defineProperties(clippingParent, {
      clientWidth: { value: 200 },
      clientHeight: { value: 100 },
    });
    f.start();
    f.pointer("pointermove", f.container, 180, 120);
    f.flush();
    const ghost = f.custom.querySelector<HTMLElement>(".cocoon-tag-drag-preview")!;
    ok(parseFloat(ghost.style.left) + parseFloat(ghost.style.width) <= 150);
    ok(parseFloat(ghost.style.top) + parseFloat(ghost.style.height) <= 60);
    f.pointer("pointerup", f.container, 180, 120);
    deepStrictEqual(f.moves, []);
  } finally {
    f.close();
  }
});

test("throwing host callbacks fail closed without leaving capture or preview", () => {
  const failures: string[] = [];
  const f = fixture({
    move: () => {
      throw new Error("host failure");
    },
    announce: (message) => {
      failures.push(message);
      throw new Error("report failure");
    },
  });
  try {
    f.start();
    f.pointer("pointerup", f.container, 170, 95);
    strictEqual(f.controller.isDragging(), false);
    strictEqual(f.capture(), null);
    strictEqual(f.container.querySelector(".cocoon-tag-drag-preview"), null);
    strictEqual(f.click(f.choice("a")).defaultPrevented, true);
    deepStrictEqual(failures, ["标签排序失败，请重试"]);
  } finally {
    f.close();
  }
  const disabled = fixture({
    isEnabled: () => {
      throw new Error("disabled failure");
    },
  });
  try {
    disabled.start();
    strictEqual(disabled.controller.isDragging(), false);
  } finally {
    disabled.close();
  }
});
