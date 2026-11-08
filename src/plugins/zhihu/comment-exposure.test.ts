import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { captureCommentExposure } from "./comment-exposure.ts";

function fixture() {
  const dom = new JSDOM(`<body>
    <aside class="cocoon-tag-drawer"><button>Tag</button></aside>
    <div class="Comments-container"><div data-id="parent"><a href="/people/parent">Parent</a>
      <div data-id="reply"><a href="/people/reply">Reply</a></div>
    </div><div data-id="other"><a href="/people/other">Other</a></div></div>
    <div role="dialog">Other overlay</div>
  </body>`);
  const document = dom.window.document;
  const drawer = document.querySelector<HTMLElement>("aside")!;
  const parent = document.querySelector<HTMLElement>('[data-id="parent"]')!;
  const reply = document.querySelector<HTMLElement>('[data-id="reply"]')!;
  const button = drawer.querySelector("button")!;
  let stack: Element[] = [button, drawer, reply.querySelector("a")!, reply, parent];
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => stack });
  return {
    dom,
    document,
    drawer,
    parent,
    reply,
    button,
    setStack: (value: Element[]) => {
      stack = value;
    },
  };
}

test("BUG-022 snapshots only the exposed comment ancestry, without altering DOM or selecting siblings", () => {
  const f = fixture();
  try {
    const before = f.document.body.innerHTML;
    const contexts = captureCommentExposure(f.document, { x: 380, y: 500 });
    deepStrictEqual(
      contexts.map((c) => c.root),
      [f.reply, f.parent],
    );
    deepStrictEqual(
      contexts.map((c) => [c.identifier, c.dataId]),
      [
        ["reply", "reply"],
        ["parent", "parent"],
      ],
    );
    strictEqual(f.document.body.innerHTML, before);
  } finally {
    f.dom.window.close();
  }
});

test("BUG-022 missing pointer/hit API, outside points, other overlays and hidden drawers do not guess context", () => {
  const f = fixture();
  try {
    deepStrictEqual(captureCommentExposure(f.document), []);
    deepStrictEqual(captureCommentExposure(f.document, { x: NaN, y: 500 }), []);
    f.setStack([f.reply, f.drawer]);
    deepStrictEqual(captureCommentExposure(f.document, { x: 380, y: 500 }), []);
    f.setStack([f.button, f.drawer, f.document.querySelector('[role="dialog"]')!, f.reply]);
    deepStrictEqual(captureCommentExposure(f.document, { x: 380, y: 500 }), []);
    f.setStack([f.button, f.drawer, f.reply]);
    f.drawer.hidden = true;
    deepStrictEqual(captureCommentExposure(f.document, { x: 380, y: 500 }), []);
    f.drawer.hidden = false;
    Reflect.deleteProperty(f.document, "elementsFromPoint");
    deepStrictEqual(captureCommentExposure(f.document, { x: 380, y: 500 }), []);
  } finally {
    f.dom.window.close();
  }
});
