import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createRemoteOptionsView } from "../../content/remote-options-view.ts";
import { createDefaultRemotePreferences } from "../../content/remote-preferences.ts";
import { getCardContentSource } from "./card-content-source.ts";

const ANSWER = "/question/100/answer/200";
const ARTICLE = "https://zhuanlan.zhihu.com/p/300";
const REFERENCED_ANSWER = "/question/400/answer/500";
const title = (href: string) =>
  `<h2 class="ContentItem-title"><a href="${href}">Synthetic</a></h2>`;

function fixture(html: string) {
  const dom = new JSDOM(`<!doctype html><div class="TopstoryItem">${html}</div>`);
  const card = dom.window.document.querySelector<HTMLElement>(".TopstoryItem")!;
  return { dom, card };
}

for (const scenario of [
  { name: "answer", href: ANSWER, source: { kind: "answer", questionId: "100", contentId: "200" } },
  { name: "article", href: ARTICLE, source: { kind: "article", contentId: "300" } },
]) {
  test(`BUG-018/AC-101 ${scenario.name} expansion preserves source and voter availability`, () => {
    const { dom, card } = fixture(`<div class="ContentItem" data-zop="{}">
      ${title(scenario.href)}
      <div class="RichContent is-collapsed"><div class="RichContent-inner"></div></div>
    </div>`);
    const changes: unknown[] = [];
    const view = createRemoteOptionsView(dom.window.document, (...change) => changes.push(change));
    view.renderPreferences({ ...createDefaultRemotePreferences(), blockContentVoters: true });
    const checkbox = view.element.querySelector<HTMLInputElement>("#cocoon-block-content-voters")!;
    const richContent = card.querySelector<HTMLElement>(".RichContent")!;
    const body = card.querySelector<HTMLElement>(".RichContent-inner")!;
    const expandedHtml = `<span class="RichText"><a href="${REFERENCED_ANSWER}">Reference</a>
      <a href="${ARTICLE}">Article reference</a>
      <div class="ContentItem">${title(REFERENCED_ANSWER)}</div></span>`;
    for (const expanded of [false, true, false]) {
      richContent.classList.toggle("is-collapsed", !expanded);
      body.innerHTML = expanded ? expandedHtml : "";
      const source = getCardContentSource(card);
      deepStrictEqual(source, scenario.source);
      view.setVoterAvailable(source !== null);
      strictEqual(checkbox.disabled, false);
      strictEqual(checkbox.checked, true);
      strictEqual(view.getAuthorization(source !== null).blockContentVoters, true);
    }
    deepStrictEqual(changes, []);
    dom.window.close();
  });
}

for (const scenario of [
  { name: "missing content", html: title(ANSWER) },
  {
    name: "body-only reference",
    html: `<div class="ContentItem" data-zop="{}"><div class="RichContent-inner"><a href="${ANSWER}">Reference</a></div></div>`,
  },
  {
    name: "invalid title with valid body",
    html: `<div class="ContentItem" data-zop="{}">${title("https://example.com/question/100/answer/200")}<div class="RichText"><a href="${ANSWER}">Reference</a></div></div>`,
  },
  {
    name: "ambiguous own titles",
    html: `<div class="ContentItem" data-zop="{}">${title(ANSWER)}${title(REFERENCED_ANSWER)}</div>`,
  },
  {
    name: "nested content title only",
    html: `<div class="ContentItem" data-zop="{}"><div class="ContentItem">${title(ANSWER)}</div></div>`,
  },
  {
    name: "title-shaped body reference",
    html: `<div class="ContentItem" data-zop="{}"><div class="RichText">${title(ANSWER)}</div></div>`,
  },
]) {
  test(`BUG-018/AC-101 ${scenario.name} cannot authorize content voters`, () => {
    const { dom, card } = fixture(scenario.html);
    const changes: unknown[] = [];
    const view = createRemoteOptionsView(dom.window.document, (...change) => changes.push(change));
    view.renderPreferences({ ...createDefaultRemotePreferences(), blockContentVoters: true });
    const source = getCardContentSource(card);
    strictEqual(source, null);
    view.setVoterAvailable(source !== null);
    const checkbox = view.element.querySelector<HTMLInputElement>("#cocoon-block-content-voters")!;
    strictEqual(checkbox.disabled, true);
    strictEqual(checkbox.checked, true);
    strictEqual(view.getAuthorization(source !== null).blockContentVoters, false);
    deepStrictEqual(changes, []);
    dom.window.close();
  });
}
