import type {
  BlacklistAuthorDto,
  BlacklistSnapshotDto,
  CurrentPageStatus,
} from "../core/blacklist-rpc-contract.ts";
import type { BlacklistRpcClient } from "../ui/background-rpc.ts";
import { popupResults, summarizeBlacklist } from "../ui/blacklist-view-model.ts";
import { createLatestRefreshController } from "../ui/latest-refresh-controller.ts";
import { createPopupUndoController } from "./undo-controller.ts";
import { focusPopupSearch, renderPopupRecordList } from "./record-list-view.ts";

interface ChangeEventSource {
  addListener(
    listener: (changes: Record<string, unknown>, areaName: string) => void,
  ): void;
}

export interface PopupAppDependencies {
  readonly document: Document;
  readonly window: Window;
  readonly rpc: BlacklistRpcClient;
  readonly storageChanges: ChangeEventSource;
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

  function isUndoEligible(author: BlacklistAuthorDto): boolean {
    if (!writesEnabled || !snapshot) return false;
    if (!snapshot.tags.some((tag) => tag.tagId === author.tagId)) return false;
    const removedIdentifiers = new Set(
      [author.userId, author.memberHashId].filter((value): value is string => value !== null),
    );
    return !snapshot.authors.some((candidate) =>
      candidate.platformId === author.platformId &&
      (removedIdentifiers.has(candidate.userId) ||
        (candidate.memberHashId !== null &&
          removedIdentifiers.has(candidate.memberHashId)))
    );
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
      onRemove(author, button) { void removeAuthor(author, button); },
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

  const refreshController = createLatestRefreshController<BlacklistSnapshotDto>({
    async load() {
      const response = await rpc.request("snapshot");
      if (!response.ok || !response.data.snapshot) {
        throw new Error("snapshot unavailable");
      }
      return response.data.snapshot;
    },
    apply(next) {
      snapshot = next;
      writesEnabled = true;
      dataMessage.hidden = true;
      const pendingUndo = undoController.current();
      if (pendingUndo && !isUndoEligible(pendingUndo)) clearUndo();
      renderSnapshot();
    },
    fail: showUnreadableStorage,
  });

  function showSaveError(message = "更改未保存，请重试。"): void {
    saveError.textContent = message;
    saveError.hidden = false;
  }

  async function rollbackFailure(storageUnreadable: boolean): Promise<void> {
    showSaveError();
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
    try {
      const response = await rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!response.ok || !response.data.removed) {
        await rollbackFailure(response.error === "storage-unreadable");
        return;
      }
      const removed = response.data.removed;
      clearUndo();
      await refreshController.request();
      if (!isUndoEligible(removed)) return;
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
    try {
      const response = await rpc.restoreOne(author);
      if (!response.ok) {
        await rollbackFailure(response.error === "storage-unreadable");
        const pendingUndo = undoController.current();
        if (pendingUndo && isUndoEligible(pendingUndo)) {
          undoButton.disabled = false;
          undoStrip.hidden = false;
        } else {
          undoButton.disabled = true;
          undoStrip.hidden = true;
        }
        return;
      }
      clearUndo();
      await refreshController.request();
      if (writesEnabled) focusPopupSearch(search);
    } catch {
      await rollbackFailure(false);
      const pendingUndo = undoController.current();
      if (pendingUndo && isUndoEligible(pendingUndo)) {
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
      showSaveError("无法打开管理页，请重试。");
    }
  }

  async function initialize(): Promise<void> {
    focusPopupSearch(search);
    const statusPromise = rpc.request("status");
    const snapshotPromise = refreshController.request();
    try {
      const response = await statusPromise;
      if (response.ok && response.data.status && response.data.count !== null) {
        setStatus(response.data.status, response.data.count);
      } else {
        setStatus("connection-error", 0);
      }
    } catch {
      setStatus("connection-error", 0);
    }
    await snapshotPromise;
  }

  search.addEventListener("input", renderSnapshot);
  undoButton.addEventListener("click", () => { void restoreRemovedAuthor(); });
  manageButton.addEventListener("click", () => { void openManagementPage(); });
  dependencies.storageChanges.addListener((changes, areaName) => {
    if (areaName === "local" && "cocoonBlacklistState" in changes) {
      void refreshController.request();
    }
  });
  window.addEventListener("pagehide", () => { undoController.dispose(); });

  void initialize();
  return {
    refresh: () => refreshController.request(),
    dispose() { undoController.dispose(); },
  };
}
