import type { BlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import { createConfirmationDialogController } from "./dialog-controller.ts";
import {
  abortBlacklistImport,
  OptionsTransferPipelineError,
  runBlacklistExport,
  runBlacklistImport,
  type OptionsTransferProgress,
} from "./transfer-pipeline.ts";
import { readBlacklistTransferFile, type PreparedBlacklistImport } from "./transfer-file.ts";

export interface OptionsTransferUiDependencies {
  readonly document: Document;
  readonly rpc: BlacklistTransferRpcClient;
  readonly readFileText: (file: File) => Promise<string>;
  readonly downloadJson: (parts: readonly BlobPart[], filename: string) => void;
  readonly reloadBounded: () => Promise<boolean>;
  readonly showUnreadableStorage: () => void;
}

export interface OptionsTransferUiController {
  setStorageAvailable(available: boolean): void;
}

interface TransferElements {
  readonly panel: HTMLElement;
  readonly exportData: HTMLButtonElement;
  readonly importFile: HTMLInputElement;
  readonly importMode: HTMLFieldSetElement;
  readonly importData: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly error: HTMLElement;
}

function requiredElement<ElementType extends HTMLElement>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Options transfer element is missing: ${selector}`);
  return element;
}

function transferElements(document: Document): TransferElements {
  return {
    panel: requiredElement(document, "#transfer-panel"),
    exportData: requiredElement(document, "#export-data"),
    importFile: requiredElement(document, "#import-file"),
    importMode: requiredElement(document, "#import-mode"),
    importData: requiredElement(document, "#import-data"),
    status: requiredElement(document, "#transfer-status"),
    error: requiredElement(document, "#transfer-error"),
  };
}

function clearTransferError(element: HTMLElement): void {
  element.hidden = true;
  element.textContent = "";
}

function showTransferError(element: HTMLElement, message: string): void {
  element.textContent = message;
  element.hidden = false;
  element.focus();
}

function progressText(progress: OptionsTransferProgress): string {
  switch (progress.phase) {
    case "import-tags":
      return `正在上传标签 ${progress.completed} / ${progress.total}…`;
    case "import-authors":
      return `正在上传作者 ${progress.completed} / ${progress.total}…`;
    case "import-inspect":
      return "正在核对暂存数据…";
    case "import-finalize":
      return "正在保存导入数据…";
    case "export-authors":
      return `正在导出作者 ${progress.completed} / ${progress.total}…`;
    case "export-tags":
      return `正在导出标签 ${progress.completed} / ${progress.total}…`;
    case "export-finish":
      return "正在确认导出数据未发生变化…";
  }
}

function importFailureMessage(error: OptionsTransferPipelineError): string {
  if (error.code === "transfer-conflict") {
    return "导入内容与本地标签或稳定标识冲突，未进行更改；暂存数据可重试。";
  }
  if (error.code === "chunk-conflict") {
    return "导入暂存分块发生冲突，已尝试清理；请重新点击导入。";
  }
  if (error.code === "save-failed") {
    return "导入未保存（可能是本地存储空间不足）；暂存数据保留，可重试。";
  }
  if (error.code === "session-expired" || error.code === "session-not-found") {
    return "导入暂存已失效；文件仍已校验，可重新点击导入。";
  }
  if (error.code === "incomplete-import") {
    return "导入分块尚未完整暂存；文件仍已校验，可重试。";
  }
  if (error.code === "storage-unreadable") return "本地数据无法读取，Cocoon 未进行修改。";
  return "导入中断；文件与可用暂存状态已保留，可重试。";
}

function exportFailureMessage(error: OptionsTransferPipelineError): string {
  if (error.code === "stale-export") {
    return "导出期间本地数据发生变化，未下载不一致文件；请重试。";
  }
  if (error.code === "transfer-too-large") {
    return "导出数据超过 32 MiB 单文件上限，未下载文件。";
  }
  if (error.code === "storage-unreadable") return "本地数据无法读取，未下载文件。";
  return "无法导出本地数据，未下载文件；请重试。";
}

class OptionsTransferUi implements OptionsTransferUiController {
  private readonly dependencies: OptionsTransferUiDependencies;
  private readonly elements: TransferElements;
  private readonly replaceDialogController;
  private storageAvailable = false;
  private prepared: PreparedBlacklistImport | null = null;
  private importSessionId: string | null = null;
  private pending = false;
  private fileReadSequence = 0;

  constructor(dependencies: OptionsTransferUiDependencies) {
    const { document } = dependencies;
    this.dependencies = dependencies;
    this.elements = transferElements(document);
    this.replaceDialogController = createConfirmationDialogController({
      dialog: requiredElement(document, "#replace-dialog"),
      description: requiredElement(document, "#replace-dialog-description"),
      cancel: requiredElement(document, "#replace-cancel"),
      confirm: requiredElement(document, "#replace-confirm"),
    });
    this.bindEvents();
    this.updateControls();
  }

  setStorageAvailable(available: boolean): void {
    this.storageAvailable = available;
    this.updateControls();
  }

  private updateControls(): void {
    const { exportData, importFile, importMode, importData, panel } = this.elements;
    exportData.disabled = !this.storageAvailable || this.pending;
    importFile.disabled = !this.storageAvailable || this.pending;
    importMode.disabled = !this.storageAvailable || this.pending;
    importData.disabled = !this.storageAvailable || this.pending || this.prepared === null;
    importData.textContent = this.importSessionId ? "重试导入" : "导入";
    if (this.pending) panel.setAttribute("aria-busy", "true");
    else panel.removeAttribute("aria-busy");
  }

  private setPending(value: boolean): void {
    this.pending = value;
    this.updateControls();
  }

  private async discardImportSession(): Promise<void> {
    const sessionId = this.importSessionId;
    this.importSessionId = null;
    if (!sessionId) return;
    try {
      await abortBlacklistImport(this.dependencies.rpc, sessionId);
    } catch {
      // A disconnected worker cannot be forced to clean up; the persistent session expires safely.
    }
  }

  private showInvalidFile(status: "invalid" | "too-large"): void {
    this.elements.status.textContent = "未选择可导入的数据。";
    const message =
      status === "too-large"
        ? "导入文件超过 32 MiB 单文件上限；这不代表本地数据总容量。"
        : "导入文件无效或格式不受支持。";
    showTransferError(this.elements.error, message);
  }

  private acceptPreparedFile(result: Awaited<ReturnType<typeof readBlacklistTransferFile>>): void {
    if (result.status !== "valid") {
      this.showInvalidFile(result.status);
      return;
    }
    this.prepared = result.prepared;
    const { authorCount, tagCount } = result.prepared.metadata;
    this.elements.status.textContent = `已校验 ${authorCount} 位作者和 ${tagCount} 个标签；单个导入文件上限为 32 MiB。`;
  }

  private async readSelectedFile(): Promise<void> {
    const sequence = ++this.fileReadSequence;
    const file = this.elements.importFile.files?.[0] ?? null;
    this.prepared = null;
    clearTransferError(this.elements.error);
    this.setPending(true);
    await this.discardImportSession();
    if (sequence !== this.fileReadSequence) return;
    if (!file) {
      this.elements.status.textContent = "请选择 Cocoon 导出的 JSON 文件。";
      this.setPending(false);
      return;
    }
    this.elements.status.textContent = "正在校验导入文件…";
    try {
      const result = await readBlacklistTransferFile(file, this.dependencies.readFileText);
      if (sequence === this.fileReadSequence) this.acceptPreparedFile(result);
    } catch {
      if (sequence !== this.fileReadSequence) return;
      this.elements.status.textContent = "未选择可导入的数据。";
      showTransferError(this.elements.error, "无法读取导入文件，请重新选择。");
    } finally {
      if (sequence === this.fileReadSequence) this.setPending(false);
    }
  }

  private async handleImportFailure(error: unknown): Promise<void> {
    const failure =
      error instanceof OptionsTransferPipelineError
        ? error
        : new OptionsTransferPipelineError("transport-failed", this.importSessionId);
    if (failure.sessionId) this.importSessionId = failure.sessionId;
    if (failure.code === "chunk-conflict" && this.importSessionId) {
      await this.discardImportSession();
    }
    this.elements.status.textContent = "未导入数据。";
    showTransferError(this.elements.error, importFailureMessage(failure));
    if (failure.code === "storage-unreadable") this.dependencies.showUnreadableStorage();
  }

  private importSuccessText(mode: "merge" | "replace", selected: PreparedBlacklistImport): string {
    const { authorCount, tagCount } = selected.metadata;
    return mode === "merge"
      ? `合并完成；文件包含 ${authorCount} 位作者和 ${tagCount} 个标签。`
      : `已替换为 ${authorCount} 位作者和 ${tagCount} 个标签。`;
  }

  private async importPrepared(mode: "merge" | "replace"): Promise<void> {
    const selected = this.prepared;
    if (!this.storageAvailable || this.pending || !selected) return;
    clearTransferError(this.elements.error);
    this.setPending(true);
    this.elements.status.textContent = mode === "merge" ? "正在开始合并导入…" : "正在开始替换…";
    try {
      await runBlacklistImport({
        client: this.dependencies.rpc,
        prepared: selected,
        mode,
        resumeSessionId: this.importSessionId,
        onSession: (sessionId) => this.rememberSession(sessionId),
        onProgress: (progress) => this.showProgress(progress),
      });
      this.importSessionId = null;
      this.prepared = null;
      this.elements.importFile.value = "";
      const refreshed = await this.dependencies.reloadBounded();
      this.elements.status.textContent = refreshed
        ? this.importSuccessText(mode, selected)
        : "导入已保存，但列表刷新失败；请重新打开管理页。";
      this.elements.status.focus();
    } catch (error) {
      await this.handleImportFailure(error);
    } finally {
      this.setPending(false);
    }
  }

  private rememberSession(sessionId: string): void {
    this.importSessionId = sessionId;
    this.updateControls();
  }

  private showProgress(progress: OptionsTransferProgress): void {
    this.elements.status.textContent = progressText(progress);
  }

  private requestImport(): void {
    if (!this.storageAvailable || this.pending || !this.prepared) return;
    const mode = this.dependencies.document.querySelector<HTMLInputElement>(
      "input[name='import-mode']:checked",
    )?.value;
    if (mode !== "replace") {
      void this.importPrepared("merge");
      return;
    }
    const selected = this.prepared;
    this.replaceDialogController.openWithDescription(
      `将用文件中的 ${selected.metadata.authorCount} 位作者和 ${selected.metadata.tagCount} 个标签替换当前列表。现有设置会保留。`,
      this.elements.importData,
      () => {
        if (this.prepared === selected) void this.importPrepared("replace");
      },
    );
  }

  private async exportTransfer(): Promise<void> {
    if (!this.storageAvailable || this.pending) return;
    clearTransferError(this.elements.error);
    this.elements.status.textContent = "正在准备导出…";
    this.setPending(true);
    try {
      const result = await runBlacklistExport({
        client: this.dependencies.rpc,
        onProgress: (progress) => this.showProgress(progress),
      });
      this.dependencies.downloadJson(result.parts, result.filename);
      this.elements.status.textContent = `已导出 ${result.authorCount} 位作者和 ${result.tagCount} 个标签。`;
      this.elements.status.focus();
    } catch (error) {
      const failure =
        error instanceof OptionsTransferPipelineError
          ? error
          : new OptionsTransferPipelineError("transport-failed");
      this.elements.status.textContent = "未导出数据。";
      showTransferError(this.elements.error, exportFailureMessage(failure));
      if (failure.code === "storage-unreadable") this.dependencies.showUnreadableStorage();
    } finally {
      this.setPending(false);
    }
  }

  private bindEvents(): void {
    this.elements.exportData.addEventListener("click", () => {
      void this.exportTransfer();
    });
    this.elements.importFile.addEventListener("change", () => {
      void this.readSelectedFile();
    });
    this.elements.importData.addEventListener("click", () => this.requestImport());
  }
}

export function createOptionsTransferUiController(
  dependencies: OptionsTransferUiDependencies,
): OptionsTransferUiController {
  return new OptionsTransferUi(dependencies);
}
