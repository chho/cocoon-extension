interface TagReorderOptions {
  isEnabled: () => boolean;
  move: (movedId: string, beforeId: string | null) => void;
  announce: (message: string) => void;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Gesture {
  pointerId: number;
  chip: HTMLElement;
  area: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  preview: HTMLElement | null;
}

function intersect(a: Bounds, b: Bounds): Bounds {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function clientBounds(element: HTMLElement): Bounds {
  const rect = element.getBoundingClientRect();
  const left = rect.left + element.clientLeft;
  const top = rect.top + element.clientTop;
  return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
}

function visibleBounds(area: HTMLElement): Bounds {
  const view = area.ownerDocument.defaultView!;
  let bounds = intersect(clientBounds(area), {
    left: 0,
    top: 0,
    right: view.innerWidth,
    bottom: view.innerHeight,
  });
  for (let parent = area.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    const rect = clientBounds(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow)) {
      bounds = {
        ...bounds,
        left: Math.max(bounds.left, rect.left),
        right: Math.min(bounds.right, rect.right),
      };
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow)) {
      bounds = {
        ...bounds,
        top: Math.max(bounds.top, rect.top),
        bottom: Math.min(bounds.bottom, rect.bottom),
      };
    }
  }
  return bounds;
}

function customChips(area: HTMLElement): HTMLElement[] {
  return [...area.querySelectorAll<HTMLElement>(".cocoon-tag-item[data-tag-id]")].filter(
    (chip) => chip.dataset.tagId !== "default",
  );
}

function containsPoint(bounds: Bounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function overlapsDefault(area: HTMLElement, bounds: Bounds): boolean {
  const item = area.querySelector<HTMLElement>('.cocoon-tag-item[data-tag-id="default"]');
  if (!item) return false;
  const rect = item.getBoundingClientRect();
  return (
    bounds.right >= rect.left &&
    bounds.left <= rect.right &&
    bounds.bottom >= rect.top &&
    bounds.top <= rect.bottom
  );
}

function dropTarget(gesture: Gesture): { chip: HTMLElement; after: boolean } | null {
  const bounds = visibleBounds(gesture.area);
  const { x, y } = gesture;
  if (!containsPoint(bounds, x, y)) return null;
  if (overlapsDefault(gesture.area, { left: x, right: x, top: y, bottom: y })) return null;
  const source = gesture.chip.getBoundingClientRect();
  if (containsPoint(source, x, y)) return null;
  const candidates = customChips(gesture.area)
    .filter((chip) => chip !== gesture.chip)
    .map((chip) => ({ chip, rect: chip.getBoundingClientRect() }));
  const visible = candidates.filter(
    ({ rect }) =>
      rect.bottom > bounds.top &&
      rect.top < bounds.bottom &&
      rect.right > bounds.left &&
      rect.left < bounds.right,
  );
  visible.sort((a, b) => {
    const vertical = (rect: DOMRect) => Math.max(rect.top - y, y - rect.bottom, 0);
    const rowDistance = vertical(a.rect) - vertical(b.rect);
    return (
      rowDistance ||
      Math.abs(x - (a.rect.left + a.rect.width / 2)) -
        Math.abs(x - (b.rect.left + b.rect.width / 2))
    );
  });
  const target = visible[0];
  return target ? { chip: target.chip, after: x > target.rect.left + target.rect.width / 2 } : null;
}

function createPreview(gesture: Gesture): HTMLElement {
  const preview = gesture.chip.cloneNode(true) as HTMLElement;
  preview.className = "cocoon-tag-drag-preview";
  preview.removeAttribute("data-tag-id");
  preview.removeAttribute("id");
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  for (const child of preview.querySelectorAll<HTMLElement>("*")) {
    child.removeAttribute("id");
    child.removeAttribute("data-tag-id");
    child.classList.remove("cocoon-tag-item");
    child.tabIndex = -1;
  }
  Object.assign(preview.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
    boxSizing: "border-box",
    margin: "0",
  });
  gesture.area.append(preview);
  return preview;
}

function positionPreview(gesture: Gesture): void {
  const preview = gesture.preview;
  if (!preview) return;
  const bounds = visibleBounds(gesture.area);
  const area = gesture.area.getBoundingClientRect();
  const chip = gesture.chip.getBoundingClientRect();
  const width = Math.max(0, Math.min(chip.width, 120, bounds.right - bounds.left));
  const height = Math.max(0, Math.min(chip.height, 32, bounds.bottom - bounds.top));
  const left = Math.max(bounds.left, Math.min(gesture.x - width / 2, bounds.right - width));
  const top = Math.max(bounds.top, Math.min(gesture.y - height / 2, bounds.bottom - height));
  Object.assign(preview.style, {
    visibility: overlapsDefault(gesture.area, {
      left,
      top,
      right: left + width,
      bottom: top + height,
    })
      ? "hidden"
      : "visible",
    width: `${width}px`,
    height: `${height}px`,
    left: `${left - area.left + gesture.area.scrollLeft - gesture.area.clientLeft}px`,
    top: `${top - area.top + gesture.area.scrollTop - gesture.area.clientTop}px`,
  });
}

class TagReorderController {
  private readonly container: HTMLElement;
  private readonly options: TagReorderOptions;
  private readonly view: Window & typeof globalThis;
  private gesture: Gesture | null = null;
  private frame = 0;
  private guardTimer = 0;
  private destroyed = false;

  constructor(container: HTMLElement, options: TagReorderOptions) {
    this.container = container;
    this.options = options;
    this.view = container.ownerDocument.defaultView!;
    container.addEventListener("pointerdown", this.onDown);
    container.addEventListener("lostpointercapture", this.onCancel);
    this.view.addEventListener("keydown", this.onKey, true);
    this.view.addEventListener("pagehide", this.onPageHide);
  }

  isDragging = (): boolean => this.gesture?.preview != null;

  private enabled(): boolean {
    try {
      return !this.destroyed && this.options.isEnabled();
    } catch {
      return false;
    }
  }

  private announce(message: string): void {
    try {
      this.options.announce(message);
    } catch {
      /* Host reporting must not strand a gesture. */
    }
  }

  private choice(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof this.view.Element)) return null;
    if (target.closest(".cocoon-tag-delete")) return null;
    const choice = target.closest<HTMLButtonElement>(".cocoon-tag-choice");
    if (!choice || choice.disabled) return null;
    const chip = choice.closest<HTMLElement>(".cocoon-tag-item[data-tag-id]");
    return chip && chip.parentElement === this.container && chip.dataset.tagId !== "default"
      ? chip
      : null;
  }

  private onDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || !this.enabled()) return;
    const chip = this.choice(event.target);
    if (!chip) return;
    this.cancel();
    this.gesture = {
      pointerId: event.pointerId,
      chip,
      area: this.container,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      preview: null,
    };
    this.view.addEventListener("pointermove", this.onMove, true);
    this.view.addEventListener("pointerup", this.onUp, true);
    this.view.addEventListener("pointercancel", this.onCancel, true);
    this.view.addEventListener("scroll", this.schedule, true);
  };

  private onMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!this.enabled()) {
      this.cancel();
      return;
    }
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (!gesture.preview && Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 6)
      return;
    if (!gesture.preview) {
      this.armGuard();
      gesture.preview = createPreview(gesture);
      gesture.chip.classList.add("cocoon-tag-dragging");
      try {
        this.container.setPointerCapture(gesture.pointerId);
      } catch {
        this.cancel();
        return;
      }
    }
    event.preventDefault();
    this.schedule();
  };

  private schedule = (): void => {
    if (!this.frame && this.isDragging()) this.frame = this.view.requestAnimationFrame(this.paint);
  };

  private clearMarkers(): void {
    this.container
      .querySelectorAll(".cocoon-tag-drop-before,.cocoon-tag-drop-after")
      .forEach((chip) => chip.classList.remove("cocoon-tag-drop-before", "cocoon-tag-drop-after"));
  }

  private paint = (): void => {
    this.frame = 0;
    const gesture = this.gesture;
    if (!gesture) return;
    if (!this.enabled() || !this.container.contains(gesture.chip)) {
      this.cancel();
      return;
    }
    positionPreview(gesture);
    this.clearMarkers();
    const target = dropTarget(gesture);
    target?.chip.classList.add(target.after ? "cocoon-tag-drop-after" : "cocoon-tag-drop-before");
  };

  private onUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    const target = this.isDragging() && this.enabled() ? dropTarget(gesture) : null;
    this.cancel();
    if (!target) return;
    const chips = customChips(gesture.area).filter((chip) => chip !== gesture.chip);
    const before = target.after ? chips[chips.indexOf(target.chip) + 1] : target.chip;
    this.move(gesture.chip, before?.dataset.tagId ?? null);
  };

  private move(chip: HTMLElement, beforeId: string | null): void {
    if (chip.parentElement !== this.container) return;
    const chips = customChips(this.container);
    const index = chips.indexOf(chip);
    if ((chips[index + 1]?.dataset.tagId ?? null) === beforeId) return;
    const remaining = chips.filter((item) => item !== chip);
    const position =
      beforeId === null
        ? chips.length
        : remaining.findIndex((item) => item.dataset.tagId === beforeId) + 1;
    try {
      this.options.move(chip.dataset.tagId!, beforeId);
      this.announce(`标签位置：${position} / ${chips.length}`);
    } catch {
      this.announce("标签排序失败，请重试");
    }
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.isDragging()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancel();
      return;
    }
    if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key) || !this.enabled())
      return;
    const chip = this.choice(event.target);
    if (!chip || event.target !== this.container.ownerDocument.activeElement) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
    this.moveByKeyboard(chip, event.key === "ArrowLeft");
  };

  private moveByKeyboard(chip: HTMLElement, left: boolean): void {
    const chips = customChips(this.container);
    const index = chips.indexOf(chip);
    const next = index + (left ? -1 : 1);
    if (next < 0 || next >= chips.length) return;
    this.move(chip, left ? chips[next]!.dataset.tagId! : (chips[next + 1]?.dataset.tagId ?? null));
  }

  private onCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.gesture?.pointerId) this.cancel();
  };

  private clearGuard = (): void => {
    this.view.clearTimeout(this.guardTimer);
    this.guardTimer = 0;
    this.view.removeEventListener("click", this.onClick, true);
    this.view.removeEventListener("pointerdown", this.clearGuard, true);
    this.view.removeEventListener("pointerup", this.expireGuard, true);
  };

  private armGuard(): void {
    this.clearGuard();
    this.view.addEventListener("click", this.onClick, true);
    this.view.addEventListener("pointerdown", this.clearGuard, true);
    this.view.addEventListener("pointerup", this.expireGuard, true);
  }

  private expireGuard = (): void => {
    this.view.clearTimeout(this.guardTimer);
    this.guardTimer = this.view.setTimeout(this.clearGuard, 1500);
  };

  private onClick = (event: MouseEvent): void => {
    if (event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clearGuard();
  };

  cancel = (): boolean => {
    const gesture = this.gesture;
    if (!gesture) return false;
    const dragging = this.isDragging();
    this.gesture = null;
    this.view.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.view.removeEventListener("pointermove", this.onMove, true);
    this.view.removeEventListener("pointerup", this.onUp, true);
    this.view.removeEventListener("pointercancel", this.onCancel, true);
    this.view.removeEventListener("scroll", this.schedule, true);
    gesture.preview?.remove();
    gesture.chip.classList.remove("cocoon-tag-dragging");
    this.clearMarkers();
    try {
      if (this.container.hasPointerCapture(gesture.pointerId))
        this.container.releasePointerCapture(gesture.pointerId);
    } catch {
      /* Capture may already have been released by the browser. */
    }
    // Cancellation can precede release; keep its guard until release or a fresh gesture.
    if (dragging) {
      this.view.clearTimeout(this.guardTimer);
      this.guardTimer = this.view.setTimeout(this.clearGuard, 30_000);
    }
    return dragging;
  };

  private onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      this.destroy();
      return;
    }
    this.cancel();
    this.clearGuard();
  };

  destroy = (): void => {
    this.cancel();
    this.destroyed = true;
    this.clearGuard();
    this.container.removeEventListener("pointerdown", this.onDown);
    this.container.removeEventListener("lostpointercapture", this.onCancel);
    this.view.removeEventListener("keydown", this.onKey, true);
    this.view.removeEventListener("pagehide", this.onPageHide);
  };
}

export function createTagReorderController(
  container: HTMLElement,
  options: TagReorderOptions,
): { cancel(): boolean; destroy(): void; isDragging(): boolean } {
  return new TagReorderController(container, options);
}
