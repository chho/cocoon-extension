import type { BlacklistTagUsageDto } from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistTagDto } from "../core/blacklist-rpc-contract.ts";

export interface TagMaintenanceViewOptions {
  readonly container: HTMLElement;
  readonly summary: HTMLElement;
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly writesEnabled: boolean;
  readonly pendingTagIds?: ReadonlySet<string>;
  readonly onRename: (tag: BlacklistTagDto, name: string, button: HTMLButtonElement) => void;
  readonly onDelete: (tag: BlacklistTagDto, button: HTMLButtonElement) => void;
}

interface RestingTagView {
  readonly element: HTMLElement;
  readonly rename: HTMLButtonElement;
}

type TagFocusRole = "rename" | "delete";

interface TagFocusDescriptor {
  readonly tagId: string;
  readonly rowIndex: number;
  readonly role: TagFocusRole;
  readonly ariaLabel: string | null;
}

export function captureTagMaintenanceFocus(
  document: Document,
  container: HTMLElement,
): TagFocusDescriptor | null {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return null;
  const row = active.closest<HTMLElement>(".tag-row");
  if (!row?.dataset.tagId) return null;
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".tag-row"));
  return {
    tagId: row.dataset.tagId,
    rowIndex: Math.max(0, rows.indexOf(row)),
    role: active.matches(".tag-delete") ? "delete" : "rename",
    ariaLabel: active.getAttribute("aria-label"),
  };
}

function equivalentTagControl(
  container: HTMLElement,
  descriptor: TagFocusDescriptor,
): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const exact = descriptor.ariaLabel
    ? buttons.find((button) => button.getAttribute("aria-label") === descriptor.ariaLabel)
    : null;
  if (exact) return exact;
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".tag-row"));
  const sameTag = rows.find((row) => row.dataset.tagId === descriptor.tagId);
  const fallbackRow = sameTag ?? rows[Math.min(descriptor.rowIndex, Math.max(0, rows.length - 1))];
  const selector =
    descriptor.role === "delete" ? ".tag-delete" : "button[aria-label^='重命名标签 ']";
  return fallbackRow?.querySelector<HTMLButtonElement>(selector) ?? null;
}

export function restoreTagMaintenanceFocus(
  container: HTMLElement,
  descriptor: TagFocusDescriptor | null,
  fallback: HTMLElement,
): void {
  if (!descriptor) return;
  (equivalentTagControl(container, descriptor) ?? fallback).focus();
}

function tagNameError(
  tags: readonly BlacklistTagDto[],
  tag: BlacklistTagDto,
  rawName: string,
): string | null {
  const name = rawName.trim();
  if (!name) return "标签名称不能为空。";
  if (Array.from(name).length > 30) return "标签名称最多 30 个字符。";
  const duplicate = tags.some(
    (candidate) =>
      candidate.tagId !== tag.tagId && candidate.name.trim().toLowerCase() === name.toLowerCase(),
  );
  return duplicate ? "标签名称已存在。" : null;
}

function usageLabel(count: number): string {
  return count === 0 ? "未关联作者" : `${count} 位作者`;
}

function createTagIdentity(document: Document, tag: BlacklistTagUsageDto): HTMLElement {
  const identity = document.createElement("div");
  identity.className = "tag-identity";
  const mark = document.createElement("span");
  mark.className = "tag-mark";
  mark.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "tag-copy";
  const name = document.createElement("strong");
  name.className = "tag-display-name";
  name.textContent = tag.name;
  const usage = document.createElement("p");
  usage.className = "tag-usage";
  usage.textContent = usageLabel(tag.authorCount);
  copy.append(name, usage);
  identity.append(mark, copy);
  return identity;
}

function createActionButton(
  document: Document,
  text: string,
  ariaLabel: string,
  className = "tag-action",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

function createRestingView(
  options: TagMaintenanceViewOptions,
  tag: BlacklistTagUsageDto,
  pending: boolean,
): RestingTagView {
  const document = options.container.ownerDocument;
  const element = document.createElement("div");
  element.className = "tag-resting";
  const actions = document.createElement("div");
  actions.className = "tag-actions";
  const rename = createActionButton(document, "重命名", `重命名标签 ${tag.name}`);
  const remove = createActionButton(
    document,
    "删除",
    `删除标签 ${tag.name}`,
    "tag-action tag-delete",
  );
  rename.disabled = !options.writesEnabled;
  remove.disabled = !options.writesEnabled;
  if (pending) {
    rename.setAttribute("aria-disabled", "true");
    remove.setAttribute("aria-disabled", "true");
  }
  remove.addEventListener("click", () => {
    if (remove.disabled || remove.getAttribute("aria-disabled") === "true") return;
    options.onDelete(tag, remove);
  });
  actions.append(rename, remove);
  element.append(createTagIdentity(document, tag), actions);
  return { element, rename };
}

function createEditorInput(
  document: Document,
  tag: BlacklistTagUsageDto,
  inputId: string,
  pending: boolean,
): { readonly label: HTMLLabelElement; readonly input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "visually-hidden";
  label.htmlFor = inputId;
  label.textContent = `标签名称 ${tag.name}`;
  const input = document.createElement("input");
  input.id = inputId;
  input.type = "text";
  input.value = tag.name;
  input.maxLength = 60;
  input.autocomplete = "off";
  input.readOnly = pending;
  return { label, input };
}

interface CreateTagEditorOptions {
  readonly view: TagMaintenanceViewOptions;
  readonly tag: BlacklistTagUsageDto;
  readonly row: HTMLElement;
  readonly resting: RestingTagView;
  readonly pending: boolean;
  readonly inputId: string;
}

function createTagEditor(context: CreateTagEditorOptions): HTMLElement {
  const { view: options, tag, row, resting, pending, inputId } = context;
  const document = options.container.ownerDocument;
  const editor = document.createElement("form");
  editor.className = "tag-editor";
  editor.hidden = true;
  const { label, input } = createEditorInput(document, tag, inputId, pending);
  const actions = document.createElement("div");
  actions.className = "tag-editor-actions";
  const cancel = createActionButton(document, "取消", `取消重命名标签 ${tag.name}`);
  cancel.removeAttribute("aria-label");
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "tag-save";
  save.textContent = "保存";
  if (pending) {
    cancel.setAttribute("aria-disabled", "true");
    save.setAttribute("aria-disabled", "true");
  }
  const updateSaveState = (): void => {
    save.disabled = !options.writesEnabled || input.value.trim() === tag.name;
  };
  const closeEditor = (): void => {
    input.value = tag.name;
    input.setCustomValidity("");
    updateSaveState();
    editor.hidden = true;
    resting.element.hidden = false;
    resting.rename.focus();
  };
  bindEditorEvents({
    options,
    tag,
    row,
    resting,
    editor,
    input,
    cancel,
    save,
    updateSaveState,
    closeEditor,
  });
  updateSaveState();
  actions.append(cancel, save);
  editor.append(label, input, actions);
  return editor;
}

interface EditorEventContext {
  readonly options: TagMaintenanceViewOptions;
  readonly tag: BlacklistTagUsageDto;
  readonly row: HTMLElement;
  readonly resting: RestingTagView;
  readonly editor: HTMLElement;
  readonly input: HTMLInputElement;
  readonly cancel: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  readonly updateSaveState: () => void;
  readonly closeEditor: () => void;
}

function submitRename(context: EditorEventContext): void {
  if (context.save.getAttribute("aria-disabled") === "true") return;
  const error = tagNameError(context.options.tags, context.tag, context.input.value);
  if (error) {
    context.input.setCustomValidity(error);
    context.input.reportValidity();
    return;
  }
  context.input.setCustomValidity("");
  context.options.onRename(context.tag, context.input.value, context.save);
}

function bindEditorEvents(context: EditorEventContext): void {
  context.resting.rename.addEventListener("click", () => {
    const blocked =
      context.resting.rename.disabled ||
      context.resting.rename.getAttribute("aria-disabled") === "true";
    if (blocked) return;
    context.resting.element.hidden = true;
    context.editor.hidden = false;
    context.input.value = context.tag.name;
    context.updateSaveState();
    context.input.focus();
    context.input.select();
  });
  context.cancel.addEventListener("click", () => {
    if (context.cancel.getAttribute("aria-disabled") !== "true") context.closeEditor();
  });
  context.input.addEventListener("input", () => {
    context.input.setCustomValidity("");
    context.updateSaveState();
  });
  context.editor.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (context.row.getAttribute("aria-busy") !== "true") context.closeEditor();
  });
  context.editor.addEventListener("submit", (event) => {
    event.preventDefault();
    submitRename(context);
  });
}

function createTagRow(
  options: TagMaintenanceViewOptions,
  tag: BlacklistTagUsageDto,
  index: number,
  pending: boolean,
): HTMLElement {
  const row = options.container.ownerDocument.createElement("div");
  row.className = "tag-row";
  row.classList.toggle("tag-pending", pending);
  row.dataset.tagId = tag.tagId;
  row.setAttribute("role", "listitem");
  if (pending) row.setAttribute("aria-busy", "true");
  const resting = createRestingView(options, tag, pending);
  const editor = createTagEditor({
    view: options,
    tag,
    row,
    resting,
    pending,
    inputId: `tag-editor-${index + 1}`,
  });
  row.append(resting.element, editor);
  return row;
}

function renderEmptyTagView(options: TagMaintenanceViewOptions): void {
  const document = options.container.ownerDocument;
  options.container.removeAttribute("role");
  const empty = document.createElement("div");
  empty.className = "tag-empty";
  empty.setAttribute("role", "status");
  const title = document.createElement("strong");
  title.textContent = "暂无自定义标签";
  const guidance = document.createElement("p");
  guidance.textContent = "在知乎屏蔽作者时创建的标签会显示在这里。";
  empty.append(title, guidance);
  options.container.append(empty);
}

export function renderTagMaintenanceView(options: TagMaintenanceViewOptions): void {
  const customTags = options.tags.filter((tag) => !tag.isDefault);
  const pendingTagIds = options.pendingTagIds ?? new Set<string>();
  options.container.replaceChildren();
  options.summary.textContent = `${customTags.length} 个自定义标签`;
  if (customTags.length === 0) {
    renderEmptyTagView(options);
    return;
  }
  options.container.setAttribute("role", "list");
  customTags.forEach((tag, index) => {
    options.container.append(createTagRow(options, tag, index, pendingTagIds.has(tag.tagId)));
  });
}
