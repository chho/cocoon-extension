const PING_TYPE = "cocoon.content.ping";
const PONG_TYPE = "cocoon.content.pong";

interface StatusMessageSender {
  readonly id?: string;
}

interface StatusRuntime {
  readonly id: string;
  readonly onMessage: {
    addListener(listener: (
      message: unknown,
      sender: StatusMessageSender,
      sendResponse: (response: unknown) => void,
    ) => boolean): void;
  };
}

function isPing(value: unknown, generation: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "generation,type,version" &&
    record.version === 1 &&
    record.type === PING_TYPE &&
    record.generation === generation;
}

export function registerContentStatusPing(
  generation: string,
  runtime: StatusRuntime = chrome.runtime,
): void {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== runtime.id || !isPing(message, generation)) {
      return false;
    }
    sendResponse({
      version: 1,
      type: PONG_TYPE,
      generation,
    });
    return false;
  });
}
