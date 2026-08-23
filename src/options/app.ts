import {
  type BlacklistAuthorDto,
  type BlacklistAuthorIdentityDto,
  type BlacklistSnapshotDto,
  type BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";
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
import { createLatestRefreshController } from "../ui/latest-refresh-controller.ts";
import { createAuthorProfileUrl } from "../ui/zhihu-profile-url.ts";
import { renderAuthorListRows, resetAuthorListViewport } from "./author-list-view.ts";
import { createConfirmationDialogController } from "./dialog-controller.ts";
import { renderTagMaintenanceView } from "./tag-maintenance-view.ts";

interface ChangeEventSource {
  addListener(
    listener: (changes: Record<string, unknown>, areaName: string) => void,
  ): void;
}

export interface OptionsAppDependencies {
  readonly document: Document;
  readonly rpc: BlacklistRpcClient;
  readonly storageChanges: ChangeEventSource;
  readonly requestFrame: (callback: () => void) => number;
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

  let snapshot: BlacklistSnapshotDto | null = null;
  let writesEnabled = false;
  let loadedCount = MANAGEMENT_BATCH_SIZE;
  let filteredItems: readonly AuthorListItem[] = [];
  let renderFrame: number | null = null;
  let selectedTagId: string | null = null;
  let selectedPlatformId: string | null = null;
  const selectedIdentities = new Map<string, BlacklistAuthorIdentityDto>();
  const tagIdByFilterToken = new Map<string, string>();
  const platformIdByFilterToken = new Map<string, string>();
  const pendingTagIds = new Set<string>();

  function identityKey(identity: BlacklistAuthorIdentityDto): string {
    return JSON.stringify([identity.platformId, identity.userId]);
  }

  function updateBatchAction(): void {
    removeSelected.textContent = `解除所选（${selectedIdentities.size}）`;
    removeSelected.disabled = !writesEnabled || selectedIdentities.size === 0;
  }

  function showWriteError(message = "更改未保存，请重试。"): void {
    writeError.textContent = message;
    writeError.hidden = false;
  }

  function clearWriteError(): void { writeError.hidden = true; }

  function reflectTagPendingState(tagId: string, pending: boolean): void {
    const row = Array.from(tagList.querySelectorAll<HTMLElement>(".tag-row"))
      .find((candidate) => candidate.dataset.tagId === tagId);
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
    const key = identityKey(identity);
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
    const name = profileUrl
      ? document.createElement("a")
      : document.createElement("span");
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
    remove.addEventListener("click", () => { void removeOne(author, remove); });
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
    listSummary.textContent = rendered.loadedCount < filteredItems.length
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
    const platformIds = [...new Set(snapshot.authors.map((author) => author.platformId))]
      .sort((left, right) =>
        formatPlatformId(left).localeCompare(formatPlatformId(right), "zh-CN") ||
        left.localeCompare(right)
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
      ? buttons.find((button) =>
        button.getAttribute("aria-label") === descriptor.ariaLabel
      )
      : undefined;
    const rows = Array.from(tagList.querySelectorAll<HTMLElement>(".tag-row"));
    const sameTag = rows.find((row) => row.dataset.tagId === descriptor.tagId);
    const fallbackRow = sameTag ?? rows[
      Math.min(descriptor.rowIndex, Math.max(0, rows.length - 1))
    ];
    const roleSelector = descriptor.role === "delete"
      ? ".tag-delete"
      : "button[aria-label^='重命名标签 ']";
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
      onRename(tag, name, button) { void renameTag(tag, name, button); },
      onDelete(tag, button) { void deleteTag(tag, button); },
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
  }

  const refreshController = createLatestRefreshController<BlacklistSnapshotDto>({
    async load() {
      const response = await rpc.request("snapshot");
      if (!response.ok || !response.data.snapshot) throw new Error("snapshot unavailable");
      return response.data.snapshot;
    },
    apply: applySuccessfulSnapshot,
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

  async function removeOne(author: BlacklistAuthorDto, button: HTMLButtonElement): Promise<void> {
    if (!writesEnabled) return;
    clearWriteError();
    button.disabled = true;
    try {
      const response = await rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!response.ok) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      await refreshController.request();
      if (writesEnabled) authorSearch.focus();
    } catch {
      await finishMutationFailure(false);
    }
  }

  async function removeMany(
    identities: readonly BlacklistAuthorIdentityDto[],
  ): Promise<void> {
    if (!writesEnabled) return;
    clearWriteError();
    removeSelected.disabled = true;
    try {
      const response = await rpc.request("remove-many", { identities });
      if (!response.ok) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      await refreshController.request();
      if (writesEnabled) removeSelected.focus();
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
    try {
      const response = await rpc.request("rename-tag", { tagId: tag.tagId, name });
      if (!response.ok) {
        await finishMutationFailure(
          response.error === "storage-unreadable",
          response.error === "invalid-tag" ? "标签名称无效或已存在。" : undefined,
        );
        return;
      }
      await refreshController.request();
    } catch {
      await finishMutationFailure(false);
    } finally {
      endTagMutation(tag.tagId);
    }
  }

  async function deleteTag(tag: BlacklistTagDto, _button: HTMLButtonElement): Promise<void> {
    if (!writesEnabled || !beginTagMutation(tag.tagId)) return;
    clearWriteError();
    try {
      const response = await rpc.request("delete-tag", { tagId: tag.tagId });
      if (!response.ok) {
        await finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      await refreshController.request();
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
  dependencies.storageChanges.addListener((changes, areaName) => {
    if (areaName === "local" && "cocoonBlacklistState" in changes) {
      void refreshController.request();
    }
  });

  void refreshController.request();
  return { refresh: () => refreshController.request() };
}
