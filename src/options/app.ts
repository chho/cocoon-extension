import type {
  BlacklistSummaryDto,
  BlacklistTagUsageDto,
} from "../core/blacklist-query-rpc-contract.ts";
import type {
  BlacklistAuthorDto,
  BlacklistAuthorIdentityDto,
  BlacklistRpcResponse,
  BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";
import {
  parseBlacklistRevisionChange,
  type BlacklistChangeEventSource,
} from "../core/blacklist-revision-contract.ts";
import type { StrictBlacklistRpcClient } from "../ui/background-rpc.ts";
import type { BlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import type { AuthorListItem, TimeSortDirection } from "../ui/blacklist-list-values.ts";
import { renderAuthorListRows, resetAuthorListViewport } from "./author-list-view.ts";
import { createConfirmationDialogController } from "./dialog-controller.ts";
import {
  renderOptionsPlatformFilter,
  renderOptionsTagFilter,
  resolveOptionsElements,
  requiredOptionsElement,
  type OptionsElements,
} from "./options-app-view.ts";
import { createOptionsAuthorRow } from "./options-author-row.ts";
import { createOptionsSelectionController } from "./options-selection-controller.ts";
import {
  applyDeletedTagState,
  applyRemovedAuthorState,
  applyRenamedTagState,
  deletedTagCount,
  mutationSummary,
  removedAuthorMatches,
} from "./options-mutation-state.ts";
import type { OptionsAuthorQuery, OptionsBoundedState } from "./options-query-client.ts";
import {
  createOptionsQueryCoordinator,
  optionsIdentityKey,
  type OptionsAuthorResults,
  type OptionsQueryCoordinator,
} from "./options-query-coordinator.ts";
import {
  captureTagMaintenanceFocus,
  renderTagMaintenanceView,
  restoreTagMaintenanceFocus,
} from "./tag-maintenance-view.ts";
import {
  createOptionsTransferUiController,
  type OptionsTransferUiController,
} from "./transfer-ui-controller.ts";

export interface OptionsAppDependencies {
  readonly document: Document;
  readonly rpc: StrictBlacklistRpcClient;
  readonly transferRpc: BlacklistTransferRpcClient;
  readonly storageChanges: BlacklistChangeEventSource;
  readonly requestFrame: (callback: () => void) => number;
  readonly readFileText: (file: File) => Promise<string>;
  readonly downloadJson: (parts: readonly BlobPart[], filename: string) => void;
}

export interface OptionsApp {
  refresh(): Promise<void>;
}

class OptionsApplication implements OptionsApp {
  private readonly dependencies: OptionsAppDependencies;
  private readonly elements: OptionsElements;
  private readonly queryCoordinator: OptionsQueryCoordinator;
  private readonly transferController: OptionsTransferUiController;
  private readonly selectionController;
  private readonly dialogController;
  private summary: BlacklistSummaryDto | null = null;
  private tags: readonly BlacklistTagUsageDto[] = [];
  private platforms: readonly string[] = [];
  private authorItems: readonly AuthorListItem[] = [];
  private authorTotalCount = 0;
  private writesEnabled = false;
  private renderFrame: number | null = null;
  private selectedTagId: string | null = null;
  private selectedPlatformId: string | null = null;
  private readonly tagIdByFilterToken = new Map<string, string>();
  private readonly platformIdByFilterToken = new Map<string, string>();
  private readonly pendingTagIds = new Set<string>();

  constructor(dependencies: OptionsAppDependencies) {
    const { document, rpc } = dependencies;
    this.dependencies = dependencies;
    this.elements = resolveOptionsElements(document);
    this.selectionController = createOptionsSelectionController({
      action: this.elements.removeSelected,
      onLimitReached: (limit) => {
        this.showWriteError(`一次最多选择 ${limit} 位作者。`);
        this.elements.writeError.focus();
      },
    });
    this.dialogController = createConfirmationDialogController({
      dialog: requiredOptionsElement(document, "#batch-dialog"),
      description: requiredOptionsElement(document, "#batch-dialog-description"),
      cancel: requiredOptionsElement(document, "#batch-cancel"),
      confirm: requiredOptionsElement(document, "#batch-confirm"),
    });
    this.queryCoordinator = createOptionsQueryCoordinator(rpc, {
      currentQuery: () => this.currentAuthorQuery(),
      applyFacets: (state) => this.applyBoundedFacets(state),
      applyAuthors: (results) => this.applyAuthorResults(results),
      clearAuthors: () => this.clearAuthorResults(),
      fail: () => this.showUnreadableStorage(),
    });
    this.transferController = createOptionsTransferUiController({
      document,
      rpc: dependencies.transferRpc,
      readFileText: dependencies.readFileText,
      downloadJson: dependencies.downloadJson,
      reloadBounded: () => this.reloadBoundedForTransfer(),
      showUnreadableStorage: () => this.showUnreadableStorage(),
    });
    this.bindEvents();
    void this.refresh();
  }
  refresh(): Promise<void> {
    return this.queryCoordinator.refresh();
  }
  private currentAuthorQuery(): OptionsAuthorQuery {
    return {
      search: this.elements.authorSearch.value.trim(),
      tagId: this.selectedTagId,
      platformId: this.selectedPlatformId,
      direction: this.elements.timeSort.value as TimeSortDirection,
    };
  }
  private showWriteError(message = "更改未保存，请重试。"): void {
    this.elements.writeError.textContent = message;
    this.elements.writeError.hidden = false;
  }
  private clearWriteError(): void {
    this.elements.writeError.hidden = true;
  }
  private reflectTagPendingState(tagId: string, pending: boolean): void {
    const row = Array.from(this.elements.tagList.querySelectorAll<HTMLElement>(".tag-row")).find(
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
  private beginTagMutation(tagId: string): boolean {
    if (this.pendingTagIds.has(tagId)) return false;
    this.pendingTagIds.add(tagId);
    this.reflectTagPendingState(tagId, true);
    return true;
  }
  private endTagMutation(tagId: string): void {
    this.pendingTagIds.delete(tagId);
    this.reflectTagPendingState(tagId, false);
  }
  private createAuthorRow(item: AuthorListItem): HTMLElement {
    const identity = { platformId: item.author.platformId, userId: item.author.userId };
    const key = optionsIdentityKey(identity);
    return createOptionsAuthorRow({
      document: this.dependencies.document,
      item,
      writesEnabled: this.writesEnabled,
      selected: this.selectionController.has(key),
      onSelectionChange: (nextIdentity, selected) =>
        this.selectionController.change(key, nextIdentity, selected),
      onRemove: (author, button) => {
        void this.removeOne(author, button);
      },
    });
  }
  private renderAuthors(): void {
    this.renderFrame = null;
    if (!this.summary) {
      this.elements.authorList.replaceChildren();
      this.elements.listSummary.textContent = "";
      return;
    }
    const rendered = renderAuthorListRows({
      list: this.elements.authorList,
      items: this.authorItems,
      loadedCount: this.authorItems.length,
      candidateCount: this.authorTotalCount,
      scrollTop: this.elements.viewport.scrollTop,
      viewportHeight: this.elements.viewport.clientHeight,
      createRow: (item) => this.createAuthorRow(item),
      focusFallback: this.elements.viewport,
    });
    this.elements.listSummary.textContent =
      rendered.loadedCount < this.authorTotalCount
        ? `已载入 ${rendered.loadedCount} / ${this.authorTotalCount} 位作者`
        : `共 ${this.authorTotalCount} 位作者`;
  }
  private scheduleAuthorRender(): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = this.dependencies.requestFrame(() => this.renderAuthors());
  }
  private clearAuthorResults(): void {
    resetAuthorListViewport(this.elements.viewport);
    this.authorItems = [];
    this.authorTotalCount = 0;
    this.selectionController.clear();
    this.renderAuthors();
  }
  private applyAuthorResults(results: OptionsAuthorResults): void {
    this.authorItems = results.items;
    this.authorTotalCount = results.totalCount;
    this.renderAuthors();
  }
  private renderTagFilter(): void {
    this.selectedTagId = renderOptionsTagFilter({
      document: this.dependencies.document,
      select: this.elements.tagFilter,
      tags: this.tags,
      selectedTagId: this.selectedTagId,
      tokens: this.tagIdByFilterToken,
    });
  }
  private renderPlatformFilter(): void {
    this.selectedPlatformId = renderOptionsPlatformFilter({
      document: this.dependencies.document,
      select: this.elements.platformFilter,
      platforms: this.platforms,
      selectedPlatformId: this.selectedPlatformId,
      tokens: this.platformIdByFilterToken,
    });
  }
  private renderTags(): void {
    const focus = captureTagMaintenanceFocus(this.dependencies.document, this.elements.tagList);
    const focusFallback = this.elements.writeError.hidden
      ? this.elements.tagsHeading
      : this.elements.writeError;
    if (!this.summary) {
      this.elements.tagSummary.textContent = "— 个自定义标签";
      this.elements.tagList.replaceChildren();
      restoreTagMaintenanceFocus(this.elements.tagList, focus, focusFallback);
      return;
    }
    renderTagMaintenanceView({
      container: this.elements.tagList,
      summary: this.elements.tagSummary,
      tags: this.tags,
      writesEnabled: this.writesEnabled,
      pendingTagIds: this.pendingTagIds,
      onRename: (tag, name) => void this.renameTag(tag, name),
      onDelete: (tag) => void this.deleteTag(tag),
    });
    restoreTagMaintenanceFocus(this.elements.tagList, focus, focusFallback);
  }

  private applyBoundedFacets(state: OptionsBoundedState): void {
    this.summary = state.summary;
    this.tags = state.tags;
    this.platforms = state.platforms;
    this.writesEnabled = true;
    this.selectionController.setWritesEnabled(true);
    this.selectionController.clear();
    this.elements.pageMessage.hidden = true;
    this.elements.authorTotal.textContent = String(state.summary.authorCount);
    this.elements.tagTotal.textContent = String(state.summary.tagCount);
    this.renderTagFilter();
    this.renderPlatformFilter();
    this.renderTags();
    resetAuthorListViewport(this.elements.viewport);
    this.transferController.setStorageAvailable(true);
  }

  private showUnreadableStorage(): void {
    this.summary = null;
    this.tags = [];
    this.platforms = [];
    this.authorItems = [];
    this.authorTotalCount = 0;
    this.writesEnabled = false;
    this.selectionController.setWritesEnabled(false);
    this.selectionController.clear();
    this.elements.pageMessage.hidden = false;
    this.elements.pageMessage.textContent = "本地数据无法读取，Cocoon 未进行修改。";
    this.elements.authorTotal.textContent = "—";
    this.elements.tagTotal.textContent = "—";
    this.renderTagFilter();
    this.renderPlatformFilter();
    this.renderTags();
    this.renderAuthors();
    this.transferController.setStorageAvailable(false);
  }

  private async reloadBoundedForTransfer(): Promise<boolean> {
    await this.refresh();
    return this.writesEnabled;
  }

  private async finishMutationFailure(storageUnreadable: boolean, message?: string): Promise<void> {
    this.showWriteError(message);
    if (storageUnreadable) {
      this.showUnreadableStorage();
      return;
    }
    await this.refresh();
  }

  private async acceptMutationSummary(response: BlacklistRpcResponse): Promise<boolean> {
    const next = mutationSummary(response);
    if (!next) {
      await this.finishMutationFailure(false);
      return false;
    }
    if (!(await this.queryCoordinator.acceptMutationSummary(next))) return false;
    this.summary = next;
    this.elements.authorTotal.textContent = String(next.authorCount);
    this.elements.tagTotal.textContent = String(next.tagCount);
    return true;
  }

  private applyRenamedTag(tag: BlacklistTagDto): void {
    this.tags = applyRenamedTagState(this.tags, tag);
    this.queryCoordinator.updateLoadedAuthors((items) =>
      items.map((item) => (item.tag.tagId === tag.tagId ? { ...item, tag } : item)),
    );
    this.renderTagFilter();
    this.renderTags();
  }

  private applyDeletedTag(tagId: string, migratedCount: number): boolean {
    const next = applyDeletedTagState(this.tags, tagId, migratedCount);
    if (!next) return false;
    this.tags = next.tags;
    this.queryCoordinator.updateLoadedAuthors((items) =>
      items.map((item) =>
        item.author.tagId === tagId
          ? { author: { ...item.author, tagId: next.replacement.tagId }, tag: next.replacement }
          : item,
      ),
    );
    if (this.selectedTagId === tagId) this.selectedTagId = null;
    this.renderTagFilter();
    this.renderTags();
    return true;
  }

  private applyRemovedAuthors(identities: readonly BlacklistAuthorIdentityDto[]): void {
    const next = applyRemovedAuthorState(
      this.tags,
      this.authorItems,
      this.authorTotalCount,
      identities,
    );
    this.tags = next.tags;
    this.queryCoordinator.updateLoadedAuthors(() => next.items, next.totalCount);
    this.selectionController.clear();
    this.renderTags();
  }

  private async removeOne(author: BlacklistAuthorDto, button: HTMLButtonElement): Promise<void> {
    if (!this.writesEnabled) return;
    this.clearWriteError();
    button.disabled = true;
    try {
      const response = await this.dependencies.rpc.removeOne({
        platformId: author.platformId,
        userId: author.userId,
      });
      if (!removedAuthorMatches(response, author)) {
        await this.finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      if (!(await this.acceptMutationSummary(response))) return;
      this.applyRemovedAuthors([{ platformId: author.platformId, userId: author.userId }]);
      await this.queryCoordinator.reloadAuthors();
      this.elements.authorSearch.focus();
    } catch {
      await this.finishMutationFailure(false);
    }
  }

  private async removeMany(identities: readonly BlacklistAuthorIdentityDto[]): Promise<void> {
    if (!this.writesEnabled) return;
    this.clearWriteError();
    this.elements.removeSelected.disabled = true;
    try {
      const response = await this.dependencies.rpc.request("remove-many", { identities });
      if (!response.ok || response.data.removedCount !== identities.length) {
        await this.finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      if (!(await this.acceptMutationSummary(response))) return;
      this.applyRemovedAuthors(identities);
      await this.queryCoordinator.reloadAuthors();
      this.elements.removeSelected.focus();
    } catch {
      await this.finishMutationFailure(false);
    }
  }

  private async renameTag(tag: BlacklistTagDto, name: string): Promise<void> {
    if (!this.writesEnabled || !this.beginTagMutation(tag.tagId)) return;
    this.clearWriteError();
    const shouldReloadAuthors = this.queryCoordinator.hasUnloadedAuthors();
    try {
      const response = await this.dependencies.rpc.request("rename-tag", {
        tagId: tag.tagId,
        name,
      });
      if (!response.ok || response.data.tag?.tagId !== tag.tagId) {
        const message = response.error === "invalid-tag" ? "标签名称无效或已存在。" : undefined;
        await this.finishMutationFailure(response.error === "storage-unreadable", message);
        return;
      }
      if (!(await this.acceptMutationSummary(response))) return;
      this.applyRenamedTag(response.data.tag);
      if (shouldReloadAuthors) await this.queryCoordinator.reloadAuthors();
    } catch {
      await this.finishMutationFailure(false);
    } finally {
      this.endTagMutation(tag.tagId);
    }
  }

  private async deleteTag(tag: BlacklistTagDto): Promise<void> {
    if (!this.writesEnabled || !this.beginTagMutation(tag.tagId)) return;
    this.clearWriteError();
    const shouldReload =
      this.selectedTagId === tag.tagId || this.queryCoordinator.hasUnloadedAuthors();
    try {
      const response = await this.dependencies.rpc.request("delete-tag", { tagId: tag.tagId });
      const migratedCount = deletedTagCount(response, tag.tagId);
      if (migratedCount === null) {
        await this.finishMutationFailure(response.error === "storage-unreadable");
        return;
      }
      if (!(await this.acceptMutationSummary(response))) return;
      if (!this.applyDeletedTag(tag.tagId, migratedCount)) {
        await this.refresh();
        return;
      }
      if (shouldReload) await this.queryCoordinator.reloadAuthors();
    } catch {
      await this.finishMutationFailure(false);
    } finally {
      this.endTagMutation(tag.tagId);
    }
  }

  private bindEvents(): void {
    this.elements.authorSearch.addEventListener(
      "input",
      () => void this.queryCoordinator.reloadAuthors(),
    );
    this.elements.tagFilter.addEventListener("change", () => {
      this.selectedTagId = this.tagIdByFilterToken.get(this.elements.tagFilter.value) ?? null;
      void this.queryCoordinator.reloadAuthors();
    });
    this.elements.platformFilter.addEventListener("change", () => {
      this.selectedPlatformId =
        this.platformIdByFilterToken.get(this.elements.platformFilter.value) ?? null;
      void this.queryCoordinator.reloadAuthors();
    });
    this.elements.timeSort.addEventListener(
      "change",
      () => void this.queryCoordinator.reloadAuthors(),
    );
    this.elements.viewport.addEventListener("scroll", () => this.handleAuthorScroll());
    this.elements.removeSelected.addEventListener("click", () => this.requestRemoveMany());
    this.dependencies.storageChanges.addListener((changes, areaName) => {
      if (parseBlacklistRevisionChange(changes, areaName)) void this.refresh();
    });
  }

  private handleAuthorScroll(): void {
    const { viewport } = this.elements;
    const nearEnd = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 128;
    if (nearEnd && this.queryCoordinator.hasUnloadedAuthors()) {
      void this.queryCoordinator.loadNextAuthors();
    }
    this.scheduleAuthorRender();
  }

  private requestRemoveMany(): void {
    const identities = this.selectionController.values();
    this.dialogController.open(identities.length, this.elements.removeSelected, () => {
      void this.removeMany(identities);
    });
  }
}

export function bootstrapOptions(dependencies: OptionsAppDependencies): OptionsApp {
  return new OptionsApplication(dependencies);
}
