import type { BlacklistRpcError } from "../core/blacklist-rpc-contract.ts";

export function clearTransferError(element: HTMLElement): void {
  element.hidden = true;
  element.textContent = "";
}

export function showTransferError(element: HTMLElement, message: string): void {
  element.textContent = message;
  element.hidden = false;
  element.focus();
}

export function transferFailureMessage(error: BlacklistRpcError | null): string {
  if (error === "transfer-conflict") {
    return "导入内容与本地标签或稳定标识冲突，未进行更改。";
  }
  if (error === "transfer-too-large") {
    return "导入数据超过 8 MiB 限制，未进行更改。";
  }
  if (error === "invalid-transfer") {
    return "导入文件无效或格式不受支持，未进行更改。";
  }
  if (error === "storage-unreadable") {
    return "本地数据无法读取，Cocoon 未进行修改。";
  }
  return "导入未保存，请重试。";
}
