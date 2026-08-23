import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import {
  getMainFrameTabId,
  parseBadgeMessage,
  type BadgeController,
  type BadgeMessageSender,
} from "./badge-controller.ts";
import type * as RpcContractModule from "../core/blacklist-rpc-contract.ts";
import type {
  BlacklistRpcRequest,
  BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundRpcContract from "../core/blacklist-rpc-contract.ts?background-copy";

const { createBlacklistRpcResponse, parseBlacklistRpcRequest } =
  backgroundRpcContract as typeof RpcContractModule;

export type BadgeRuntimeMessageListener = (
  message: unknown,
  sender: BadgeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

export interface UiMessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: unknown;
}

export type BlacklistRuntimeMessageListener = (
  message: unknown,
  sender: UiMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

export interface BlacklistRpcHandler {
  handle(request: BlacklistRpcRequest): Promise<BlacklistRpcResponse>;
}

export function isAuthorizedUiSender(
  sender: UiMessageSender,
  runtimeId: string,
): boolean {
  if (sender.id !== runtimeId || !sender.url) {
    return false;
  }
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" &&
      url.hostname === runtimeId &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "/popup/popup.html" ||
        url.pathname === "/options/options.html");
  } catch {
    return false;
  }
}

export function createBlacklistRuntimeMessageListener(
  handler: BlacklistRpcHandler,
  runtimeId: string,
  reportFailure: () => void,
): BlacklistRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    const request = parseBlacklistRpcRequest(message);
    if (!request || !isAuthorizedUiSender(sender, runtimeId)) {
      return false;
    }
    void (async () => {
      let response: BlacklistRpcResponse;
      try {
        response = await handler.handle(request);
      } catch {
        reportFailure();
        response = request.operation === "status"
          ? createBlacklistRpcResponse("status", true, {
            status: "connection-error",
            count: 0,
          })
          : createBlacklistRpcResponse(
            request.operation,
            false,
            {},
            "storage-unreadable",
          );
      }
      try {
        sendResponse(response);
      } catch {
        reportFailure();
      }
    })();
    return true;
  };
}

export function createBadgeRuntimeMessageListener(
  controller: Pick<BadgeController, "handleMessage">,
  reportFailure: () => void,
): BadgeRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    if (
      parseBadgeMessage(message) === null ||
      getMainFrameTabId(sender) === null
    ) {
      return false;
    }

    void (async () => {
      let response: BadgeMessageResponse;
      try {
        response = await controller.handleMessage(message, sender);
      } catch {
        response = { ok: false };
      }

      if (!response.ok) {
        reportFailure();
      }
      try {
        sendResponse(response);
      } catch {
        reportFailure();
      }
    })();
    return true;
  };
}
