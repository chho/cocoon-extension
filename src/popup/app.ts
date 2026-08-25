import type {
  BlacklistAuthorDto,
  BlacklistSnapshotDto,
  CurrentPageStatus,
} from "../core/blacklist-rpc-contract.ts";
import {
  parseBlacklistRevisionChange,
  type BlacklistChangeEventSource,
} from "../core/blacklist-revision-contract.ts";
import type { BlacklistRpcClient } from "../ui/background-rpc.ts";
import { popupResults, summarizeBlacklist } from "../ui/blacklist-view-model.ts";
import { createCommittedSnapshotController } from "../ui/committed-snapshot-controller.ts";
import { createLatestRefreshController } from "../ui/latest-refresh-controller.ts";
import { loadBlacklistSnapshot } from "../ui/blacklist-snapshot-loader.ts";
import { createPopupUndoController } from "./undo-controller.ts";
import { focusPopupSearch, renderPopupRecordList } from "./record-list-view.ts";

export interface PopupAppDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly rpc: BlacklistRpcClient;
  readonly storageChanges: BlacklistChangeEventSource;
  readonly openOptionsPage: () => Promise<void>;
}

export interface PopupApp {
  refresh(): Promise<void>;
  dispose(): void;
}

function requiredElement<ElementType extends HTMLElement>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Popup element is missing: ${selector}`);
  return element;
}

interface PopupInitialization {
  readonly search: HTMLInputElement;
  readonly rpc: BlacklistRpcClient;
  readonly refresh: () => Promise<void>;
  readonly setStatus: (status: CurrentPageStatus, count: number) => void;
}

function showPopupSaveError(element: HTMLElement, message = "更改未保存，请重试。"): void {
  element.textContent = message;
  element.hidden = false;
}

function canUndoRemoval(
  snapshot: BlacklistSnapshotDto | null,
  writesEnabled: boolean,
  author: BlacklistAuthorDto,
): boolean {
  if (!writesEnabled || !snapshot) return false;
  if (!snapshot.tags.some((tag) => tag.tagId === author.tagId)) return false;
  const identifiers = new Set(
    [author.userId, author.memberHashId].filter((value): value is string => value !== null),
  );
  return !snapshot.authors.some(
    (candidate) =>
      candidate.platformId === author.platformId &&
      (identifiers.has(candidate.userId) ||
        (candidate.memberHashId !== null && identifiers.has(candidate.memberHashId))),
  );
}

async function initializePopup(options: PopupInitialization): Promise<void> {
  focusPopupSearch(options.search);
  const statusPromise = options.rpc.request("status");
  const snapshotPromise = options.refresh();
  try {
    const response = await statusPromise;
    if (response.ok && response.data.status && response.data.count !== null) {
      options.setStatus(response.data.status, response.data.count);
    } else {
      options.setStatus("connection-error", 0);
    }
  } catch {
    options.setStatus("connection-error", 0);
  }
  await snapshotPromise;
}

export function bootstrapPopup(dependencies: PopupAppDependencies): PopupApp {
  const { document, window, rpc } = dependencies;
  const pageStatus = requiredElement<HTMLElement>(document, "#page-status");
  const pageStatusText = requiredElement<HTMLElement>(document, "#page-status-text");
  const count = requiredElement<HTMLElement>(document, "#count");
  const countInline = requiredElement<HTMLElement>(document, "#count-inline");
  const connectionError = requiredElement<HTMLElement>(document, "#connection-error");
  const authorTotal = requiredElement<HTMLElement>(document, "#author-total");
  const tagTotal = requiredElement<HTMLElement>(document, "#tag-total");
  const search = requiredElement<HTMLInputElement>(document, "#search");
  const recordsTitle = requiredElement<HTMLElement>(document, "#records-title");
  const dataMessage = requiredElement<HTMLElement>(document, "#data-message");
  const records = requiredElement<HTMLUListElement>(document, "#records");
  const undoStrip = requiredElement<HTMLElement>(document, "#undo-strip");
  const undoButton = requiredElement<HTMLButtonElement>(document, "#undo");
  const saveError = requiredElement<HTMLElement>(document, "#save-error");
  const manageButton = requiredElement<HTMLButtonElement>(document, "#manage");

  let snapshot: BlacklistSnapshotDto | null = null;
  let writesEnabled = false;

  const undoController = createPopupUndoController(
    (callback, delay) => window.setTimeout(callback, delay),
    (id) => window.clearTimeout(id),
    () => {
      undoStrip.hidden = true;
      undoButton.disabled = true;
    },
  );
  undoButton.disabled = true;

  function setStatus(status: CurrentPageStatus, exactCount: number): void {
    const labels: Record<CurrentPageStatus, string> = {
      running: "运行中",
      unsupported: "此页面不受支持",
      "connection-error": "页面连接异常",
    };
    const label = labels[status];
    pageStatusText.textContent = label;
    pageStatus.dataset.state = status;
    pageStatus.setAttribute("aria-label", `页面状态：${label}`);
    count.textContent = String(exactCount);
    countInline.textContent = String(exactCount);
    connectionError.hidden = status !== "connection-error";
  }

  function renderSnapshot(): void {
    records.replaceChildren();
    if (!snapshot) return;
    const summary = summarizeBlacklist(snapshot);
    authorTotal.textContent = String(summary.authorCount);
    tagTotal.textContent = String(summary.tagCount);
    const query = search.value;
    recordsTitle.textContent = query.trim() ? "搜索结果" : "最近屏蔽";
    renderPopupRecordList({
      list: records,
      items: popupResults(snapshot, query),
      queryActive: Boolean(query.trim()),
      writesEnabled,
      onRemove(author, button) {
        void removeAuthor(author, button);
      },
    });
  }

  function clearUndo(): void {
    undoController.clear();
    undoStrip.hidden = true;
    undoButton.disabled = true;
  }

  function showUnreadableStorage(): void {
    refreshController.invalidate();
    snapshot = null;
    writesEnabled = false;
    clearUndo();
    dataMessage.hidden = false;
    dataMessage.textContent = "本地数据无法读取，Cocoon 未进行修改。";
    records.replaceChildren();
    authorTotal.textContent = "—";
    tagTotal.textContent = "—";
  }

  function applySuccessfulSnapshot(next: BlacklistSnapshotDto): void {
    snapshot = next;
    writesEnabled = true;
    dataMessage.hidden = true;
    const pendingUndo = undoController.current();
    if (pendingUndo && !canUndoRemoval(snapshot, writesEnabled, pendingUndo)) clearUndo();
    renderSnapshot();
  }

  const loadSnapshot = async () => loadBlacklistSnapshot(rpc);
  const committedSnapshots = createCommittedSnapshotController(
    applySuccessfulSnapshot,
    loadSnapshot,
  );
  const refreshController = createLatestRefreshController<BlacklistSnapshotDto>({
    load: loadSnapshot,
    apply: committedSnapshots.applyRefresh,
    fail: showUnreadableStorage,
  });

  async function rollbackFailure(storageUnreadable: boolean): Promise<void> {
    showPopupSaveError(saveError);
    if (storageUnreadable) {
      showUnreadableStorage();
      return;
    }
    await refreshController.request();
  }

  async function removeAuthor(
    author: BlacklistAuthorDto,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!writesEnabled) return;
    saveError.hidden = true;
    button.disabled = true;
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!response.ok || !response.data.removed || !response.data.snapshot) {
        await rollbackFailure(response.error === "storage-unreadable");
        return;
      }
      const removed = response.data.removed;
      clearUndo();
      marker(response.data.snapshot, refreshController.invalidate);
      if (!canUndoRemoval(snapshot, writesEnabled, removed)) return;
      undoController.start(removed);
      if (undoController.current() === null) return;
      undoButton.disabled = false;
      undoStrip.hidden = false;
      undoButton.focus();
    } catch {
      await rollbackFailure(false);
    }
  }

  async function restoreRemovedAuthor(): Promise<void> {
    const author = undoController.current();
    if (!author || !writesEnabled) return;
    saveError.hidden = true;
    undoButton.disabled = true;
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.restoreOne(author);
      if (!response.ok || !response.data.snapshot) {
        await rollbackFailure(response.error === "storage-unreadable");
        const pendingUndo = undoController.current();
        if (pendingUndo && canUndoRemoval(snapshot, writesEnabled, pendingUndo)) {
          undoButton.disabled = false;
          undoStrip.hidden = false;
        } else {
          undoButton.disabled = true;
          undoStrip.hidden = true;
        }
        return;
      }
      clearUndo();
      marker(response.data.snapshot, refreshController.invalidate);
      focusPopupSearch(search);
    } catch {
      await rollbackFailure(false);
      const pendingUndo = undoController.current();
      if (pendingUndo && canUndoRemoval(snapshot, writesEnabled, pendingUndo)) {
        undoButton.disabled = false;
        undoStrip.hidden = false;
      } else {
        undoButton.disabled = true;
        undoStrip.hidden = true;
      }
    }
  }

  async function openManagementPage(): Promise<void> {
    saveError.hidden = true;
    try {
      await dependencies.openOptionsPage();
    } catch {
      showPopupSaveError(saveError, "无法打开管理页，请重试。");
    }
  }

  search.addEventListener("input", renderSnapshot);
  undoButton.addEventListener("click", () => {
    void restoreRemovedAuthor();
  });
  manageButton.addEventListener("click", () => {
    void openManagementPage();
  });
  dependencies.storageChanges.addListener((changes, areaName) => {
    if (!parseBlacklistRevisionChange(changes, areaName)) return;
    committedSnapshots.noteRevision();
    void refreshController.request();
  });
  window.addEventListener("pagehide", () => {
    undoController.dispose();
  });

  void initializePopup({
    search,
    rpc,
    refresh: refreshController.request,
    setStatus,
  });
  return {
    refresh: () => refreshController.request(),
    dispose() {
      undoController.dispose();
    },
  };
}
