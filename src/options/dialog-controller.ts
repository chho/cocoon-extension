export interface ConfirmationDialogElements {
  readonly dialog: HTMLDialogElement;
  readonly description: HTMLElement;
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
}

export interface ConfirmationDialogController {
  open(count: number, invoker: HTMLElement, onConfirm: () => void): void;
  openWithDescription(
    description: string,
    invoker: HTMLElement,
    onConfirm: () => void,
  ): void;
  close(): void;
}

export function createConfirmationDialogController(
  elements: ConfirmationDialogElements,
): ConfirmationDialogController {
  const ownerDocument = elements.dialog.ownerDocument;
  elements.dialog.setAttribute("role", "dialog");
  elements.dialog.setAttribute("aria-modal", "true");
  let restoreFocus: HTMLElement | null = null;
  let confirmAction: (() => void) | null = null;

  function close(): void {
    if (elements.dialog.open) {
      elements.dialog.close();
    }
    const target = restoreFocus;
    restoreFocus = null;
    confirmAction = null;
    if (target?.isConnected) {
      target.focus();
    }
  }

  elements.cancel.addEventListener("click", close);
  elements.confirm.addEventListener("click", () => {
    const action = confirmAction;
    close();
    action?.();
  });
  elements.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  elements.dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") {
      return;
    }
    const controls = [elements.cancel, elements.confirm].filter(
      (control) => !control.disabled,
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && ownerDocument.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && ownerDocument.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function openWithDescription(
    description: string,
    invoker: HTMLElement,
    onConfirm: () => void,
  ): void {
    if (!description || elements.dialog.open) {
      return;
    }
    restoreFocus = invoker;
    confirmAction = onConfirm;
    elements.description.textContent = description;
    elements.dialog.showModal();
    elements.cancel.focus();
  }

  return {
    open(count, invoker, onConfirm) {
      if (!Number.isSafeInteger(count) || count <= 0) {
        return;
      }
      openWithDescription(
        `确定解除所选的 ${count} 位作者吗？`,
        invoker,
        onConfirm,
      );
    },
    openWithDescription,
    close,
  };
}
