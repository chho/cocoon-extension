import "./options.css";

import { createBlacklistRpcClient } from "../ui/background-rpc.ts";
import { createBlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import { bootstrapOptions } from "./app.ts";
import {
  bootstrapPlatformBlockSetting,
  type PlatformBlockSettingDependencies,
} from "./platform-block-setting.ts";
import { downloadJsonBlob, readFileText } from "./transfer-file.ts";

const settingDependencies: PlatformBlockSettingDependencies = {
  document,
  storage: chrome.storage.local,
  setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
  clearTimeout: (id) => window.clearTimeout(id),
};
let setting = bootstrapPlatformBlockSetting(settingDependencies);
window.addEventListener("pagehide", () => setting.destroy());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) setting = bootstrapPlatformBlockSetting(settingDependencies);
});

bootstrapOptions({
  document,
  rpc: createBlacklistRpcClient(async (message) => chrome.runtime.sendMessage(message)),
  transferRpc: createBlacklistTransferRpcClient(async (message) =>
    chrome.runtime.sendMessage(message),
  ),
  storageChanges: chrome.storage.onChanged,
  requestFrame(callback) {
    return requestAnimationFrame(callback);
  },
  readFileText,
  downloadJson(parts, filename) {
    downloadJsonBlob(document, URL, parts, filename, (callback) => {
      window.setTimeout(callback, 0);
    });
  },
});
