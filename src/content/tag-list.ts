import { DEFAULT_TAG_ID, type CocoonTag } from "./blacklist-state.ts";

export interface TagListActions {
  readonly selectTag: (tag: CocoonTag, event: MouseEvent) => void;
  readonly deleteTag: (tagId: string, event: MouseEvent) => void;
}

function createTagItem(document: Document, tag: CocoonTag, actions: TagListActions): HTMLElement {
  const item = document.createElement("span");
  item.className = "cocoon-tag-item";
  item.dataset.tagId = tag.tagId;
  const choice = document.createElement("button");
  choice.type = "button";
  choice.className = "cocoon-tag-choice";
  choice.textContent = tag.name;
  choice.setAttribute("aria-label", `使用标签 ${tag.name} 并屏蔽作者`);
  choice.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    actions.selectTag(tag, event);
  });
  item.append(choice);
  if (tag.tagId === DEFAULT_TAG_ID) return item;
  choice.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
  choice.title = "拖动排序，或按 Alt+左/右调整位置；点击仍会屏蔽作者";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "cocoon-tag-delete";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `删除标签 ${tag.name}`);
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      !document.defaultView?.confirm(
        `删除标签“${tag.name}”？\n该标签下的账号将移至 default，仍保持屏蔽。`,
      )
    )
      return;
    actions.deleteTag(tag.tagId, event);
  });
  item.append(remove);
  return item;
}

export function renderTagList(
  container: HTMLElement,
  tags: readonly CocoonTag[],
  actions: TagListActions,
): void {
  const document = container.ownerDocument;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "标签；自定义标签可拖动或按 Alt+左/右排序");
  container.replaceChildren();
  for (const tag of tags) container.append(createTagItem(document, tag, actions));
}
