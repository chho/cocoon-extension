import {
  MANAGEMENT_BATCH_SIZE,
  VIRTUALIZATION_THRESHOLD,
  virtualRange,
  type AuthorListItem,
} from "../ui/blacklist-list-values.ts";

export interface AuthorListRenderOptions {
  readonly list: HTMLElement;
  readonly items: readonly AuthorListItem[];
  readonly loadedCount: number;
  readonly candidateCount?: number;
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
  readonly platformId: string;
  readonly userId: string;
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
    if (!before || !after || before.author !== after.author || before.tag !== after.tag)
      return false;
  }
  return true;
}

function controlRole(active: HTMLElement): ControlRole | null {
  if (active.matches("input[type='checkbox']")) return "checkbox";
  if (active.matches("a.author-name")) return "profile";
  return active.matches("button") ? "remove" : null;
}

function focusedControl(list: HTMLElement, state: RenderState | undefined): FocusDescriptor | null {
  const active = list.ownerDocument.activeElement;
  const view = list.ownerDocument.defaultView;
  if (!view || !(active instanceof view.HTMLElement) || !list.contains(active) || !state)
    return null;
  const row = active.closest<HTMLElement>(".author-row");
  if (!row) return null;
  const mountedIndex = Array.from(list.querySelectorAll<HTMLElement>(".author-row")).indexOf(row);
  const role = controlRole(active);
  const item = state.items[state.start + mountedIndex];
  if (mountedIndex < 0 || !role || !item) return null;
  return { platformId: item.author.platformId, userId: item.author.userId, role };
}

function controlForRole(row: HTMLElement | undefined, role: ControlRole): HTMLElement | null {
  if (!row) return null;
  if (role === "checkbox") return row.querySelector("input[type='checkbox']");
  if (role === "profile") return row.querySelector("a.author-name");
  return row.querySelector("button");
}

function restoreFocus(
  options: AuthorListRenderOptions,
  descriptor: FocusDescriptor | null,
  next: RenderState,
): void {
  if (!descriptor) return;
  const nextIndex = options.items.findIndex(
    ({ author }) =>
      author.platformId === descriptor.platformId && author.userId === descriptor.userId,
  );
  const insideRange = nextIndex >= next.start && nextIndex < next.end;
  const mountedIndex = nextIndex - next.start;
  const row = insideRange
    ? options.list.querySelectorAll<HTMLElement>(".author-row").item(mountedIndex)
    : undefined;
  const control = controlForRole(row, descriptor.role);
  if (control) {
    control.focus();
    return;
  }
  (options.focusFallback ?? options.list.parentElement)?.focus();
}

function result(loadedCount: number, mountedRowCount: number, virtualized: boolean) {
  return { loadedCount, mountedRowCount, virtualized };
}

function renderEmpty(
  options: AuthorListRenderOptions,
  previous: RenderState | undefined,
): AuthorListRenderResult {
  if (previous?.end === 0 && options.list.classList.contains("empty-list"))
    return result(0, 0, false);
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
  restoreFocus(options, focus, next);
  return result(0, 0, false);
}

function renderVirtualized(
  options: AuthorListRenderOptions,
  previous: RenderState | undefined,
  loadedCount: number,
): AuthorListRenderResult {
  const range = virtualRange(options.scrollTop, options.viewportHeight, loadedCount);
  const mountedCount = range.end - range.start;
  if (
    previous?.virtualized === true &&
    previous.loadedCount === loadedCount &&
    sameRelevantItems(previous, options.items, range.start, range.end)
  ) {
    return result(loadedCount, mountedCount, true);
  }
  const focus = focusedControl(options.list, previous);
  options.list.replaceChildren();
  options.list.className = "author-list virtual-list";
  options.list.style.height = `${range.totalHeight}px`;
  const rows = options.list.ownerDocument.createElement("div");
  rows.className = "virtual-rows";
  rows.style.transform = `translateY(${range.offset}px)`;
  for (const item of options.items.slice(range.start, range.end))
    rows.append(options.createRow(item));
  options.list.append(rows);
  const next = { virtualized: true, ...range, loadedCount, items: options.items };
  renderStates.set(options.list, next);
  restoreFocus(options, focus, next);
  return result(loadedCount, mountedCount, true);
}

function renderIncremental(
  options: AuthorListRenderOptions,
  previous: RenderState | undefined,
  loadedCount: number,
): AuthorListRenderResult {
  if (
    previous?.virtualized === false &&
    previous.loadedCount === loadedCount &&
    sameRelevantItems(previous, options.items, 0, loadedCount)
  ) {
    return result(loadedCount, loadedCount, false);
  }
  const focus = focusedControl(options.list, previous);
  options.list.replaceChildren();
  options.list.className = "author-list";
  options.list.style.removeProperty("height");
  for (const item of options.items.slice(0, loadedCount))
    options.list.append(options.createRow(item));
  const next: RenderState = {
    virtualized: false,
    start: 0,
    end: loadedCount,
    loadedCount,
    items: options.items,
  };
  renderStates.set(options.list, next);
  restoreFocus(options, focus, next);
  return result(loadedCount, loadedCount, false);
}

export function renderAuthorListRows(options: AuthorListRenderOptions): AuthorListRenderResult {
  const previous = renderStates.get(options.list);
  const loadedCount = Math.min(Math.max(0, options.loadedCount), options.items.length);
  if (options.items.length === 0) return renderEmpty(options, previous);
  const candidateCount = options.candidateCount ?? options.items.length;
  return candidateCount > VIRTUALIZATION_THRESHOLD
    ? renderVirtualized(options, previous, loadedCount)
    : renderIncremental(options, previous, loadedCount);
}
