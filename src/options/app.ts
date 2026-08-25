import {
  MAX_BLACKLIST_TRANSFER_BYTES,
  createBlacklistTransferFilename,
  parseBlacklistTransferJson,
  serializeBlacklistTransfer,
  type BlacklistAuthorDto,
  type BlacklistAuthorIdentityDto,
  type BlacklistSnapshotDto,
  type BlacklistTagDto,
  type BlacklistTransferEnvelope,
} from "../core/blacklist-rpc-contract.ts";
import {
  parseBlacklistRevisionChange,
  type BlacklistChangeEventSource,
} from "../core/blacklist-revision-contract.ts";
import type { BlacklistRpcClient } from "../ui/background-rpc.ts";
import {
  MANAGEMENT_BATCH_SIZE,
  formatLocalTime,
  formatPlatformId,
  formatSource,
  managementResults,
  nextLoadedCount,
  summarizeBlacklist,
  type AuthorListItem,
  type TimeSortDirection,
} from "../ui/blacklist-view-model.ts";
import { createCommittedSnapshotController } from "../ui/committed-snapshot-controller.ts";
import { createLatestRefreshController } from "../ui/latest-refresh-controller.ts";
import { loadBlacklistSnapshot } from "../ui/blacklist-snapshot-loader.ts";
import { createAuthorProfileUrl } from "../ui/zhihu-profile-url.ts";
import { renderAuthorListRows, resetAuthorListViewport } from "./author-list-view.ts";
import { createConfirmationDialogController } from "./dialog-controller.ts";
import { renderTagMaintenanceView } from "./tag-maintenance-view.ts";
import {
  clearTransferError,
  showTransferError,
  transferFailureMessage,
} from "./transfer-feedback.ts";

export interface OptionsAppDependencies {
  readonly document: Document;
  readonly rpc: BlacklistRpcClient;
  readonly storageChanges: BlacklistChangeEventSource;
  readonly requestFrame: (callback: () => void) => number;
  readonly readFileText: (file: File) => Promise<string>;
  readonly downloadJson: (json: string, filename: string) => void;
}

export interface OptionsApp {
  refresh(): Promise<void>;
}

type TagFocusRole = "rename" | "delete";

interface TagFocusDescriptor {
  readonly tagId: string;
  readonly rowIndex: number;
  readonly role: TagFocusRole;
  readonly ariaLabel: string | null;
}

function requiredElement<ElementType extends HTMLElement>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Options element is missing: ${selector}`);
  return element;
}

export function bootstrapOptions(dependencies: OptionsAppDependencies): OptionsApp {
  const { document, rpc } = dependencies;
  const authorTotal = requiredElement<HTMLElement>(document, "#author-total");
  const tagTotal = requiredElement<HTMLElement>(document, "#tag-total");
  const pageMessage = requiredElement<HTMLElement>(document, "#page-message");
  const writeError = requiredElement<HTMLElement>(document, "#write-error");
  const transferPanel = requiredElement<HTMLElement>(document, "#transfer-panel");
  const exportData = requiredElement<HTMLButtonElement>(document, "#export-data");
  const importFile = requiredElement<HTMLInputElement>(document, "#import-file");
  const importMode = requiredElement<HTMLFieldSetElement>(document, "#import-mode");
  const importData = requiredElement<HTMLButtonElement>(document, "#import-data");
  const transferStatus = requiredElement<HTMLElement>(document, "#transfer-status");
  const transferError = requiredElement<HTMLElement>(document, "#transfer-error");
  const authorSearch = requiredElement<HTMLInputElement>(document, "#author-search");
  const tagFilter = requiredElement<HTMLSelectElement>(document, "#tag-filter");
  const platformFilter = requiredElement<HTMLSelectElement>(document, "#platform-filter");
  const timeSort = requiredElement<HTMLSelectElement>(document, "#time-sort");
  const removeSelected = requiredElement<HTMLButtonElement>(document, "#remove-selected");
  const viewport = requiredElement<HTMLElement>(document, "#author-viewport");
  const authorList = requiredElement<HTMLElement>(document, "#author-list");
  const listSummary = requiredElement<HTMLElement>(document, "#list-summary");
  const tagsHeading = requiredElement<HTMLElement>(document, "#tags-heading");
  const tagSummary = requiredElement<HTMLElement>(document, "#tag-summary");
  const tagList = requiredElement<HTMLElement>(document, "#tag-list");

  const dialogController = createConfirmationDialogController({
    dialog: requiredElement<HTMLDialogElement>(document, "#batch-dialog"),
    description: requiredElement<HTMLElement>(document, "#batch-dialog-description"),
    cancel: requiredElement<HTMLButtonElement>(document, "#batch-cancel"),
    confirm: requiredElement<HTMLButtonElement>(document, "#batch-confirm"),
  });
  const replaceDialogController = createConfirmationDialogController({
    dialog: requiredElement<HTMLDialogElement>(document, "#replace-dialog"),
    description: requiredElement<HTMLElement>(document, "#replace-dialog-description"),
    cancel: requiredElement<HTMLButtonElement>(document, "#replace-cancel"),
    confirm: requiredElement<HTMLButtonElement>(document, "#replace-confirm"),
  });

  let snapshot: BlacklistSnapshotDto | null = null;
  let writesEnabled = false;
  let loadedCount = MANAGEMENT_BATCH_SIZE;
  let filteredItems: readonly AuthorListItem[] = [];
  let renderFrame: number | null = null;
  let selectedTagId: string | null = null;
  let selectedPlatformId: string | null = null;
  let transfer: BlacklistTransferEnvelope | null = null;
  let transferPending = false;
  let fileReadSequence = 0;
  const selectedIdentities = new Map<string, BlacklistAuthorIdentityDto>();
  const tagIdByFilterToken = new Map<string, string>();
  const platformIdByFilterToken = new Map<string, string>();
  const pendingTagIds = new Set<string>();

  function writesAvailable(): boolean {
    return writesEnabled && !transferPending;
  }

  function updateBatchAction(): void {
    removeSelected.textContent = `解除所选（${selectedIdentities.size}）`;
    removeSelected.disabled = !writesEnabled || selectedIdentities.size === 0;
  }

  function updateTransferControls(): void {
    exportData.disabled = !writesEnabled || transferPending;
    importFile.disabled = !writesEnabled || transferPending;
    importMode.disabled = !writesEnabled || transferPending;
    importData.disabled = !writesEnabled || transferPending || transfer === null;
    if (transferPending) transferPanel.setAttribute("aria-busy", "true");
    else transferPanel.removeAttribute("aria-busy");
  }

  function showWriteError(message = "更改未保存，请重试。"): void {
    writeError.textContent = message;
    writeError.hidden = false;
  }

  function clearWriteError(): void {
    writeError.hidden = true;
  }

  function reflectTagPendingState(tagId: string, pending: boolean): void {
    const row = Array.from(tagList.querySelectorAll<HTMLElement>(".tag-row")).find(
      (candidate) => candidate.dataset.tagId === tagId,
    );
    if (!row) return;
    row.classList.toggle("tag-pending", pending);
    if (pending) row.setAttribute("aria-busy", "true");
    else row.removeAttribute("aria-busy");
    for (const control of row.querySelectorAll<HTMLButtonElement>("button")) {
      if (pending) control.setAttribute("aria-disabled", "true");
      else control.removeAttribute("aria-disabled");
    }
    const input = row.querySelector<HTMLInputElement>("input");
    if (input) input.readOnly = pending;
  }

  function beginTagMutation(tagId: string): boolean {
    if (pendingTagIds.has(tagId)) return false;
    pendingTagIds.add(tagId);
    reflectTagPendingState(tagId, true);
    return true;
  }

  function endTagMutation(tagId: string): void {
    pendingTagIds.delete(tagId);
    reflectTagPendingState(tagId, false);
  }

  function createAuthorRow(item: AuthorListItem): HTMLElement {
    const { author, tag } = item;
    const row = document.createElement("div");
    row.className = "author-row";
    row.setAttribute("role", "listitem");
    const selection = document.createElement("input");
    const identity = {
      platformId: author.platformId,
      userId: author.userId,
    };
    const key = JSON.stringify([identity.platformId, identity.userId]);
    selection.type = "checkbox";
    selection.checked = selectedIdentities.has(key);
    selection.setAttribute("aria-label", `选择 ${author.authorName || "未知作者"}`);
    selection.disabled = !writesEnabled;
    selection.addEventListener("change", () => {
      if (selection.checked) selectedIdentities.set(key, identity);
      else selectedIdentities.delete(key);
      updateBatchAction();
    });
    const profileUrl = createAuthorProfileUrl(author.platformId, author.userId);
    const name = profileUrl ? document.createElement("a") : document.createElement("span");
    name.className = "author-name";
    name.textContent = author.authorName || "未知作者";
    if (name instanceof document.defaultView!.HTMLAnchorElement) {
      name.href = profileUrl!;
      name.target = "_blank";
      name.rel = "noopener";
    }
    const tagName = document.createElement("span");
    tagName.className = "tag-name";
    tagName.textContent = tag.name;
    const platform = document.createElement("span");
    platform.className = "platform-name";
    platform.textContent = formatPlatformId(author.platformId);
    const source = document.createElement("span");
    source.className = "source-name";
    source.textContent = formatSource(author.source);
    const time = document.createElement("time");
    time.textContent = formatLocalTime(author.blacklistedAt);
    if (author.blacklistedAt) time.dateTime = author.blacklistedAt;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-text";
    remove.textContent = "解除屏蔽";
    remove.setAttribute("aria-label", `解除屏蔽 ${author.authorName || "未知作者"}`);
    remove.disabled = !writesEnabled;
    remove.addEventListener("click", () => {
      void removeOne(author, remove);
    });
    row.append(selection, name, tagName, platform, source, time, remove);
    return row;
  }

  function renderAuthors(): void {
    renderFrame = null;
    if (!snapshot) {
      authorList.replaceChildren();
      filteredItems = [];
      listSummary.textContent = "";
      return;
    }
    filteredItems = managementResults(
      snapshot,
      authorSearch.value,
      selectedTagId,
      selectedPlatformId,
      timeSort.value as TimeSortDirection,
    );
    const rendered = renderAuthorListRows({
      list: authorList,
      items: filteredItems,
      loadedCount,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.clientHeight,
      createRow: createAuthorRow,
      focusFallback: viewport,
    });
    listSummary.textContent =
      rendered.loadedCount < filteredItems.length
        ? `已载入 ${rendered.loadedCount} / ${filteredItems.length} 位作者`
        : `共 ${filteredItems.length} 位作者`;
  }

  function scheduleAuthorRender(): void {
    if (renderFrame !== null) return;
    renderFrame = dependencies.requestFrame(renderAuthors);
  }

  function resetAuthorList(): void {
    loadedCount = resetAuthorListViewport(viewport);
    selectedIdentities.clear();
    updateBatchAction();
    renderAuthors();
  }

  function renderTagFilter(): void {
    tagIdByFilterToken.clear();
    const allTags = document.createElement("option");
    allTags.value = "";
    allTags.textContent = "全部标签";
    tagFilter.replaceChildren(allTags);
    if (!snapshot) return;
    if (!snapshot.tags.some((tag) => tag.tagId === selectedTagId)) {
      selectedTagId = null;
    }
    let selectedToken = "";
    snapshot.tags.forEach((tag, index) => {
      const token = `tag-filter-${index + 1}`;
      tagIdByFilterToken.set(token, tag.tagId);
      const option = document.createElement("option");
      option.value = token;
      option.textContent = tag.name;
      tagFilter.add(option);
      if (tag.tagId === selectedTagId) selectedToken = token;
    });
    tagFilter.value = selectedToken;
  }

  function renderPlatformFilter(): void {
    platformIdByFilterToken.clear();
    const allPlatforms = document.createElement("option");
    allPlatforms.value = "";
    allPlatforms.textContent = "全部站点";
    platformFilter.replaceChildren(allPlatforms);
    if (!snapshot) return;
    const platformIds = [...new Set(snapshot.authors.map((author) => author.platformId))].sort(
      (left, right) =>
        formatPlatformId(left).localeCompare(formatPlatformId(right), "zh-CN") ||
        left.localeCompare(right),
    );
    if (!platformIds.includes(selectedPlatformId ?? "")) {
      selectedPlatformId = null;
    }
    let selectedToken = "";
    platformIds.forEach((platformId, index) => {
      const token = `platform-filter-${index + 1}`;
      platformIdByFilterToken.set(token, platformId);
      const option = document.createElement("option");
      option.value = token;
      option.textContent = formatPlatformId(platformId);
      platformFilter.add(option);
      if (platformId === selectedPlatformId) selectedToken = token;
    });
    platformFilter.value = selectedToken;
  }

  function captureTagFocus(): TagFocusDescriptor | null {
    const active = document.activeElement;
    if (!active || !tagList.contains(active)) return null;
    const row = active.closest<HTMLElement>(".tag-row");
    if (!row?.dataset.tagId) return null;
    const rows = Array.from(tagList.querySelectorAll<HTMLElement>(".tag-row"));
    return {
      tagId: row.dataset.tagId,
      rowIndex: Math.max(0, rows.indexOf(row)),
      role: active.matches(".tag-delete") ? "delete" : "rename",
      ariaLabel: active.getAttribute("aria-label"),
    };
  }

  function restoreTagFocus(descriptor: TagFocusDescriptor | null): void {
    if (!descriptor) return;
    const buttons = Array.from(tagList.querySelectorAll<HTMLButtonElement>("button"));
    const exact = descriptor.ariaLabel
      ? buttons.find((button) => button.getAttribute("aria-label") === descriptor.ariaLabel)
      : undefined;
    const rows = Array.from(tagList.querySelectorAll<HTMLElement>(".tag-row"));
    const sameTag = rows.find((row) => row.dataset.tagId === descriptor.tagId);
    const fallbackRow =
      sameTag ?? rows[Math.min(descriptor.rowIndex, Math.max(0, rows.length - 1))];
    const roleSelector =
      descriptor.role === "delete" ? ".tag-delete" : "button[aria-label^='重命名标签 ']";
    const equivalent = fallbackRow?.querySelector<HTMLButtonElement>(roleSelector);
    (exact ?? equivalent ?? (writeError.hidden ? tagsHeading : writeError)).focus();
  }

  function renderTags(): void {
    const focus = captureTagFocus();
    if (!snapshot) {
      tagSummary.textContent = "— 个自定义标签";
      tagList.replaceChildren();
      restoreTagFocus(focus);
      return;
    }
    renderTagMaintenanceView({
      container: tagList,
      summary: tagSummary,
      tags: snapshot.tags,
      authors: snapshot.authors,
      writesEnabled,
      pendingTagIds,
      onRename(tag, name, button) {
        void renameTag(tag, name, button);
      },
      onDelete(tag, button) {
        void deleteTag(tag, button);
      },
    });
    restoreTagFocus(focus);
  }

  function applySuccessfulSnapshot(next: BlacklistSnapshotDto): void {
    snapshot = next;
    writesEnabled = true;
    selectedIdentities.clear();
    pageMessage.hidden = true;
    const summary = summarizeBlacklist(next);
    authorTotal.textContent = String(summary.authorCount);
    tagTotal.textContent = String(summary.tagCount);
    renderTagFilter();
    renderPlatformFilter();
    renderTags();
    resetAuthorList();
    updateTransferControls();
  }

  function showUnreadableStorage(): void {
    refreshController.invalidate();
    snapshot = null;
    writesEnabled = false;
    selectedIdentities.clear();
    pageMessage.hidden = false;
    pageMessage.textContent = "本地数据无法读取，Cocoon 未进行修改。";
    authorTotal.textContent = "—";
    tagTotal.textContent = "—";
    renderTagFilter();
    renderPlatformFilter();
    renderTags();
    renderAuthors();
    updateBatchAction();
    updateTransferControls();
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

  async function finishMutationFailure(
    storageUnreadable: boolean,
    message?: string,
  ): Promise<void> {
    showWriteError(message);
    if (storageUnreadable) {
      showUnreadableStorage();
      return;
    }
    await refreshController.request();
  }

  function setTransferPending(pending: boolean): void {
    transferPending = pending;
    updateTransferControls();
  }

  async function exportTransfer(): Promise<void> {
    if (!writesAvailable()) return;
    clearTransferError(transferError);
    transferStatus.textContent = "正在准备导出…";
    setTransferPending(true);
    try {
      const response = await rpc.request("export-json");
      const exported = response.data.transfer;
      if (!response.ok || !exported) {
        transferStatus.textContent = "未导出数据。";
        if (response.error === "storage-unreadable") {
          showUnreadableStorage();
        }
        showTransferError(
          transferError,
          response.error === "storage-unreadable"
            ? "本地数据无法读取，Cocoon 未进行修改。"
            : response.error === "transfer-too-large"
              ? "导出数据超过 8 MiB 限制。"
              : "无法导出本地数据，请重试。",
        );
        return;
      }
      const json = serializeBlacklistTransfer(exported);
      const filename = createBlacklistTransferFilename(exported.exportedAt);
      if (!json || !filename) {
        transferStatus.textContent = "未导出数据。";
        showTransferError(transferError, "无法导出本地数据，请重试。");
        return;
      }
      dependencies.downloadJson(json, filename);
      transferStatus.textContent = `已导出 ${exported.authors.length} 位作者和 ${exported.tags.length} 个标签。`;
      transferStatus.focus();
    } catch {
      transferStatus.textContent = "未导出数据。";
      showTransferError(transferError, "无法导出本地数据，请重试。");
    } finally {
      setTransferPending(false);
    }
  }

  async function importTransfer(operation: "import-merge" | "import-replace"): Promise<void> {
    const selectedTransfer = transfer;
    if (!writesAvailable() || !selectedTransfer) return;
    clearTransferError(transferError);
    clearWriteError();
    transferStatus.textContent =
      operation === "import-merge" ? "正在合并导入…" : "正在替换本地记录…";
    setTransferPending(true);
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.request(operation, {
        transfer: selectedTransfer,
      });
      if (!response.ok || !response.data.snapshot) {
        transferStatus.textContent = "未导入数据。";
        if (response.error === "storage-unreadable") {
          showUnreadableStorage();
        } else {
          await refreshController.request();
        }
        showTransferError(transferError, transferFailureMessage(response.error));
        return;
      }
      marker(response.data.snapshot, refreshController.invalidate);
      transfer = null;
      importFile.value = "";
      transferStatus.textContent =
        operation === "import-merge"
          ? `合并完成；文件包含 ${selectedTransfer.authors.length} 位作者和 ${selectedTransfer.tags.length} 个标签。`
          : `已替换为 ${selectedTransfer.authors.length} 位作者和 ${selectedTransfer.tags.length} 个标签。`;
      transferStatus.focus();
    } catch {
      transferStatus.textContent = "未导入数据。";
      await refreshController.request();
      showTransferError(transferError, "导入未保存，请重试。");
    } finally {
      setTransferPending(false);
    }
  }

  async function readSelectedTransferFile(): Promise<void> {
    const sequence = ++fileReadSequence;
    const file = importFile.files?.[0] ?? null;
    transfer = null;
    clearTransferError(transferError);
    if (!file) {
      transferStatus.textContent = "请选择 Cocoon 导出的 JSON 文件。";
      updateTransferControls();
      return;
    }
    if (file.size > MAX_BLACKLIST_TRANSFER_BYTES) {
      transferStatus.textContent = "未选择可导入的数据。";
      showTransferError(transferError, "导入文件超过 8 MiB 限制。");
      updateTransferControls();
      return;
    }

    setTransferPending(true);
    transferStatus.textContent = "正在校验导入文件…";
    try {
      const json = await dependencies.readFileText(file);
      if (sequence !== fileReadSequence) return;
      const parsed = parseBlacklistTransferJson(json);
      if (parsed.status !== "valid") {
        transferStatus.textContent = "未选择可导入的数据。";
        showTransferError(
          transferError,
          parsed.status === "too-large"
            ? "导入文件超过 8 MiB 限制。"
            : "导入文件无效或格式不受支持。",
        );
        return;
      }
      transfer = parsed.transfer;
      transferStatus.textContent = `已校验 ${transfer.authors.length} 位作者和 ${transfer.tags.length} 个标签。`;
    } catch {
      if (sequence !== fileReadSequence) return;
      transferStatus.textContent = "未选择可导入的数据。";
      showTransferError(transferError, "无法读取导入文件，请重新选择。");
    } finally {
      if (sequence === fileReadSequence) {
        setTransferPending(false);
      }
    }
  }

  function requestImport(): void {
    if (!writesAvailable() || !transfer) return;
    const mode = document.querySelector<HTMLInputElement>(
      "input[name='import-mode']:checked",
    )?.value;
    if (mode !== "replace") {
      void importTransfer("import-merge");
      return;
    }
    const selectedTransfer = transfer;
    replaceDialogController.openWithDescription(
      `将用文件中的 ${selectedTransfer.authors.length} 位作者和 ${selectedTransfer.tags.length} 个标签替换当前列表。现有设置会保留。`,
      importData,
      () => {
        if (transfer === selectedTransfer) {
          void importTransfer("import-replace");
        }
      },
    );
  }

  async function removeOne(author: BlacklistAuthorDto, button: HTMLButtonElement): Promise<void> {
    if (!writesEnabled) return;
    clearWriteError();
    button.disabled = true;
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!response.ok || !response.data.snapshot) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      marker(response.data.snapshot, refreshController.invalidate);
      authorSearch.focus();
    } catch {
      await finishMutationFailure(false);
    }
  }

  async function removeMany(identities: readonly BlacklistAuthorIdentityDto[]): Promise<void> {
    if (!writesEnabled) return;
    clearWriteError();
    removeSelected.disabled = true;
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.request("remove-many", { identities });
      if (!response.ok || !response.data.snapshot) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      marker(response.data.snapshot, refreshController.invalidate);
      removeSelected.focus();
    } catch {
      await finishMutationFailure(false);
    }
  }

  async function renameTag(
    tag: BlacklistTagDto,
    name: string,
    _button: HTMLButtonElement,
  ): Promise<void> {
    if (!writesEnabled || !beginTagMutation(tag.tagId)) return;
    clearWriteError();
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.request("rename-tag", { tagId: tag.tagId, name });
      if (!response.ok || !response.data.snapshot) {
        await finishMutationFailure(
          response.error === "storage-unreadable",
          response.error === "invalid-tag" ? "标签名称无效或已存在。" : undefined,
        );
        return;
      }
      marker(response.data.snapshot, refreshController.invalidate);
    } catch {
      await finishMutationFailure(false);
    } finally {
      endTagMutation(tag.tagId);
    }
  }

  async function deleteTag(tag: BlacklistTagDto, _button: HTMLButtonElement): Promise<void> {
    if (!writesEnabled || !beginTagMutation(tag.tagId)) return;
    clearWriteError();
    const marker = committedSnapshots.beginMutation();
    try {
      const response = await rpc.request("delete-tag", { tagId: tag.tagId });
      if (!response.ok || !response.data.snapshot) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      marker(response.data.snapshot, refreshController.invalidate);
    } catch {
      await finishMutationFailure(false);
    } finally {
      endTagMutation(tag.tagId);
    }
  }

  authorSearch.addEventListener("input", resetAuthorList);
  tagFilter.addEventListener("change", () => {
    selectedTagId = tagIdByFilterToken.get(tagFilter.value) ?? null;
    resetAuthorList();
  });
  platformFilter.addEventListener("change", () => {
    selectedPlatformId = platformIdByFilterToken.get(platformFilter.value) ?? null;
    resetAuthorList();
  });
  timeSort.addEventListener("change", resetAuthorList);
  viewport.addEventListener("scroll", () => {
    const nearEnd = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 128;
    if (nearEnd && loadedCount < filteredItems.length) {
      loadedCount = nextLoadedCount(loadedCount, filteredItems.length);
    }
    scheduleAuthorRender();
  });
  removeSelected.addEventListener("click", () => {
    const identities = [...selectedIdentities.values()];
    dialogController.open(identities.length, removeSelected, () => {
      void removeMany(identities);
    });
  });
  exportData.addEventListener("click", () => {
    void exportTransfer();
  });
  importFile.addEventListener("change", () => {
    void readSelectedTransferFile();
  });
  importData.addEventListener("click", requestImport);
  dependencies.storageChanges.addListener((changes, areaName) => {
    if (!parseBlacklistRevisionChange(changes, areaName)) return;
    committedSnapshots.noteRevision();
    void refreshController.request();
  });

  void refreshController.request();
  return { refresh: () => refreshController.request() };
}
