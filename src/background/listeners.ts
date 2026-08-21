import type { BadgeMessageResponse } from "../core/badge-message-contract.ts";
import {
  getMainFrameTabId,
  parseBadgeMessage,
  type BadgeController,
  type BadgeMessageSender,
} from "./badge-controller.ts";

export type BadgeRuntimeMessageListener = (
  message: unknown,
  sender: BadgeMessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

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
