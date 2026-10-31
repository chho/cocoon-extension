import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  resolveHoverCardFromItem,
  type HoverAuthorActivation,
} from "../../content/hover-card-controller.ts";
import { createHoverPostTracker } from "./hover-post-tracker.ts";

const HASH = "a".repeat(32);
const ANSWER = "/question/100/answer/200";
const ARTICLE = "https://zhuanlan.zhihu.com/p/300";

function fixture() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://www.zhihu.com/" });
  const { document } = dom.window;
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let pointer: Element | null = null;
  let focus: Element | null = null;
  const tracker = createHoverPostTracker(document, {
    schedule(callback) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancel(id) {
      frames.delete(id);
    },
    isActive(link, mode) {
      return link.contains(mode === "pointer" ? pointer : focus);
    },
  });
  function move(mode: "pointer" | "focus", target: Element | null) {
    const previous = mode === "pointer" ? pointer : focus;
    if (mode === "pointer") pointer = target;
    else focus = target;
    const Event = mode === "pointer" ? dom.window.MouseEvent : dom.window.FocusEvent;
    previous?.dispatchEvent(
      new Event(mode === "pointer" ? "pointerout" : "focusout", {
        bubbles: true,
        relatedTarget: target,
      }),
    );
    target?.dispatchEvent(
      new Event(mode === "pointer" ? "pointerover" : "focusin", {
        bubbles: true,
        relatedTarget: previous,
      }),
    );
  }
  function popup(userId = "synthetic-user", hash: string | null = null, twoItems = false) {
    const root = document.createElement("div");
    root.innerHTML = `<div class="HoverCard-item"><a class="UserLink-link" href="/people/${userId}">Synthetic user</a>${hash ? `<div class="NumberBoard">${["answers", "posts", "followers"].map((section) => `<a class="NumberBoard-item" href="/people/${hash}/${section}"></a>`).join("")}</div>` : ""}</div>${twoItems ? '<div class="HoverCard-item"></div>' : ""}<div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div>`;
    document.body.append(root);
    const button = document.createElement("button");
    root.append(button);
    return {
      root,
      activation(): HoverAuthorActivation {
        const resolved = resolveHoverCardFromItem(
          root.querySelector<HTMLElement>(".HoverCard-item")!,
        );
        if (!resolved) throw new Error("Invalid synthetic popup");
        return {
          ...resolved,
          button,
          anchorBounds: { top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1 },
        };
      },
    };
  }
  return {
    dom,
    document,
    tracker,
    frames,
    move,
    card: (href = ANSWER, userId = "synthetic-user") => createCard(document, href, userId),
    popup,
    async flush() {
      await Promise.resolve();
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback();
      }
    },
    close() {
      tracker.dispose();
      dom.window.close();
    },
  };
}

function createCard(document: Document, href: string, userId: string) {
  const element = document.createElement("div");
  element.className = "TopstoryItem";
  element.innerHTML = `<div class="ContentItem" data-zop="{}"><h2 class="ContentItem-title"><a href="${href}">Synthetic post</a></h2><a class="trigger" href="/people/${userId}"><span>Author</span></a></div>`;
  document.body.append(element);
  return { element, link: element.querySelector<HTMLAnchorElement>(".trigger")! };
}

for (const [name, href, postId] of [
  ["answer", ANSWER, "zhihu:answer:200"],
  ["article", ARTICLE, "zhihu:article:300"],
] as const) {
  test(`POST-006 captures ${name} from a new matching root and retains a DOM-independent snapshot`, () => {
    const f = fixture();
    const card = f.card(href);
    f.move("pointer", card.link);
    const popup = f.popup("synthetic-user", null, true);
    const snapshot = f.tracker.capture(popup.activation());
    strictEqual(snapshot?.postId, postId);
    popup.root.remove();
    card.element.remove();
    strictEqual(snapshot?.title, "Synthetic post");
    f.close();
  });
}

test("POST-006 inline comment identity need not be the post author; verified hash aliases match", () => {
  const f = fixture();
  const card = f.card();
  const comment = f.document.createElement("a");
  comment.href = `/people/${HASH.toUpperCase()}`;
  card.element.append(comment);
  f.move("focus", comment);
  const popup = f.popup("comment-user", HASH);
  strictEqual(f.tracker.capture(popup.activation())?.postId, "zhihu:answer:200");
  strictEqual(popup.activation().userId, "comment-user");
  f.close();
});

for (const alias of [false, true]) {
  test(`POST-006 rejects delayed same-author roots after different-card triggers (alias=${alias})`, () => {
    const f = fixture();
    const first = f.card(ANSWER, "synthetic-user");
    const second = f.card(ARTICLE, alias ? HASH : "synthetic-user");
    f.move("pointer", first.link);
    f.move("pointer", second.link);
    const popup = f.popup("synthetic-user", alias ? HASH : null);
    strictEqual(f.tracker.capture(popup.activation()), null);
    f.move("pointer", first.link);
    popup.root.remove();
    const later = f.popup("synthetic-user");
    strictEqual(f.tracker.capture(later.activation()), null);
    f.close();
  });
}

for (const scenario of [
  "mismatch",
  "preexisting",
  "leave",
  "inactive",
  "multiple",
  "outside",
  "non-profile",
] as const) {
  test(`POST-006 safely rejects ${scenario} context`, () => {
    const f = fixture();
    const card = f.card();
    const existing = scenario === "preexisting" ? f.popup() : null;
    if (scenario === "outside") f.document.body.append(card.link);
    if (scenario === "non-profile") card.link.href = "/people/synthetic-user/answers";
    f.move("pointer", card.link);
    if (scenario === "leave") f.move("pointer", null);
    const popup = existing ?? f.popup(scenario === "mismatch" ? "other-user" : "synthetic-user");
    if (scenario === "multiple") f.popup();
    if (scenario === "inactive") f.move("pointer", f.document.body);
    strictEqual(f.tracker.capture(popup.activation()), null);
    f.close();
  });
}

test("POST-006 ignores transitions inside an anchor and allows moving into the bound popup", async () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  f.move("pointer", card.link.querySelector("span"));
  const popup = f.popup();
  await f.flush();
  f.move("pointer", popup.root.querySelector("a"));
  strictEqual(f.tracker.capture(popup.activation())?.postId, "zhihu:answer:200");
  f.close();
});

test("POST-006 bound provenance survives the neutral gap before entering the popup", async () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const popup = f.popup();
  await f.flush();
  f.move("pointer", f.document.body);
  f.move("pointer", popup.root.querySelector("a"));
  strictEqual(f.tracker.capture(popup.activation())?.postId, "zhihu:answer:200");
  f.close();
});

test("POST-006 a delayed same-author popup after an outside-card trigger has no provenance", () => {
  const f = fixture();
  const card = f.card();
  const outside = f.document.createElement("a");
  outside.href = card.link.href;
  f.document.body.append(outside);
  f.move("pointer", outside);
  f.move("pointer", card.link);
  const popup = f.popup();
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

test("POST-006 an outside-card profile trigger clears previously bound provenance", async () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const popup = f.popup();
  await f.flush();
  const outside = f.document.createElement("a");
  outside.href = card.link.href;
  f.document.body.append(outside);
  f.move("pointer", outside);
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

test("POST-006 pointer/focus disagreement cannot choose either origin", () => {
  const f = fixture();
  const first = f.card();
  const second = f.card(ARTICLE, "other-user");
  f.move("pointer", first.link);
  f.move("focus", second.link);
  const popup = f.popup("other-user");
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

for (const mutation of [
  "detach",
  "identity",
  "trigger",
  "source",
  "source-kind",
  "card-reuse",
] as const) {
  test(`POST-006 ${mutation} invalidates provenance even when restored before RAF`, async () => {
    const f = fixture();
    const card = f.card();
    f.move("pointer", card.link);
    const popup = f.popup();
    await f.flush();
    if (mutation === "detach") {
      popup.root.remove();
      f.document.body.append(popup.root);
    } else if (mutation === "card-reuse") {
      card.element.remove();
      f.document.body.append(card.element);
    } else {
      const link =
        mutation === "identity"
          ? popup.root.querySelector<HTMLAnchorElement>("a")!
          : mutation === "trigger"
            ? card.link
            : card.element.querySelector<HTMLAnchorElement>(".ContentItem-title a")!;
      const original = link.getAttribute("href")!;
      link.href = mutation === "source-kind" ? ARTICLE : "/people/changed";
      link.setAttribute("href", original);
    }
    strictEqual(f.tracker.capture(popup.activation()), null);
    f.close();
  });
}

test("POST-006 removed/reinserted new roots are rejected before their first RAF", () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const popup = f.popup();
  popup.root.remove();
  f.document.body.append(popup.root);
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

test("POST-006 seen roots cannot be reused in a later episode", async () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const popup = f.popup();
  await f.flush();
  f.move("pointer", null);
  popup.root.remove();
  await f.flush();
  f.move("pointer", card.link);
  f.document.body.append(popup.root);
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

test("POST-006 reobserving a reused card quarantines its identity after content changes", () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  f.move("pointer", null);
  const title = card.element.querySelector<HTMLAnchorElement>(".ContentItem-title a")!;
  title.href = ARTICLE;
  f.move("pointer", card.link);
  const popup = f.popup();
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.move("pointer", null);
  title.href = ANSWER;
  popup.root.remove();
  f.move("pointer", card.link);
  const restored = f.popup();
  strictEqual(f.tracker.capture(restored.activation()), null);
  f.close();
});

test("POST-006 source reuse during a trigger cannot be forgotten by starting a fresh episode", () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const title = card.element.querySelector<HTMLAnchorElement>(".ContentItem-title a")!;
  title.href = ARTICLE;
  title.href = ANSWER;
  f.move("pointer", null);
  f.move("pointer", card.link);
  const delayed = f.popup();
  strictEqual(f.tracker.capture(delayed.activation()), null);
  f.close();
});

test("POST-006 capture fails closed if optional source parsing throws", () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const popup = f.popup();
  strictEqual(f.tracker.capture(popup.activation())?.postId, "zhihu:answer:200");
  card.element.querySelector = () => {
    throw new Error("Synthetic DOM failure");
  };
  strictEqual(f.tracker.capture(popup.activation()), null);
  f.close();
});

test("POST-006 BFCache preserves same-author ambiguity across different post triggers", () => {
  const f = fixture();
  const first = f.card();
  f.move("pointer", first.link);
  f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
  f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  const second = f.card(ARTICLE);
  f.move("pointer", second.link);
  const delayed = f.popup();
  strictEqual(f.tracker.capture(delayed.activation()), null);
  f.close();
});

test("POST-006 unrelated document updates without an origin do not schedule provenance work", async () => {
  const f = fixture();
  const unrelated = f.document.createElement("div");
  f.document.body.append(unrelated);
  await Promise.resolve();
  strictEqual(f.frames.size, 0);
  f.move("pointer", unrelated);
  strictEqual(f.frames.size, 0);
  f.close();
});

test("POST-006 pagehide releases work, persisted pageshow starts cleanly, dispose is final", async () => {
  const f = fixture();
  const card = f.card();
  f.move("pointer", card.link);
  const old = f.popup();
  await Promise.resolve();
  strictEqual(f.frames.size, 1);
  f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
  strictEqual(f.frames.size, 0);
  strictEqual(f.tracker.capture(old.activation()), null);
  f.move("pointer", null);
  f.move("pointer", card.link);
  const paused = f.popup();
  await Promise.resolve();
  strictEqual(f.frames.size, 0);
  strictEqual(f.tracker.capture(paused.activation()), null);
  old.root.remove();
  paused.root.remove();
  f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  f.move("pointer", null);
  f.move("pointer", card.link);
  const fresh = f.popup();
  strictEqual(f.tracker.capture(fresh.activation())?.postId, "zhihu:answer:200");
  f.tracker.dispose();
  f.tracker.dispose();
  f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  f.move("pointer", null);
  f.move("pointer", card.link);
  f.popup();
  await Promise.resolve();
  deepStrictEqual([...f.frames], []);
  strictEqual(f.tracker.capture(fresh.activation()), null);
  f.close();
});
