import type { BadgeController } from "./badge-controller.ts";

export interface StatusTabs {
  query(queryInfo: {
    readonly active: true;
    readonly currentWindow: true;
  }): Promise<readonly { readonly id?: number }[]>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export type CurrentPageStatusResult =
  | { readonly status: "running"; readonly count: number }
  | { readonly status: "unsupported"; readonly count: 0 }
  | { readonly status: "connection-error"; readonly count: number };

function isPong(value: unknown, generation: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "generation,type,version" &&
    record.version === 1 &&
    record.type === "cocoon.content.pong" &&
    record.generation === generation;
}

export function createStatusController(
  tabs: StatusTabs,
  badgeController: Pick<BadgeController, "getStatusState">,
): { query(): Promise<CurrentPageStatusResult> } {
  return {
    async query() {
      const [tab] = await tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      if (!Number.isSafeInteger(tabId) || (tabId as number) < 0) {
        return { status: "unsupported", count: 0 };
      }
      const read = await badgeController.getStatusState(tabId as number);
      if (read.status === "missing") {
        return { status: "unsupported", count: 0 };
      }
      if (read.status === "invalid") {
        return { status: "connection-error", count: 0 };
      }
      const { state } = read;
      try {
        const response = await tabs.sendMessage(tabId as number, {
          version: 1,
          type: "cocoon.content.ping",
          generation: state.generation,
        });
        return isPong(response, state.generation)
          ? { status: "running", count: state.count }
          : { status: "connection-error", count: state.count };
      } catch {
        return { status: "connection-error", count: state.count };
      }
    },
  };
}
