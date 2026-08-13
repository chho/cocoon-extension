import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

import {
  captureCardImage,
  constrainCanvasSize,
  renderCardWithLocalScreenshotLibrary,
  type CaptureCardImageDependencies,
} from "./capture-card-image.ts";

test("keeps short card canvases at their rendered dimensions", () => {
  deepStrictEqual(constrainCanvasSize(800, 600), {
    width: 800,
    height: 600,
  });
});

test("scales the long edge to 1200 while preserving aspect ratio", () => {
  deepStrictEqual(constrainCanvasSize(2400, 1200), {
    width: 1200,
    height: 600,
  });
  deepStrictEqual(constrainCanvasSize(600, 1800), {
    width: 400,
    height: 1200,
  });
});

test("rejects invalid canvas dimensions", () => {
  strictEqual(constrainCanvasSize(0, 10), null);
  strictEqual(constrainCanvasSize(Number.NaN, 10), null);
});

interface TestCaptureCard {
  readonly id: string;
  readonly hasInjectedCloseButton: boolean;
  getBoundingClientRect(): DOMRect;
}

function testCard(): HTMLElement {
  const value: TestCaptureCard = {
    id: "clicked-card",
    hasInjectedCloseButton: true,
    getBoundingClientRect() {
      return {
        width: 2400,
        height: 1200,
      } as DOMRect;
    },
  };
  return value as unknown as HTMLElement;
}

function testCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 600 } as HTMLCanvasElement;
}

test("CAP-002/003 and AC-014/016 inject renderer and WebP encoder settings for the exact clicked card", async () => {
  const clickedCard = testCard();
  let renderedCard: HTMLElement | null = null;
  let encodedCanvasWidth = 0;
  let encodedMime = "";
  let encodedQuality = 0;
  const dependencies: CaptureCardImageDependencies = {
    async render(card, options) {
      renderedCard = card;
      const marker = card as unknown as TestCaptureCard;
      strictEqual(marker.id, "clicked-card");
      strictEqual(marker.hasInjectedCloseButton, true);
      deepStrictEqual(options, {
        allowTaint: false,
        backgroundColor: null,
        logging: false,
        scale: 0.5,
        useCORS: false,
      });
      return testCanvas();
    },
    encode(canvas, mimeType, quality) {
      encodedCanvasWidth = canvas.width;
      encodedMime = mimeType;
      encodedQuality = quality;
      return "data:image/webp;base64,AA==";
    },
  };

  const image = await captureCardImage(clickedCard, dependencies);

  strictEqual(renderedCard, clickedCard);
  strictEqual(encodedCanvasWidth, 1200);
  strictEqual(encodedMime, "image/webp");
  strictEqual(encodedQuality, 0.75);
  deepStrictEqual(image, {
    dataUrl: "data:image/webp;base64,AA==",
    width: 1200,
    height: 600,
  });
});

test("AC-016 rejects a renderer encoder result that is not WebP", async () => {
  await rejects(
    captureCardImage(testCard(), {
      async render() {
        return testCanvas();
      },
      encode() {
        return "data:image/png;base64,AA==";
      },
    }),
    /did not encode WebP/,
  );
});

test("BUG-002/AC-030 production renderer accepts oklch and oklab computed colors", async () => {
  const dom = new JSDOM(
    '<!doctype html><div id="card" style="color:oklch(62% 0.18 248);background-color:oklab(70% 0.1 -0.1)">Card</div>',
    {
      pretendToBeVisual: true,
      url: "https://www.zhihu.com/",
      virtualConsole: new VirtualConsole(),
    },
  );
  const { window } = dom;
  const card = window.document.querySelector<HTMLElement>("#card");
  if (!card) throw new Error("Missing modern-color card fixture.");
  strictEqual(window.getComputedStyle(card).color.startsWith("oklch("), true);
  strictEqual(
    window.getComputedStyle(card).backgroundColor.startsWith("oklab("),
    true,
  );

  const canvasContext = {
    canvas: null as HTMLCanvasElement | null,
    save() {},
    restore() {},
    scale() {},
    translate() {},
    transform() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    quadraticCurveTo() {},
    arc() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
    drawImage() {},
    fillText() {},
    strokeText() {},
    measureText() {
      return { width: 20, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    createPattern() {
      return {};
    },
    getImageData() {
      return { data: new Uint8ClampedArray(4) };
    },
    putImageData() {},
    setLineDash() {},
  };
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement) {
      canvasContext.canvas = this;
      return canvasContext;
    },
  });

  const globalValues: ReadonlyArray<readonly [PropertyKey, unknown]> = [
    ["window", window],
    ["document", window.document],
    ["Node", window.Node],
    ["HTMLElement", window.HTMLElement],
    ["HTMLCanvasElement", window.HTMLCanvasElement],
    ["HTMLImageElement", window.HTMLImageElement],
    ["SVGElement", window.SVGElement],
    ["XMLSerializer", window.XMLSerializer],
    ["getComputedStyle", window.getComputedStyle.bind(window)],
    ["navigator", window.navigator],
  ];
  const previousDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const [key, value] of globalValues) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  try {
    const canvas = await renderCardWithLocalScreenshotLibrary(card, {
      allowTaint: false,
      backgroundColor: null,
      logging: false,
      scale: 1,
      useCORS: false,
    });
    strictEqual(canvas instanceof window.HTMLCanvasElement, true);
  } finally {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    dom.window.close();
  }
});
