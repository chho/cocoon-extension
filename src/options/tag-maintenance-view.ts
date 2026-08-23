import type {
  BlacklistAuthorDto,
  BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";

export interface TagMaintenanceViewOptions {
  readonly container: HTMLElement;
  readonly summary: HTMLElement;
  readonly tags: readonly BlacklistTagDto[];
  readonly authors: readonly BlacklistAuthorDto[];
  readonly writesEnabled: boolean;
  readonly pendingTagIds?: ReadonlySet<string>;
  readonly onRename: (
    tag: BlacklistTagDto,
    name: string,
    button: HTMLButtonElement,
  ) => void;
  readonly onDelete: (
    tag: BlacklistTagDto,
    button: HTMLButtonElement,
  ) => void;
}

function tagNameError(
  tags: readonly BlacklistTagDto[],
  tag: BlacklistTagDto,
  rawName: string,
): string | null {
  const name = rawName.trim();
  if (!name) return "标签名称不能为空。";
  if (Array.from(name).length > 30) return "标签名称最多 30 个字符。";
  if (tags.some((candidate) =>
    candidate.tagId !== tag.tagId &&
    candidate.name.trim().toLowerCase() === name.toLowerCase()
  )) return "标签名称已存在。";
  return null;
}

function usageLabel(count: number): string {
  return count === 0 ? "未关联作者" : `${count} 位作者`;
}

export function renderTagMaintenanceView(
  options: TagMaintenanceViewOptions,
): void {
  const document = options.container.ownerDocument;
  const customTags = options.tags.filter((tag) => !tag.isDefault);
  const pendingTagIds = options.pendingTagIds ?? new Set<string>();
  options.container.replaceChildren();
  options.summary.textContent = `${customTags.length} 个自定义标签`;

  if (customTags.length === 0) {
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
    return;
  }

  options.container.setAttribute("role", "list");
  for (const tag of customTags) {
    const authorCount = options.authors.filter((author) =>
      author.tagId === tag.tagId
    ).length;
    const pending = pendingTagIds.has(tag.tagId);
    const row = document.createElement("div");
    row.className = "tag-row";
    row.classList.toggle("tag-pending", pending);
    row.dataset.tagId = tag.tagId;
    row.setAttribute("role", "listitem");
    if (pending) row.setAttribute("aria-busy", "true");

    const resting = document.createElement("div");
    resting.className = "tag-resting";
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
    usage.textContent = usageLabel(authorCount);
    copy.append(name, usage);
    identity.append(mark, copy);

    const actions = document.createElement("div");
    actions.className = "tag-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "tag-action";
    rename.textContent = "重命名";
    rename.disabled = !options.writesEnabled;
    rename.setAttribute("aria-label", `重命名标签 ${tag.name}`);
    if (pending) rename.setAttribute("aria-disabled", "true");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tag-action tag-delete";
    remove.textContent = "删除";
    remove.disabled = !options.writesEnabled;
    remove.setAttribute("aria-label", `删除标签 ${tag.name}`);
    if (pending) remove.setAttribute("aria-disabled", "true");
    remove.addEventListener("click", () => {
      if (remove.disabled || remove.getAttribute("aria-disabled") === "true") return;
      options.onDelete(tag, remove);
    });
    actions.append(rename, remove);
    resting.append(identity, actions);

    const editor = document.createElement("form");
    editor.className = "tag-editor";
    editor.hidden = true;
    const label = document.createElement("label");
    label.className = "visually-hidden";
    const inputId = `tag-editor-${options.tags.indexOf(tag) + 1}`;
    label.htmlFor = inputId;
    label.textContent = `标签名称 ${tag.name}`;
    const input = document.createElement("input");
    input.id = inputId;
    input.type = "text";
    input.value = tag.name;
    input.maxLength = 60;
    input.autocomplete = "off";
    input.readOnly = pending;
    const editorActions = document.createElement("div");
    editorActions.className = "tag-editor-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tag-action";
    cancel.textContent = "取消";
    if (pending) cancel.setAttribute("aria-disabled", "true");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "tag-save";
    save.textContent = "保存";
    if (pending) save.setAttribute("aria-disabled", "true");

    const updateSaveState = (): void => {
      save.disabled = !options.writesEnabled || input.value.trim() === tag.name;
    };
    const closeEditor = (): void => {
      input.value = tag.name;
      input.setCustomValidity("");
      updateSaveState();
      editor.hidden = true;
      resting.hidden = false;
      rename.focus();
    };
    rename.addEventListener("click", () => {
      if (rename.disabled || rename.getAttribute("aria-disabled") === "true") return;
      resting.hidden = true;
      editor.hidden = false;
      input.value = tag.name;
      updateSaveState();
      input.focus();
      input.select();
    });
    cancel.addEventListener("click", () => {
      if (cancel.getAttribute("aria-disabled") === "true") return;
      closeEditor();
    });
    input.addEventListener("input", () => {
      input.setCustomValidity("");
      updateSaveState();
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (row.getAttribute("aria-busy") === "true") return;
      closeEditor();
    });
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.getAttribute("aria-disabled") === "true") return;
      const error = tagNameError(options.tags, tag, input.value);
      if (error) {
        input.setCustomValidity(error);
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      options.onRename(tag, input.value, save);
    });
    updateSaveState();
    editorActions.append(cancel, save);
    editor.append(label, input, editorActions);
    row.append(resting, editor);
    options.container.append(row);
  }
}
