import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createRemoteOptionsView } from "../../content/remote-options-view.ts";
import { createDefaultRemotePreferences } from "../../content/remote-preferences.ts";
import { getCardContentSource, getCardSourcePost } from "./card-content-source.ts";

test("POST-001 reused cards cannot attach a new post to previously captured voters", () => {
  const { dom, card } = fixture(`<div class="ContentItem" data-zop="{}">${title(ANSWER)}</div>`);
  const captured = getCardContentSource(card);
  const link = card.querySelector<HTMLAnchorElement>(".ContentItem-title a")!;
  strictEqual(getCardSourcePost(card, captured)?.postId, "zhihu:answer:200");
  for (const href of [
    "/question/100/answer/201",
    "/question/101/answer/200",
    "https://zhuanlan.zhihu.com/p/200",
  ]) {
    link.setAttribute("href", href);
    strictEqual(getCardSourcePost(card, captured), null);
  }
  link.setAttribute("href", ANSWER);
  strictEqual(getCardSourcePost(card, null), null);
  dom.window.close();
});

test("POST-001 captures only a single own title with a canonical permalink", () => {
  const { dom, card } = fixture(`<div class="ContentItem" data-zop="{}">
    <h2 class="ContentItem-title"><a href="/question/100/answer/200?tracking=1#x">  Own <b>title</b> </a></h2>
    <div class="RichText">${title("/question/999/answer/888")}</div>
    <div class="ContentItem">${title("/question/999/answer/777")}</div>
  </div>`);
  const captured = getCardContentSource(card);
  deepStrictEqual(getCardSourcePost(card, captured), {
    postId: "zhihu:answer:200",
    platformId: "zhihu",
    kind: "answer",
    contentId: "200",
    title: "Own title",
    url: "https://www.zhihu.com/question/100/answer/200",
  });
  card.querySelector(".ContentItem-title")!.insertAdjacentHTML("afterend", title(ARTICLE));
  strictEqual(getCardSourcePost(card, captured), null);
  card.querySelectorAll(".ContentItem-title").forEach((node) => node.remove());
  strictEqual(getCardSourcePost(card, captured), null);
  dom.window.close();
});

test("POST-001 normalizes article links but rejects credentials and untrusted titles", () => {
  for (const [href, label, expected] of [
    ["https://www.zhihu.com/p/300/", " Article ", "https://zhuanlan.zhihu.com/p/300"],
    ["https://user@www.zhihu.com/question/100/answer/200", "Title", null],
    ["/question/100/answer/200", " ", null],
    ["/question/100/answer/200", "x".repeat(501), null],
  ] as const) {
    const { dom, card } = fixture(
      `<div class="ContentItem" data-zop="{}"><h2 class="ContentItem-title"><a href="${href}">${label}</a></h2></div>`,
    );
    strictEqual(getCardSourcePost(card, getCardContentSource(card))?.url ?? null, expected);
    dom.window.close();
  }
});

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
