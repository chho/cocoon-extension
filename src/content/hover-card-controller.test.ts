import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  HOVER_BLOCK_BUTTON_CLASS,
  HOVER_CARD_ROOT_CLASS,
  HOVER_POSITION_ANCHOR_CLASS,
  createHoverCardController,
  type HoverAuthorActivation,
} from "./hover-card-controller.ts";

function createFrames() {
  const callbacks: Array<() => void> = [];
  let scheduledCount = 0;
  return {
    schedule(callback: () => void) {
      scheduledCount += 1;
      callbacks.push(callback);
    },
    flush() {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
      }
    },
    get pendingCount() {
      return callbacks.length;
    },
    get scheduledCount() {
      return scheduledCount;
    },
  };
}

function popupMarkup(
  userId: string,
  authorName: string,
  extra = "",
): string {
  return `<div class="hover-shell">
    <div class="hover-root">
      <div class="HoverCard-item">
        <a class="profile" href="/people/${userId}">${authorName}</a>
        ${extra}
      </div>
      <div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons">
        <button type="button">关注</button>
        <button type="button">私信</button>
      </div>
    </div>
  </div>`;
}

function createController(
  _dom: JSDOM,
  activations: HoverAuthorActivation[] = [],
) {
  const frames = createFrames();
  const controller = createHoverCardController({
    schedule: frames.schedule,
    onActivate(activation) {
      activations.push(activation);
    },
  });
  return { controller, frames };
}

function requiredElement<T extends Element>(
  dom: JSDOM,
  selector: string,
): T {
  const element = dom.window.document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function directButtons(root: HTMLElement): readonly HTMLButtonElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLButtonElement =>
      child instanceof root.ownerDocument.defaultView!.HTMLButtonElement &&
      child.classList.contains(HOVER_BLOCK_BUTTON_CLASS),
  );
}

function requiredButton(dom: JSDOM, rootSelector = ".hover-root") {
  const root = requiredElement<HTMLElement>(dom, rootSelector);
  const buttons = directButtons(root);
  strictEqual(buttons.length, 1);
  return buttons[0]!;
}

test("BUG-007 activates the current unique internal profile identity and name", () => {
  const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
    "internal-author",
    "Initial Name",
  )}</body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);

  controller.scan(dom.window.document.body);
  frames.flush();
  const root = requiredElement<HTMLElement>(dom, ".hover-root");
  const profile = requiredElement<HTMLAnchorElement>(dom, ".profile");
  const button = requiredButton(dom);
  profile.textContent = "Current Popup Name";
  button.getBoundingClientRect = () => ({
    x: 12,
    y: 18,
    top: 18,
    right: 72,
    bottom: 38,
    left: 12,
    width: 60,
    height: 20,
    toJSON() {},
  });
  button.click();

  strictEqual(activations.length, 1);
  strictEqual(activations[0]?.root, root);
  strictEqual(activations[0]?.button, button);
  strictEqual(activations[0]?.userId, "internal-author");
  strictEqual(activations[0]?.authorName, "Current Popup Name");
  deepStrictEqual(activations[0]?.anchorBounds, {
    top: 18,
    right: 72,
    bottom: 38,
    left: 12,
    width: 60,
    height: 20,
  });
});

test("BUG-007 accepts duplicate links for one ID and ignores invalid or off-origin links", () => {
  const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
    "same-author",
    "",
    `<a href="https://www.zhihu.com/people/same-author" aria-label="Popup Author"></a>
     <a href="https://example.com/people/other-author">Off origin</a>
     <a href="/people/same-author/answers">Nested path</a>`,
  )}</body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);

  controller.scan(dom.window.document.body);
  frames.flush();
  requiredButton(dom).click();

  strictEqual(activations.length, 1);
  strictEqual(activations[0]?.userId, "same-author");
  strictEqual(activations[0]?.authorName, "Popup Author");
});

test("BUG-009 prioritizes one semantic main author over related profile links", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="complex-hover-root">
      <div>
        <span class="UserLink">
          <a class="UserLink-link" href="/people/main-author">Main Author</a>
        </span>
      </div>
      <div class="HoverCard-item">
        <a href="/people/related-one">Related One</a>
        <a href="/people/related-two">Related Two</a>
        <a href="/people/related-three">Related Three</a>
      </div>
      <div class="HoverCard-item">
        <div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div>
      </div>
    </div>
  </body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);

  controller.scan(dom.window.document.body);
  frames.flush();
  const button = requiredButton(dom, "#complex-hover-root");
  button.click();

  strictEqual(activations.length, 1);
  strictEqual(activations[0]?.userId, "main-author");
  strictEqual(activations[0]?.authorName, "Main Author");
});

test("BUG-007/009 fails closed when internal profile IDs are missing or ambiguous", () => {
  for (const links of [
    '<a href="https://example.com/people/off-origin">Off origin</a>',
    '<a href="/people/first">First</a><a href="/people/second">Second</a>',
    '<a class="UserLink-link" href="/people/first">First</a><a class="UserLink-link" href="/people/second">Second</a>',
  ]) {
    const dom = new JSDOM(`<!doctype html><body>
      <div class="hover-root">
        <div class="HoverCard-item">${links}</div>
        <div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div>
      </div>
    </body>`);
    const { controller, frames } = createController(dom);

    controller.scan(dom.window.document.body);
    frames.flush();

    strictEqual(
      dom.window.document.querySelector(`.${HOVER_BLOCK_BUTTON_CLASS}`),
      null,
      links,
    );
  }
});

test("BUG-007 deduplicates multiple HoverCard items that belong to one root", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="shared-root">
      <div class="HoverCard-item"><a href="/people/shared-author">Shared</a></div>
      <div class="HoverCard-item"><span>Secondary item</span></div>
      <div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div>
    </div>
  </body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);

  controller.scan(dom.window.document.body);
  frames.flush();
  const root = requiredElement<HTMLElement>(dom, "#shared-root");
  const button = requiredButton(dom, "#shared-root");
  button.click();

  strictEqual(directButtons(root).length, 1);
  strictEqual(activations[0]?.userId, "shared-author");
});

test("BUG-007 gives every distinct valid popup root its own button", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="first">${popupMarkup("first-author", "First")}</section>
    <section id="second">${popupMarkup("second-author", "Second")}</section>
  </body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);

  controller.scan(dom.window.document.body);
  frames.flush();
  const roots = Array.from(
    dom.window.document.querySelectorAll<HTMLElement>(".hover-root"),
  );
  strictEqual(roots.length, 2);
  strictEqual(directButtons(roots[0]!).length, 1);
  strictEqual(directButtons(roots[1]!).length, 1);

  directButtons(roots[0]!)[0]?.click();
  directButtons(roots[1]!)[0]?.click();
  deepStrictEqual(
    activations.map((activation) => activation.userId),
    ["first-author", "second-author"],
  );
});

test("BUG-007 repeated scans remain idempotent and remove duplicate direct buttons", () => {
  const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
    "stable-author",
    "Stable",
  )}</body>`);
  const { controller, frames } = createController(dom);

  controller.scan(dom.window.document.body);
  controller.scan(dom.window.document.body);
  frames.flush();
  const root = requiredElement<HTMLElement>(dom, ".hover-root");
  const originalButton = requiredButton(dom);
  const duplicate = dom.window.document.createElement("button");
  duplicate.className = HOVER_BLOCK_BUTTON_CLASS;
  root.append(duplicate);

  controller.handleChildListMutation(root, [duplicate], []);
  controller.scan(root);
  controller.scan(root);
  frames.flush();

  strictEqual(directButtons(root).length, 1);
  strictEqual(directButtons(root)[0], originalButton);
  strictEqual(root.classList.contains(HOVER_CARD_ROOT_CLASS), true);
  strictEqual(root.classList.contains(HOVER_POSITION_ANCHOR_CLASS), true);
});

test("BUG-007 discovers delayed button groups and fully added popup roots", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="delayed-root">
      <div class="HoverCard-item">
        <a href="/people/delayed-author">Delayed</a>
      </div>
    </div>
  </body>`);
  const { controller, frames } = createController(dom);
  const delayedRoot = requiredElement<HTMLElement>(dom, "#delayed-root");

  controller.scan(dom.window.document.body);
  frames.flush();
  strictEqual(dom.window.document.querySelector(`.${HOVER_BLOCK_BUTTON_CLASS}`), null);

  const buttonGroup = dom.window.document.createElement("div");
  buttonGroup.className =
    "MemberButtonGroup ProfileButtonGroup HoverCard-buttons";
  delayedRoot.append(buttonGroup);
  controller.handleChildListMutation(delayedRoot, [buttonGroup], []);
  controller.scan(buttonGroup);
  frames.flush();
  strictEqual(directButtons(delayedRoot).length, 1);

  const wrapper = dom.window.document.createElement("section");
  wrapper.id = "added-popup";
  wrapper.innerHTML = popupMarkup("added-author", "Added");
  dom.window.document.body.append(wrapper);
  controller.handleChildListMutation(dom.window.document.body, [wrapper], []);
  controller.scan(wrapper);
  frames.flush();
  strictEqual(
    directButtons(requiredElement(dom, "#added-popup .hover-root")).length,
    1,
  );
});

test("BUG-007 restores a button removed during a native child-list update and settles its own addition", () => {
  const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
    "repair-author",
    "Repair",
  )}</body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);
  controller.scan(dom.window.document.body);
  frames.flush();
  const root = requiredElement<HTMLElement>(dom, ".hover-root");
  const originalButton = requiredButton(dom);

  const nativeUpdate = dom.window.document.createElement("span");
  nativeUpdate.textContent = "Native update";
  root.append(nativeUpdate);
  originalButton.remove();
  controller.handleChildListMutation(
    root,
    [nativeUpdate],
    [originalButton],
  );
  controller.scan(nativeUpdate);
  frames.flush();

  const repairedButton = requiredButton(dom);
  strictEqual(repairedButton === originalButton, false);
  repairedButton.click();
  strictEqual(activations[0]?.userId, "repair-author");

  const scheduledAfterRepair = frames.scheduledCount;
  controller.handleChildListMutation(root, [repairedButton], []);
  controller.scan(repairedButton);
  strictEqual(frames.pendingCount, 0);
  strictEqual(frames.scheduledCount, scheduledAfterRepair);
});

test("BUG-007 click-time resolution rejects changed hrefs and disconnected roots", () => {
  for (const scenario of ["ambiguous", "invalid", "disconnected"] as const) {
    const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
      "original-author",
      "Original",
    )}</body>`);
    const activations: HoverAuthorActivation[] = [];
    const { controller, frames } = createController(dom, activations);
    controller.scan(dom.window.document.body);
    frames.flush();
    const root = requiredElement<HTMLElement>(dom, ".hover-root");
    const profile = requiredElement<HTMLAnchorElement>(dom, ".profile");
    const button = requiredButton(dom);

    if (scenario === "ambiguous") {
      const other = dom.window.document.createElement("a");
      other.href = "/people/other-author";
      root.append(other);
    } else if (scenario === "invalid") {
      profile.setAttribute("href", "/question/not-a-profile");
    } else {
      root.remove();
    }
    button.click();

    strictEqual(activations.length, 0, scenario);
  }
});

test("BUG-007 button is accessible, isolated, singular, and uses a safe name fallback", () => {
  const dom = new JSDOM(`<!doctype html><body>${popupMarkup(
    "nameless-author",
    "   ",
  )}</body>`);
  const activations: HoverAuthorActivation[] = [];
  const { controller, frames } = createController(dom, activations);
  let bubbledClicks = 0;
  dom.window.document.body.addEventListener("click", () => {
    bubbledClicks += 1;
  });

  controller.scan(dom.window.document.body);
  frames.flush();
  const root = requiredElement<HTMLElement>(dom, ".hover-root");
  const button = requiredButton(dom);
  const notCancelled = button.dispatchEvent(new dom.window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  }));

  strictEqual(directButtons(root).length, 1);
  strictEqual(button.type, "button");
  strictEqual(button.textContent, "屏蔽");
  strictEqual(button.title, "为该作者选择标签并屏蔽");
  strictEqual(
    button.getAttribute("aria-label"),
    "为悬浮卡片中的作者选择标签并屏蔽",
  );
  strictEqual(notCancelled, false);
  strictEqual(bubbledClicks, 0);
  strictEqual(activations.length, 1);
  strictEqual(activations[0]?.userId, "nameless-author");
  strictEqual(activations[0]?.authorName, "未知作者");
});
