import "./options.css";

import { createBlacklistRpcClient } from "../ui/background-rpc.ts";
import { bootstrapOptions } from "./app.ts";
import { downloadJsonBlob, readFileText } from "./transfer-file.ts";

bootstrapOptions({
  document,
  rpc: createBlacklistRpcClient(async (message) =>
    chrome.runtime.sendMessage(message)
  ),
  storageChanges: chrome.storage.onChanged,
  requestFrame(callback) {
    return requestAnimationFrame(callback);
  },
  readFileText,
  downloadJson(json, filename) {
    downloadJsonBlob(document, URL, json, filename, (callback) => {
      window.setTimeout(callback, 0);
    });
  },
});
