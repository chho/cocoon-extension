import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import type * as ContentRpcContractModule from "../core/blacklist-content-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundContentRpcContract from "../core/blacklist-content-rpc-contract.ts?background-copy";
import {
  getMainFrameTabId,
  parseBadgeMessage,
  type BadgeController,
  type BadgeMessageSender,
} from "./badge-controller.ts";
import type * as QueryRpcContractModule from "../core/blacklist-query-rpc-contract.ts";
import type {
  BlacklistQueryRequest,
  BlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundQueryRpcContract from "../core/blacklist-query-rpc-contract.ts?background-copy";
import type * as RpcContractModule from "../core/blacklist-rpc-contract.ts";
import type { BlacklistRpcRequest, BlacklistRpcResponse } from "../core/blacklist-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundRpcContract from "../core/blacklist-rpc-contract.ts?background-copy";
import type * as TransferRpcContractModule from "../core/blacklist-transfer-rpc-contract.ts";
import type {
  BlacklistTransferRequest,
  BlacklistTransferResponse,
} from "../core/blacklist-transfer-rpc-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundTransferRpcContract from "../core/blacklist-transfer-rpc-contract.ts?background-copy";
import { mapBlacklistTransferError } from "./blacklist-transfer-controller.ts";

const { createBlacklistQueryResponse, parseBlacklistQueryRequest } =
  backgroundQueryRpcContract as typeof QueryRpcContractModule;
const { createBlacklistRpcResponse, parseBlacklistRpcRequest } =
  backgroundRpcContract as typeof RpcContractModule;
const { createBlacklistContentResponse, parseBlacklistContentRequest } =
  backgroundContentRpcContract as typeof ContentRpcContractModule;
const { createBlacklistTransferResponse, parseBlacklistTransferRequest } =
  backgroundTransferRpcContract as typeof TransferRpcContractModule;

export type BadgeRuntimeMessageListener = (
  message: unknown,
  sender: BadgeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

export interface UiMessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: { readonly id?: number };
  readonly frameId?: number;
}

export type BlacklistRuntimeMessageListener = (
  message: unknown,
  sender: UiMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

export interface BlacklistRpcHandler {
  handle(request: BlacklistRpcRequest): Promise<BlacklistRpcResponse>;
  handleQuery?(request: BlacklistQueryRequest): Promise<BlacklistQueryResponse>;
}

export interface BlacklistContentRpcHandler {
  handle(request: ContentRpcContractModule.BlacklistContentRequest): Promise<unknown>;
}

export interface BlacklistTransferRpcHandler {
  handleTransfer(request: BlacklistTransferRequest): Promise<BlacklistTransferResponse>;
}

function authorizedUiPath(sender: UiMessageSender, runtimeId: string): string | null {
  if (sender.id !== runtimeId || !sender.url) {
    return null;
  }
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" &&
      url.hostname === runtimeId &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
      ? url.pathname
      : null;
  } catch {
    return null;
  }
}

export function isAuthorizedUiSender(sender: UiMessageSender, runtimeId: string): boolean {
  const path = authorizedUiPath(sender, runtimeId);
  return path === "/popup/popup.html" || path === "/options/options.html";
}

export function isAuthorizedTransferSender(sender: UiMessageSender, runtimeId: string): boolean {
  return authorizedUiPath(sender, runtimeId) === "/options/options.html";
}

export function createBlacklistContentRuntimeMessageListener(
  handler: BlacklistContentRpcHandler,
  runtimeId: string,
  reportFailure: () => void,
): BlacklistRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    const request = parseBlacklistContentRequest(message);
    const tabId = sender.tab?.id;
    if (
      !request ||
      sender.id !== runtimeId ||
      sender.url !== "https://www.zhihu.com/" ||
      !Number.isSafeInteger(tabId) ||
      (tabId as number) < 0 ||
      sender.frameId !== 0
    ) {
      return false;
    }
    void (async () => {
      try {
        const result = await handler.handle(request);
        sendResponse(createBlacklistContentResponse(request.operation, true, result));
      } catch {
        reportFailure();
        try {
          sendResponse(createBlacklistContentResponse(request.operation, false));
        } catch {
          reportFailure();
        }
      }
    })();
    return true;
  };
}

export function createBlacklistTransferRuntimeMessageListener(
  handler: BlacklistTransferRpcHandler,
  runtimeId: string,
  reportFailure: () => void,
): BlacklistRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    const request = parseBlacklistTransferRequest(message);
    if (!request || !isAuthorizedTransferSender(sender, runtimeId)) return false;
    void (async () => {
      let response: BlacklistTransferResponse;
      try {
        response = await handler.handleTransfer(request);
      } catch (error) {
        reportFailure();
        response = createBlacklistTransferResponse(
          request.operation,
          false,
          null,
          mapBlacklistTransferError(request.operation, error),
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

async function respondToBlacklistQuery(
  handleQuery: (request: BlacklistQueryRequest) => Promise<BlacklistQueryResponse>,
  query: BlacklistQueryRequest,
  sendResponse: (response?: unknown) => void,
  reportFailure: () => void,
): Promise<void> {
  let response: BlacklistQueryResponse;
  try {
    response = await handleQuery(query);
  } catch {
    reportFailure();
    response = createBlacklistQueryResponse(query.operation, false, null, "storage-unreadable");
  }
  try {
    sendResponse(response);
  } catch {
    reportFailure();
  }
}

function managementFailureResponse(request: BlacklistRpcRequest): BlacklistRpcResponse {
  return request.operation === "status"
    ? createBlacklistRpcResponse("status", true, { status: "connection-error", count: 0 })
    : createBlacklistRpcResponse(request.operation, false, {}, "storage-unreadable");
}

async function respondToBlacklistManagement(
  handler: BlacklistRpcHandler,
  request: BlacklistRpcRequest,
  sendResponse: (response?: unknown) => void,
  reportFailure: () => void,
): Promise<void> {
  let response: BlacklistRpcResponse;
  try {
    response = await handler.handle(request);
  } catch {
    reportFailure();
    response = managementFailureResponse(request);
  }
  try {
    sendResponse(response);
  } catch {
    reportFailure();
  }
}

export function createBlacklistRuntimeMessageListener(
  handler: BlacklistRpcHandler,
  runtimeId: string,
  reportFailure: () => void,
): BlacklistRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    const query = parseBlacklistQueryRequest(message);
    if (query) {
      if (!isAuthorizedUiSender(sender, runtimeId) || !handler.handleQuery) return false;
      void respondToBlacklistQuery(handler.handleQuery, query, sendResponse, reportFailure);
      return true;
    }
    const request = parseBlacklistRpcRequest(message);
    if (!request || !isAuthorizedUiSender(sender, runtimeId)) return false;
    void respondToBlacklistManagement(handler, request, sendResponse, reportFailure);
    return true;
  };
}

export function createBadgeRuntimeMessageListener(
  controller: Pick<BadgeController, "handleMessage">,
  reportFailure: () => void,
): BadgeRuntimeMessageListener {
  return (message, sender, sendResponse) => {
    if (parseBadgeMessage(message) === null || getMainFrameTabId(sender) === null) {
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
