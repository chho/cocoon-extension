import {
  BLACKLIST_QUERY_PAGE_SIZE,
  MAX_BLACKLIST_QUERY_CODE_POINTS,
  type BlacklistAuthorListItemDto,
  type BlacklistSummaryDto,
} from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistAuthorDto, CurrentPageStatus } from "../core/blacklist-rpc-contract.ts";
import {
  parseBlacklistRevisionChange,
  type BlacklistChangeEventSource,
} from "../core/blacklist-revision-contract.ts";
import type { StrictBlacklistRpcClient } from "../ui/background-rpc.ts";
import { POPUP_RECENT_LIMIT, queryPopupData, type PopupQueryData } from "./popup-query-client.ts";
import {
  createPopupRevisionCoordinator,
  type PopupRevisionCoordinator,
} from "./popup-revision-coordinator.ts";
import { focusPopupSearch, renderPopupRecordList } from "./record-list-view.ts";
import { createPopupUndoController, type PopupUndoController } from "./undo-controller.ts";

export interface PopupAppDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly rpc: StrictBlacklistRpcClient;
  readonly storageChanges: BlacklistChangeEventSource;
  readonly openOptionsPage: () => Promise<void>;
}

export interface PopupApp {
  refresh(): Promise<void>;
  dispose(): void;
}

interface PopupElements {
  readonly pageStatus: HTMLElement;
  readonly pageStatusText: HTMLElement;
  readonly count: HTMLElement;
  readonly countInline: HTMLElement;
  readonly connectionError: HTMLElement;
  readonly authorTotal: HTMLElement;
  readonly tagTotal: HTMLElement;
  readonly search: HTMLInputElement;
  readonly recordsTitle: HTMLElement;
  readonly dataMessage: HTMLElement;
  readonly records: HTMLUListElement;
  readonly undoStrip: HTMLElement;
  readonly undoButton: HTMLButtonElement;
  readonly saveError: HTMLElement;
  readonly manageButton: HTMLButtonElement;
}

interface MutationSummary {
  readonly revision: number | null;
  readonly authorCount: number | null;
  readonly tagCount: number | null;
}

function requiredElement<ElementType extends HTMLElement>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Popup element is missing: ${selector}`);
  return element;
}

function popupElements(document: Document): PopupElements {
  return {
    pageStatus: requiredElement(document, "#page-status"),
    pageStatusText: requiredElement(document, "#page-status-text"),
    count: requiredElement(document, "#count"),
    countInline: requiredElement(document, "#count-inline"),
    connectionError: requiredElement(document, "#connection-error"),
    authorTotal: requiredElement(document, "#author-total"),
    tagTotal: requiredElement(document, "#tag-total"),
    search: requiredElement(document, "#search"),
    recordsTitle: requiredElement(document, "#records-title"),
    dataMessage: requiredElement(document, "#data-message"),
    records: requiredElement(document, "#records"),
    undoStrip: requiredElement(document, "#undo-strip"),
    undoButton: requiredElement(document, "#undo"),
    saveError: requiredElement(document, "#save-error"),
    manageButton: requiredElement(document, "#manage"),
  };
}

function showPopupSaveError(element: HTMLElement, message = "更改未保存，请重试。"): void {
  element.textContent = message;
  element.hidden = false;
}

function normalizedSearch(input: HTMLInputElement): string {
  const bounded = Array.from(input.value).slice(0, MAX_BLACKLIST_QUERY_CODE_POINTS).join("");
  if (bounded !== input.value) input.value = bounded;
  return bounded.trim();
}

function sameAuthor(left: BlacklistAuthorDto, right: BlacklistAuthorDto): boolean {
  return left.platformId === right.platformId && left.userId === right.userId;
}

function itemMatchesSearch(item: BlacklistAuthorListItemDto, search: string): boolean {
  if (!search) return true;
  const normalized = search.toLocaleLowerCase("zh-CN");
  return (
    item.author.authorName.toLocaleLowerCase("zh-CN").includes(normalized) ||
    item.tag.name.toLocaleLowerCase("zh-CN").includes(normalized)
  );
}

async function initializeStatus(
  rpc: StrictBlacklistRpcClient,
  setStatus: (status: CurrentPageStatus, count: number) => void,
): Promise<void> {
  try {
    const response = await rpc.request("status");
    if (response.ok && response.data.status && response.data.count !== null) {
      setStatus(response.data.status, response.data.count);
      return;
    }
  } catch {
    // The explicit connection state below is also used for malformed responses.
  }
  setStatus("connection-error", 0);
}

class PopupAppController implements PopupApp {
  private readonly dependencies: PopupAppDependencies;
  private readonly elements: PopupElements;
  private readonly undoController: PopupUndoController;
  private readonly revisions: PopupRevisionCoordinator;
  private summary: BlacklistSummaryDto | null = null;
  private items: readonly BlacklistAuthorListItemDto[] = [];
  private writesEnabled = false;
  private pendingUndoItem: BlacklistAuthorListItemDto | null = null;

  constructor(dependencies: PopupAppDependencies) {
    this.dependencies = dependencies;
    this.elements = popupElements(dependencies.document);
    this.undoController = createPopupUndoController(
      (callback, delay) => dependencies.window.setTimeout(callback, delay),
      (id) => dependencies.window.clearTimeout(id),
      () => this.hideExpiredUndo(),
    );
    this.revisions = createPopupRevisionCoordinator({
      getQuery: () => normalizedSearch(this.elements.search),
      hasData: () => this.summary !== null,
      load: (query, minimumRevision) => queryPopupData(dependencies.rpc, query, minimumRevision),
      apply: (data) => this.applyQueryData(data),
      fail: () => this.showUnreadableStorage(),
    });
    this.elements.undoButton.disabled = true;
    this.bindEvents();
    focusPopupSearch(this.elements.search);
    void initializeStatus(dependencies.rpc, (status, count) => this.setStatus(status, count));
    void this.refresh();
  }

  refresh(): Promise<void> {
    return this.revisions.request(this.summary?.revision ?? 0);
  }

  dispose(): void {
    this.revisions.invalidate();
    this.undoController.dispose();
  }

  private setStatus(status: CurrentPageStatus, exactCount: number): void {
    const labels: Record<CurrentPageStatus, string> = {
      running: "运行中",
      unsupported: "此页面不受支持",
      "connection-error": "页面连接异常",
    };
    const label = labels[status];
    this.elements.pageStatusText.textContent = label;
    this.elements.pageStatus.dataset.state = status;
    this.elements.pageStatus.setAttribute("aria-label", `页面状态：${label}`);
    this.elements.count.textContent = String(exactCount);
    this.elements.countInline.textContent = String(exactCount);
    this.elements.connectionError.hidden = status !== "connection-error";
  }

  private renderData(): void {
    if (!this.summary) return;
    this.elements.authorTotal.textContent = String(this.summary.authorCount);
    this.elements.tagTotal.textContent = String(this.summary.tagCount);
    const query = normalizedSearch(this.elements.search);
    this.elements.recordsTitle.textContent = query ? "搜索结果" : "最近屏蔽";
    renderPopupRecordList({
      list: this.elements.records,
      items: this.items,
      queryActive: Boolean(query),
      writesEnabled: this.writesEnabled,
      onRemove: (author, button) => {
        void this.removeAuthor(author, button);
      },
    });
  }

  private hideExpiredUndo(): void {
    this.pendingUndoItem = null;
    this.elements.undoStrip.hidden = true;
    this.elements.undoButton.disabled = true;
  }

  private clearUndo(): void {
    this.undoController.clear();
    this.hideExpiredUndo();
  }

  private showUnreadableStorage(): void {
    this.revisions.invalidate();
    this.summary = null;
    this.items = [];
    this.writesEnabled = false;
    this.clearUndo();
    this.elements.dataMessage.hidden = false;
    this.elements.dataMessage.textContent = "本地数据无法读取，Cocoon 未进行修改。";
    this.elements.records.replaceChildren();
    this.elements.authorTotal.textContent = "—";
    this.elements.tagTotal.textContent = "—";
  }

  private applyQueryData(data: PopupQueryData): void {
    if (data.summary.revision < (this.summary?.revision ?? 0)) return;
    this.summary = data.summary;
    this.items = data.items;
    this.writesEnabled = true;
    this.elements.dataMessage.hidden = true;
    this.renderData();
  }

  private applyMutationSummary(response: MutationSummary): boolean {
    const { revision, authorCount, tagCount } = response;
    if (revision === null || authorCount === null || tagCount === null) return false;
    if (revision < (this.summary?.revision ?? 0)) return false;
    this.revisions.invalidate();
    this.summary = { revision, authorCount, tagCount };
    this.writesEnabled = true;
    this.elements.dataMessage.hidden = true;
    return true;
  }

  private async rollbackMutation(storageUnreadable: boolean): Promise<void> {
    showPopupSaveError(this.elements.saveError);
    if (storageUnreadable) {
      this.showUnreadableStorage();
      return;
    }
    this.renderData();
    await this.refresh();
  }

  private async removeAuthor(author: BlacklistAuthorDto, button: HTMLButtonElement): Promise<void> {
    if (!this.writesEnabled) return;
    this.elements.saveError.hidden = true;
    button.disabled = true;
    const removedItem = this.items.find((item) => sameAuthor(item.author, author)) ?? null;
    try {
      const response = await this.dependencies.rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!response.ok || !response.data.removed) {
        await this.rollbackMutation(response.error === "storage-unreadable");
        return;
      }
      this.applyRemoval(response.data, removedItem);
    } catch {
      await this.rollbackMutation(false);
    }
  }

  private applyRemoval(
    data: MutationSummary & { readonly removed: BlacklistAuthorDto | null },
    removedItem: BlacklistAuthorListItemDto | null,
  ): void {
    const removed = data.removed;
    if (!removed || !this.applyMutationSummary(data)) {
      void this.revisions.request(data.revision ?? 0);
      return;
    }
    this.items = this.items.filter((item) => !sameAuthor(item.author, removed));
    this.clearUndo();
    this.pendingUndoItem = removedItem ? { author: removed, tag: removedItem.tag } : null;
    this.undoController.start(removed);
    this.renderData();
    this.elements.undoButton.disabled = false;
    this.elements.undoStrip.hidden = false;
    this.elements.undoButton.focus();
    void this.revisions.request(data.revision ?? 0);
  }

  private showPendingUndo(): void {
    const pending = this.undoController.current() !== null;
    this.elements.undoButton.disabled = !pending;
    this.elements.undoStrip.hidden = !pending;
  }

  private coordinateRestoredItem(item: BlacklistAuthorListItemDto | null): void {
    const query = normalizedSearch(this.elements.search);
    if (!item || !itemMatchesSearch(item, query)) return;
    const withoutDuplicate = this.items.filter(
      (candidate) => !sameAuthor(candidate.author, item.author),
    );
    const limit = query ? BLACKLIST_QUERY_PAGE_SIZE : POPUP_RECENT_LIMIT;
    this.items = [item, ...withoutDuplicate].slice(0, limit);
  }

  private async restoreRemovedAuthor(): Promise<void> {
    const author = this.undoController.current();
    if (!author || !this.writesEnabled) return;
    const restoredItem = this.pendingUndoItem;
    this.elements.saveError.hidden = true;
    this.elements.undoButton.disabled = true;
    try {
      const response = await this.dependencies.rpc.restoreOne(author);
      if (!response.ok) {
        await this.rollbackMutation(response.error === "storage-unreadable");
        this.showPendingUndo();
        return;
      }
      this.applyRestoration(response.data, restoredItem);
    } catch {
      await this.rollbackMutation(false);
      this.showPendingUndo();
    }
  }

  private applyRestoration(
    data: MutationSummary,
    restoredItem: BlacklistAuthorListItemDto | null,
  ): void {
    const accepted = this.applyMutationSummary(data);
    this.clearUndo();
    if (accepted) {
      this.coordinateRestoredItem(restoredItem);
      this.renderData();
    }
    focusPopupSearch(this.elements.search);
    void this.revisions.request(data.revision ?? 0);
  }

  private async openManagementPage(): Promise<void> {
    this.elements.saveError.hidden = true;
    try {
      await this.dependencies.openOptionsPage();
    } catch {
      showPopupSaveError(this.elements.saveError, "无法打开管理页，请重试。");
    }
  }

  private handleSearchInput(): void {
    normalizedSearch(this.elements.search);
    this.elements.recordsTitle.textContent = this.elements.search.value.trim()
      ? "搜索结果"
      : "最近屏蔽";
    this.elements.records.replaceChildren();
    void this.refresh();
  }

  private handleStorageChange(changes: Record<string, unknown>, areaName: string): void {
    const signal = parseBlacklistRevisionChange(changes, areaName);
    if (!signal || signal.revision <= (this.summary?.revision ?? -1)) return;
    void this.revisions.request(signal.revision);
  }

  private bindEvents(): void {
    this.elements.search.addEventListener("input", () => this.handleSearchInput());
    this.elements.undoButton.addEventListener("click", () => {
      void this.restoreRemovedAuthor();
    });
    this.elements.manageButton.addEventListener("click", () => {
      void this.openManagementPage();
    });
    this.dependencies.storageChanges.addListener((changes, areaName) => {
      this.handleStorageChange(changes, areaName);
    });
    this.dependencies.window.addEventListener("pagehide", () => this.dispose());
  }
}

export function bootstrapPopup(dependencies: PopupAppDependencies): PopupApp {
  return new PopupAppController(dependencies);
}
