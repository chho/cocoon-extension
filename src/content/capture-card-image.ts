import html2canvas from "html2canvas-pro";

import type { CardImage } from "./blacklist-state";

const MAX_LONG_EDGE = 1200;
const WEBP_QUALITY = 0.75;

export interface CardRenderOptions {
  readonly allowTaint: false;
  readonly backgroundColor: null;
  readonly logging: false;
  readonly scale: number;
  readonly useCORS: false;
}

export type CardRenderer = (
  card: HTMLElement,
  options: CardRenderOptions,
) => Promise<HTMLCanvasElement>;

export type CanvasEncoder = (
  canvas: HTMLCanvasElement,
  mimeType: "image/webp",
  quality: number,
) => string;

export interface CaptureCardImageDependencies {
  readonly render: CardRenderer;
  readonly encode: CanvasEncoder;
}

export async function renderCardWithLocalScreenshotLibrary(
  card: HTMLElement,
  options: CardRenderOptions,
): Promise<HTMLCanvasElement> {
  return html2canvas(card, options);
}

const DEFAULT_DEPENDENCIES: CaptureCardImageDependencies = {
  render: renderCardWithLocalScreenshotLibrary,
  encode(canvas, mimeType, quality) {
    return canvas.toDataURL(mimeType, quality);
  },
};

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export function constrainCanvasSize(
  width: number,
  height: number,
  maxLongEdge = MAX_LONG_EDGE,
): CanvasSize | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    maxLongEdge <= 0
  ) {
    return null;
  }

  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function resizeCanvas(source: HTMLCanvasElement, size: CanvasSize): HTMLCanvasElement {
  if (source.width === size.width && source.height === size.height) {
    return source;
  }

  const resized = document.createElement("canvas");
  resized.width = size.width;
  resized.height = size.height;
  const context = resized.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D context is unavailable.");
  }

  context.drawImage(source, 0, 0, size.width, size.height);
  return resized;
}

export async function captureCardImage(
  card: HTMLElement,
  dependencies: CaptureCardImageDependencies = DEFAULT_DEPENDENCIES,
): Promise<CardImage> {
  const bounds = card.getBoundingClientRect();
  const requestedSize = constrainCanvasSize(bounds.width, bounds.height);
  if (!requestedSize) {
    throw new Error("The card has no capturable rendered area.");
  }

  const captureScale = Math.min(
    1,
    MAX_LONG_EDGE / Math.max(bounds.width, bounds.height),
  );
  const captured = await dependencies.render(card, {
    allowTaint: false,
    backgroundColor: null,
    logging: false,
    scale: captureScale,
    useCORS: false,
  });
  const outputSize = constrainCanvasSize(captured.width, captured.height);
  if (!outputSize) {
    throw new Error("The screenshot canvas is invalid.");
  }

  const output = resizeCanvas(captured, outputSize);
  const dataUrl = dependencies.encode(output, "image/webp", WEBP_QUALITY);
  if (!dataUrl.startsWith("data:image/webp;")) {
    throw new Error("The browser did not encode WebP.");
  }

  return {
    dataUrl,
    width: output.width,
    height: output.height,
  };
}
