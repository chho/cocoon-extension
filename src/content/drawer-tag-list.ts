import { DEFAULT_TAG_ID, type CocoonTag } from "./blacklist-state.ts";
import { renderTagList, type TagListActions } from "./tag-list.ts";
import { createTagReorderController } from "./tag-reorder-controller.ts";
import {
  TAG_ORDER_STORAGE_KEY,
  moveCustomTag,
  orderDrawerTags,
  parseTagOrderPreferences,
  saveTagOrder,
  type TagOrderPreferences,
} from "./tag-order.ts";

export interface TagOrderEnvironment {
  read(): Promise<unknown>;
  save(ids: readonly string[], signal: AbortSignal): Promise<TagOrderPreferences>;
  subscribe(callback: (value: unknown) => void): () => void;
  scheduleDeadline(callback: () => void): () => void;
}
interface DrawerTagListOptions extends TagListActions {
  getTags(): readonly CocoonTag[];
  getStatus(): "closed" | "open" | "submitting";
  onLayoutChange?: () => void;
}

function chromeEnvironment(window: Window): TagOrderEnvironment {
  const read = async (): Promise<unknown> => {
    const values = await chrome.storage.local.get(TAG_ORDER_STORAGE_KEY);
    return values[TAG_ORDER_STORAGE_KEY] as unknown;
  };
  return {
    read,
    save: (ids, signal) =>
      saveTagOrder(
        {
          read,
          write: async (preferences) => {
            await chrome.storage.local.set({ [TAG_ORDER_STORAGE_KEY]: preferences });
          },
          withExclusiveLock: async (operation, abort) =>
            navigator.locks.request(
              TAG_ORDER_STORAGE_KEY,
              { mode: "exclusive", signal: abort },
              operation,
            ),
        },
        ids,
        signal,
      ),
    subscribe(callback) {
      const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && Object.hasOwn(changes, TAG_ORDER_STORAGE_KEY))
          callback(changes[TAG_ORDER_STORAGE_KEY]?.newValue as unknown);
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
    scheduleDeadline(callback) {
      const timer = window.setTimeout(callback, 5_000);
      return () => window.clearTimeout(timer);
    },
  };
}

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  run: AbortController,
  environment: TagOrderEnvironment,
): Promise<T> {
  let interrupt = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(new Error("Tag order operation was not confirmed."));
  });
  run.signal.addEventListener("abort", interrupt, { once: true });
  const cancelDeadline = environment.scheduleDeadline(() => run.abort());
  try {
    return await Promise.race([operation(run.signal), interrupted]);
  } finally {
    cancelDeadline();
    run.signal.removeEventListener("abort", interrupt);
  }
}

interface TagFocus {
  id: string;
  selector: string;
}
function captureTagFocus(container: HTMLElement): TagFocus | null {
  const element = container.ownerDocument.activeElement;
  if (!element || !container.contains(element)) return null;
  const id = element.closest("[data-tag-id]")?.getAttribute("data-tag-id");
  return id
    ? {
        id,
        selector: element.classList.contains("cocoon-tag-delete")
          ? ".cocoon-tag-delete"
          : ".cocoon-tag-choice",
      }
    : null;
}
function restoreTagFocus(container: HTMLElement, focus: TagFocus): void {
  const item = [...container.querySelectorAll<HTMLElement>(".cocoon-tag-item")].find(
    (node) => node.dataset.tagId === focus.id,
  );
  const control = item?.querySelector<HTMLElement>(focus.selector);
  control?.focus({ preventScroll: true });
  control?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

class DrawerTagList {
  private readonly container: HTMLElement;
  private readonly options: DrawerTagListOptions;
  private readonly environment: TagOrderEnvironment;
  private readonly status: HTMLElement;
  private readonly drag: ReturnType<typeof createTagReorderController>;
  private readonly observer: MutationObserver;
  private persisted: TagOrderPreferences = { schemaVersion: 1, tagIds: [] };
  private pending: readonly string[] | null = null;
  private ready = false;
  private active = false;
  private disposed = false;
  private revision = 0;
  private viewRevision = 0;
  private readRun: AbortController | null = null;
  private saveRun: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    options: DrawerTagListOptions,
    environment: TagOrderEnvironment,
  ) {
    this.container = container;
    this.options = options;
    this.environment = environment;
    const window = container.ownerDocument.defaultView!;
    this.status = container.ownerDocument.createElement("div");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.className = "cocoon-visually-hidden";
    container.after(this.status);
    this.drag = createTagReorderController(container, {
      isEnabled: () => this.canReorder(),
      move: (id, before) => {
        void this.move(id, before);
      },
      announce: (message) => this.announce(message),
    });
    this.observer = new window.MutationObserver(() => {
      if (options.getStatus() !== "open") this.drag.cancel();
    });
    window.addEventListener("pagehide", this.pagehide);
    window.addEventListener("pageshow", this.pageshow);
    this.resume();
  }

  private announce(message: string, error = false): void {
    this.status.className = error ? "cocoon-tag-order-error" : "cocoon-visually-hidden";
    this.status.textContent = message;
    this.options.onLayoutChange?.();
  }

  private repaint(): void {
    if (!this.active || this.options.getStatus() === "submitting") return;
    this.drag.cancel();
    const focus = captureTagFocus(this.container);
    renderTagList(
      this.container,
      orderDrawerTags(this.options.getTags(), this.pending ?? this.persisted.tagIds),
      this.options,
    );
    this.options.onLayoutChange?.();
    if (focus && this.options.getStatus() === "open") restoreTagFocus(this.container, focus);
  }

  render(): void {
    this.viewRevision++;
    this.announce("");
    this.repaint();
  }

  private replace(value: unknown): void {
    if (!this.active) return;
    this.revision++;
    this.persisted = parseTagOrderPreferences(value).preferences;
    this.ready = true;
    if (!this.pending) this.repaint();
  }

  private async initialize(): Promise<void> {
    const revision = this.revision;
    const run = new AbortController();
    this.readRun = run;
    try {
      const value = await bounded(() => this.environment.read(), run, this.environment);
      if (this.active && this.readRun === run && revision === this.revision)
        this.persisted = parseTagOrderPreferences(value).preferences;
    } catch {
      if (this.active && this.readRun === run && revision === this.revision)
        this.announce("无法读取标签顺序，暂用默认顺序。可重新调整后保存。", true);
    } finally {
      if (this.active && this.readRun === run) {
        this.readRun = null;
        this.ready = true;
        this.repaint();
      }
    }
  }

  private canReorder(): boolean {
    return this.active && this.ready && !this.pending && this.options.getStatus() === "open";
  }

  private finishMove(run: AbortController, viewRevision: number, confirmed: boolean): void {
    if (!this.active || this.saveRun !== run) return;
    this.saveRun = null;
    this.pending = null;
    this.repaint();
    if (viewRevision !== this.viewRevision || this.options.getStatus() !== "open") return;
    this.announce(
      confirmed ? "标签顺序已保存。" : "标签顺序保存未确认，已恢复最近已知顺序。请稍后重试。",
      !confirmed,
    );
  }

  private async move(id: string, before: string | null): Promise<void> {
    if (!this.canReorder()) return;
    const ids = orderDrawerTags(this.options.getTags(), this.persisted.tagIds)
      .map((tag) => tag.tagId)
      .filter((tagId) => tagId !== DEFAULT_TAG_ID);
    const next = moveCustomTag(ids, id, before);
    if (ids.every((value, index) => value === next[index])) return;
    const run = new AbortController();
    this.saveRun = run;
    const revision = this.revision,
      viewRevision = this.viewRevision;
    this.pending = next;
    this.repaint();
    let confirmed = false;
    try {
      const saved = await bounded(
        (signal) => this.environment.save(next, signal),
        run,
        this.environment,
      );
      if (this.active && this.saveRun === run && revision === this.revision) this.persisted = saved;
      confirmed = true;
    } catch {
      /* The latest storage notification remains authoritative after an uncertain write. */
    } finally {
      this.finishMove(run, viewRevision, confirmed);
    }
  }

  private resume(): void {
    if (this.active || this.disposed) return;
    this.active = true;
    this.ready = false;
    this.unsubscribe = this.environment.subscribe((value) => this.replace(value));
    const drawer = this.container.closest(".cocoon-tag-drawer");
    if (drawer)
      this.observer.observe(drawer, {
        attributes: true,
        attributeFilter: ["aria-busy", "data-phase", "hidden"],
      });
    this.repaint();
    void this.initialize();
  }

  private pause(): void {
    this.active = false;
    this.drag.cancel();
    this.observer.disconnect();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.readRun?.abort();
    this.saveRun?.abort();
    this.readRun = null;
    this.saveRun = null;
    this.pending = null;
    this.viewRevision++;
  }

  private readonly pagehide = (event: PageTransitionEvent): void => {
    if (event.persisted) this.pause();
    else this.destroy();
  };
  private readonly pageshow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.resume();
  };

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.drag.destroy();
    this.status.remove();
    const window = this.container.ownerDocument.defaultView!;
    window.removeEventListener("pagehide", this.pagehide);
    window.removeEventListener("pageshow", this.pageshow);
  }
}

export function createDrawerTagList(
  container: HTMLElement,
  options: DrawerTagListOptions,
  environment = chromeEnvironment(container.ownerDocument.defaultView!),
) {
  return new DrawerTagList(container, options, environment);
}
