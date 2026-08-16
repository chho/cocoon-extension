import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createRemoteOptionsView } from "./remote-options-view.ts";
import { createDefaultRemotePreferences } from "./remote-preferences.ts";

test("UI-006/AC-050 removes the visible section title while preserving labeled options", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const changes: Array<readonly [string, boolean]> = [];
  const view = createRemoteOptionsView(dom.window.document, (key, value) => {
    changes.push([key, value]);
  });
  dom.window.document.body.append(view.element);

  strictEqual(view.element.getAttribute("aria-label"), "知乎远程操作");
  strictEqual(view.element.textContent?.includes("知乎操作"), false);
  strictEqual(view.element.querySelectorAll("label").length, 2);
  strictEqual(view.element.querySelectorAll("input[type=checkbox]").length, 2);

  const authorInput = view.element.querySelector<HTMLInputElement>(
    "#cocoon-block-author-on-zhihu",
  );
  if (!authorInput) throw new Error("Missing author option.");
  authorInput.click();
  deepStrictEqual(changes, [["blockAuthorOnZhihu", true]]);
});

test("HOVER-007/UI-009/AC-056 disables voters without extra copy or preference writes", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const changes: Array<readonly [string, boolean]> = [];
  const view = createRemoteOptionsView(dom.window.document, (key, value) => {
    changes.push([key, value]);
  });
  view.renderPreferences({
    ...createDefaultRemotePreferences(),
    blockAuthorOnZhihu: true,
    blockContentVoters: true,
  });
  view.setVoterAvailable(false);

  const voterInput = view.element.querySelector<HTMLInputElement>(
    "#cocoon-block-content-voters",
  );
  if (!voterInput) throw new Error("Missing voter option.");
  strictEqual(voterInput.checked, true);
  strictEqual(voterInput.disabled, true);
  strictEqual(voterInput.getAttribute("aria-describedby"), null);
  strictEqual(
    view.element.textContent?.includes("当前入口不支持点赞者操作"),
    false,
  );
  strictEqual(view.element.querySelector(".cocoon-voter-availability"), null);
  deepStrictEqual(view.getAuthorization(false), {
    blockAuthorOnZhihu: true,
    blockContentVoters: false,
  });
  deepStrictEqual(changes, []);

  view.setVoterAvailable(true);
  strictEqual(voterInput.checked, true);
  deepStrictEqual(view.getAuthorization(true), {
    blockAuthorOnZhihu: true,
    blockContentVoters: true,
  });
});
