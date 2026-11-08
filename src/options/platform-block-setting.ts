import {
  PLATFORM_BLOCK_PREFERENCE_KEY,
  parsePlatformBlockPreference,
} from "../core/platform-block-preference.ts";
import { requiredOptionsElement } from "./options-app-view.ts";

export interface PlatformBlockSettingDependencies {
  readonly document: Document;
  readonly storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(id: number): void;
}

const STORAGE_TIMEOUT = new Error("Preference storage timeout");

function bindSettingTooltip(document: Document, signal: AbortSignal): void {
  const help = requiredOptionsElement<HTMLButtonElement>(document, "#platform-block-help");
  const area = requiredOptionsElement(document, ".setting-help");
  const tooltip = requiredOptionsElement(document, "#platform-block-tooltip");
  let hovered = false;
  let focused = false;
  let dismissed = false;
  const render = () => {
    if (!hovered && !focused) dismissed = false;
    tooltip.hidden = dismissed || (!hovered && !focused);
  };
  const onHover = (event: Event) => {
    hovered = event.type === "mouseenter";
    render();
  };
  const onFocus = (event: Event) => {
    focused = event.type === "focus";
    render();
  };
  area.addEventListener("mouseenter", onHover, { signal });
  area.addEventListener("mouseleave", onHover, { signal });
  help.addEventListener("focus", onFocus, { signal });
  help.addEventListener("blur", onFocus, { signal });
  help.addEventListener(
    "click",
    () => {
      dismissed = false;
      render();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || tooltip.hidden) return;
      dismissed = true;
      render();
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      tooltip.hidden = true;
    },
    { once: true },
  );
}

class PlatformBlockSetting {
  private readonly dependencies: PlatformBlockSettingDependencies;
  private readonly checkbox: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly events: AbortController;
  private saved = false;
  private pending = true;
  private destroyed = false;
  private cancelWait: (() => void) | null = null;

  constructor(dependencies: PlatformBlockSettingDependencies) {
    this.dependencies = dependencies;
    const { document } = dependencies;
    const window = document.defaultView;
    if (!window) throw new Error("Settings require a document window");
    this.events = new window.AbortController();
    this.checkbox = requiredOptionsElement(document, "#block-voters-on-platform");
    this.status = requiredOptionsElement(document, "#platform-block-status");
    this.checkbox.checked = false;
    this.checkbox.disabled = true;
    this.checkbox.addEventListener(
      "change",
      () => {
        void this.save();
      },
      {
        signal: this.events.signal,
      },
    );
    bindSettingTooltip(document, this.events.signal);
    void this.load();
  }

  destroy(): void {
    this.destroyed = true;
    this.events.abort();
    this.cancelWait?.();
    this.checkbox.disabled = true;
  }

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timer: number | undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      timer = this.dependencies.setTimeout(() => reject(STORAGE_TIMEOUT), 5000);
      this.cancelWait = () => {
        if (timer !== undefined) this.dependencies.clearTimeout(timer);
        reject(new Error("Settings closed"));
      };
    });
    try {
      return await Promise.race([operation(), boundary]);
    } finally {
      if (timer !== undefined) this.dependencies.clearTimeout(timer);
      this.cancelWait = null;
    }
  }

  private async load(): Promise<void> {
    try {
      const result = await this.bounded(() =>
        this.dependencies.storage.get(PLATFORM_BLOCK_PREFERENCE_KEY),
      );
      if (this.destroyed) return;
      this.saved = parsePlatformBlockPreference(result[PLATFORM_BLOCK_PREFERENCE_KEY]);
      this.checkbox.checked = this.saved;
      this.checkbox.disabled = false;
      this.pending = false;
      this.status.textContent = "";
    } catch {
      if (!this.destroyed) this.status.textContent = "设置无法读取，请重新打开管理页重试。";
    }
  }

  private async save(): Promise<void> {
    if (this.destroyed || this.pending) return;
    this.pending = true;
    this.checkbox.disabled = true;
    const next = this.checkbox.checked;
    this.status.textContent = "正在保存…";
    try {
      await this.bounded(() =>
        this.dependencies.storage.set({
          [PLATFORM_BLOCK_PREFERENCE_KEY]: { version: 1, blockVotersOnPlatform: next },
        }),
      );
      if (this.destroyed) return;
      this.saved = next;
      this.status.textContent = "";
      this.pending = false;
    } catch (error) {
      if (this.destroyed) return;
      this.checkbox.checked = this.saved;
      // A timed-out Chrome write cannot be cancelled; do not race it with a retry.
      this.pending = error === STORAGE_TIMEOUT;
      this.status.textContent = this.pending
        ? "保存结果未确认，请重新打开管理页核对。"
        : "更改未保存，请重试。";
    } finally {
      if (!this.destroyed) this.checkbox.disabled = this.pending;
    }
  }
}

export function bootstrapPlatformBlockSetting(dependencies: PlatformBlockSettingDependencies): {
  destroy(): void;
} {
  return new PlatformBlockSetting(dependencies);
}
