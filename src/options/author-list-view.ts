import {
  MANAGEMENT_BATCH_SIZE,
  VIRTUALIZATION_THRESHOLD,
  virtualRange,
  type AuthorListItem,
} from "../ui/blacklist-view-model.ts";

export interface AuthorListRenderOptions {
  readonly list: HTMLElement;
  readonly items: readonly AuthorListItem[];
  readonly loadedCount: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly createRow: (item: AuthorListItem) => HTMLElement;
  readonly focusFallback?: HTMLElement;
}

export interface AuthorListRenderResult {
  readonly loadedCount: number;
  readonly mountedRowCount: number;
  readonly virtualized: boolean;
}

type ControlRole = "checkbox" | "profile" | "remove";

interface FocusDescriptor {
  readonly rowIndex: number;
  readonly role: ControlRole;
}

interface RenderState {
  readonly virtualized: boolean;
  readonly start: number;
  readonly end: number;
  readonly loadedCount: number;
  readonly items: readonly AuthorListItem[];
}

const renderStates = new WeakMap<HTMLElement, RenderState>();

export function resetAuthorListViewport(viewport: HTMLElement): number {
  viewport.scrollTop = 0;
  return MANAGEMENT_BATCH_SIZE;
}

function sameRelevantItems(
  previous: RenderState,
  items: readonly AuthorListItem[],
  start: number,
  end: number,
): boolean {
  if (previous.start !== start || previous.end !== end) return false;
  for (let index = start; index < end; index += 1) {
    const before = previous.items[index];
    const after = items[index];
    if (
      !before || !after || before.author !== after.author || before.tag !== after.tag
    ) {
      return false;
    }
  }
  return true;
}

function focusedControl(
  list: HTMLElement,
  state: RenderState | undefined,
): FocusDescriptor | null {
  const active = list.ownerDocument.activeElement;
  if (!(active instanceof list.ownerDocument.defaultView!.HTMLElement) ||
    !list.contains(active)) return null;
  const row = active.closest<HTMLElement>(".author-row");
  if (!row) return null;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".author-row"));
  const mountedIndex = rows.indexOf(row);
  if (mountedIndex < 0) return null;
  const role: ControlRole | null = active.matches("input[type='checkbox']")
    ? "checkbox"
    : active.matches("a.author-name")
    ? "profile"
    : active.matches("button")
    ? "remove"
    : null;
  if (!role) return null;
  return {
    rowIndex: (state?.start ?? 0) + mountedIndex,
    role,
  };
}

function restoreFocus(
  options: AuthorListRenderOptions,
  descriptor: FocusDescriptor | null,
  previous: RenderState | undefined,
  next: RenderState,
): void {
  if (!descriptor) return;
  const previousItem = previous?.items[descriptor.rowIndex];
  const nextItem = options.items[descriptor.rowIndex];
  if (
    previousItem && nextItem && previousItem.author === nextItem.author &&
    previousItem.tag === nextItem.tag && descriptor.rowIndex >= next.start &&
    descriptor.rowIndex < next.end
  ) {
    const mountedIndex = descriptor.rowIndex - next.start;
    const row = options.list.querySelectorAll<HTMLElement>(".author-row").item(mountedIndex);
    const control = descriptor.role === "checkbox"
      ? row?.querySelector<HTMLElement>("input[type='checkbox']")
      : descriptor.role === "profile"
      ? row?.querySelector<HTMLElement>("a.author-name")
      : row?.querySelector<HTMLElement>("button");
    if (control) {
      control.focus();
      return;
    }
  }
  (options.focusFallback ?? options.list.parentElement)?.focus();
}

export function renderAuthorListRows(
  options: AuthorListRenderOptions,
): AuthorListRenderResult {
  const previous = renderStates.get(options.list);
  const visibleLoadedCount = Math.min(
    Math.max(0, options.loadedCount),
    options.items.length,
  );
  if (options.items.length === 0) {
    if (previous?.end === 0 && options.list.classList.contains("empty-list")) {
      return { loadedCount: 0, mountedRowCount: 0, virtualized: false };
    }
    const focus = focusedControl(options.list, previous);
    options.list.replaceChildren();
    options.list.className = "author-list empty-list";
    options.list.style.removeProperty("height");
    options.list.textContent = "没有匹配的本地记录";
    const next: RenderState = {
      virtualized: false,
      start: 0,
      end: 0,
      loadedCount: 0,
      items: options.items,
    };
    renderStates.set(options.list, next);
    restoreFocus(options, focus, previous, next);
    return { loadedCount: 0, mountedRowCount: 0, virtualized: false };
  }

  if (options.items.length > VIRTUALIZATION_THRESHOLD) {
    const range = virtualRange(
      options.scrollTop,
      options.viewportHeight,
      visibleLoadedCount,
    );
    if (
      previous?.virtualized === true &&
      previous.loadedCount === visibleLoadedCount &&
      sameRelevantItems(previous, options.items, range.start, range.end)
    ) {
      return {
        loadedCount: visibleLoadedCount,
        mountedRowCount: range.end - range.start,
        virtualized: true,
      };
    }
    const focus = focusedControl(options.list, previous);
    options.list.replaceChildren();
    options.list.className = "author-list virtual-list";
    options.list.style.height = `${range.totalHeight}px`;
    const rows = options.list.ownerDocument.createElement("div");
    rows.className = "virtual-rows";
    rows.style.transform = `translateY(${range.offset}px)`;
    for (const item of options.items.slice(range.start, range.end)) {
      rows.append(options.createRow(item));
    }
    options.list.append(rows);
    const next: RenderState = {
      virtualized: true,
      start: range.start,
      end: range.end,
      loadedCount: visibleLoadedCount,
      items: options.items,
    };
    renderStates.set(options.list, next);
    restoreFocus(options, focus, previous, next);
    return {
      loadedCount: visibleLoadedCount,
      mountedRowCount: range.end - range.start,
      virtualized: true,
    };
  }

  if (
    previous?.virtualized === false &&
    previous.loadedCount === visibleLoadedCount &&
    sameRelevantItems(previous, options.items, 0, visibleLoadedCount)
  ) {
    return {
      loadedCount: visibleLoadedCount,
      mountedRowCount: visibleLoadedCount,
      virtualized: false,
    };
  }
  const focus = focusedControl(options.list, previous);
  options.list.replaceChildren();
  options.list.className = "author-list";
  options.list.style.removeProperty("height");
  for (const item of options.items.slice(0, visibleLoadedCount)) {
    options.list.append(options.createRow(item));
  }
  const next: RenderState = {
    virtualized: false,
    start: 0,
    end: visibleLoadedCount,
    loadedCount: visibleLoadedCount,
    items: options.items,
  };
  renderStates.set(options.list, next);
  restoreFocus(options, focus, previous, next);
  return {
    loadedCount: visibleLoadedCount,
    mountedRowCount: visibleLoadedCount,
    virtualized: false,
  };
}
