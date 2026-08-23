import "./options.css";

import { createBlacklistRpcClient } from "../ui/background-rpc.ts";
import { bootstrapOptions } from "./app.ts";

bootstrapOptions({
  document,
  rpc: createBlacklistRpcClient(async (message) =>
    chrome.runtime.sendMessage(message)
  ),
  storageChanges: chrome.storage.onChanged,
  requestFrame(callback) {
    return requestAnimationFrame(callback);
  },
});
