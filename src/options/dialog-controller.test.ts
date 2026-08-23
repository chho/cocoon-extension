import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import { createConfirmationDialogController } from "./dialog-controller.ts";

function createFixture() {
  const dom = new JSDOM(`
    <button id="invoker">解除所选（3）</button>
    <dialog id="dialog" aria-labelledby="title" aria-describedby="description">
      <h2 id="title">解除所选作者</h2>
      <p id="description"></p>
      <button id="cancel" type="button">取消</button>
      <button id="confirm" type="button">确认解除</button>
    </dialog>
  `, { pretendToBeVisual: true });
  const document = dom.window.document;
  const dialog = document.querySelector<HTMLDialogElement>("#dialog");
  const description = document.querySelector<HTMLElement>("#description");
  const cancel = document.querySelector<HTMLButtonElement>("#cancel");
  const confirm = document.querySelector<HTMLButtonElement>("#confirm");
  const invoker = document.querySelector<HTMLButtonElement>("#invoker");
  const title = document.querySelector<HTMLElement>("#title");
  if (!dialog || !description || !cancel || !confirm || !invoker || !title) {
    throw new Error("test fixture is incomplete");
  }
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
  const controller = createConfirmationDialogController({
    dialog,
    description,
    cancel,
    confirm,
  });
  return {
    dom,
    document,
    dialog,
    description,
    cancel,
    confirm,
    invoker,
    title,
    controller,
  };
}

test("MANAGE-001 dialog has an accessible role/name, exact count, and initial focus", () => {
  const fixture = createFixture();
  fixture.invoker.focus();
  fixture.controller.open(3, fixture.invoker, () => {});

  strictEqual(fixture.dialog.open, true);
  strictEqual(fixture.dialog.getAttribute("role"), "dialog");
  strictEqual(fixture.dialog.getAttribute("aria-modal"), "true");
  strictEqual(fixture.dialog.getAttribute("aria-labelledby"), fixture.title.id);
  strictEqual(fixture.title.textContent, "解除所选作者");
  strictEqual(fixture.description.textContent, "确定解除所选的 3 位作者吗？");
  strictEqual(fixture.document.activeElement, fixture.cancel);
});

test("MANAGE-001 dialog traps Tab and Shift+Tab at its focus boundaries", () => {
  const fixture = createFixture();
  fixture.controller.open(2, fixture.invoker, () => {});

  fixture.confirm.focus();
  const forward = new fixture.dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  strictEqual(fixture.dialog.dispatchEvent(forward), false);
  strictEqual(fixture.document.activeElement, fixture.cancel);

  const backward = new fixture.dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  strictEqual(fixture.dialog.dispatchEvent(backward), false);
  strictEqual(fixture.document.activeElement, fixture.confirm);
});

test("MANAGE-001 Escape cancel closes without confirming and restores focus", () => {
  const fixture = createFixture();
  let confirmations = 0;
  fixture.invoker.focus();
  fixture.controller.open(4, fixture.invoker, () => {
    confirmations += 1;
  });
  const cancelEvent = new fixture.dom.window.Event("cancel", {
    bubbles: false,
    cancelable: true,
  });
  strictEqual(fixture.dialog.dispatchEvent(cancelEvent), false);
  strictEqual(fixture.dialog.open, false);
  strictEqual(confirmations, 0);
  strictEqual(fixture.document.activeElement, fixture.invoker);
});

test("MANAGE-001 cancel button closes without confirming and restores focus", () => {
  const fixture = createFixture();
  let confirmations = 0;
  fixture.invoker.focus();
  fixture.controller.open(5, fixture.invoker, () => {
    confirmations += 1;
  });
  fixture.cancel.click();
  strictEqual(fixture.dialog.open, false);
  strictEqual(confirmations, 0);
  strictEqual(fixture.document.activeElement, fixture.invoker);
});

test("MANAGE-001 confirmation runs once after close, restores focus, and cleans callbacks", () => {
  const fixture = createFixture();
  let confirmations = 0;
  fixture.invoker.focus();
  fixture.controller.open(6, fixture.invoker, () => {
    confirmations += 1;
  });
  fixture.confirm.click();
  strictEqual(fixture.dialog.open, false);
  strictEqual(confirmations, 1);
  strictEqual(fixture.document.activeElement, fixture.invoker);

  fixture.confirm.click();
  strictEqual(confirmations, 1);
  fixture.controller.close();
  strictEqual(fixture.document.activeElement, fixture.invoker);
});

test("MANAGE-001 invalid selection counts do not open or retain actions", () => {
  const fixture = createFixture();
  let confirmations = 0;
  fixture.controller.open(0, fixture.invoker, () => {
    confirmations += 1;
  });
  strictEqual(fixture.dialog.open, false);
  strictEqual(fixture.description.textContent, "");
  fixture.confirm.click();
  strictEqual(confirmations, 0);
});
