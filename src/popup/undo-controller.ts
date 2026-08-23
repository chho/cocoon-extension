import type { BlacklistAuthorDto } from "../core/blacklist-rpc-contract.ts";

export const POPUP_UNDO_DURATION_MS = 8_000;

export interface PopupUndoController {
  start(author: BlacklistAuthorDto): void;
  take(): BlacklistAuthorDto | null;
  clear(): void;
  dispose(): void;
  current(): BlacklistAuthorDto | null;
}

export function createPopupUndoController(
  schedule: (callback: () => void, delay: number) => number,
  cancel: (id: number) => void,
  onExpire: () => void,
): PopupUndoController {
  let pending: BlacklistAuthorDto | null = null;
  let timer: number | null = null;
  let sequence = 0;

  function clear(): void {
    sequence += 1;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    pending = null;
  }

  return {
    start(author) {
      clear();
      pending = author;
      const currentSequence = sequence;
      timer = schedule(() => {
        if (sequence !== currentSequence) {
          return;
        }
        sequence += 1;
        pending = null;
        timer = null;
        onExpire();
      }, POPUP_UNDO_DURATION_MS);
    },
    take() {
      const author = pending;
      clear();
      return author;
    },
    clear,
    dispose: clear,
    current() {
      return pending;
    },
  };
}
