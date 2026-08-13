import { DEFAULT_TAG_ID, type CocoonTag } from "./blacklist-state.ts";

export interface TagListActions {
  readonly selectTag: (tag: CocoonTag) => void;
  readonly deleteTag: (tagId: string, event: MouseEvent) => void;
}

export function renderTagList(
  container: HTMLElement,
  tags: readonly CocoonTag[],
  actions: TagListActions,
): void {
  const document = container.ownerDocument;
  container.replaceChildren();

  for (const tag of tags) {
    const tagItem = document.createElement("span");
    tagItem.className = "cocoon-tag-item";

    const tagButton = document.createElement("button");
    tagButton.type = "button";
    tagButton.className = "cocoon-tag-choice";
    tagButton.textContent = tag.name;
    tagButton.setAttribute(
      "aria-label",
      `使用标签 ${tag.name} 并屏蔽作者`,
    );
    tagButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      actions.selectTag(tag);
    });
    tagItem.append(tagButton);

    if (tag.tagId !== DEFAULT_TAG_ID) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "cocoon-tag-delete";
      deleteButton.textContent = "×";
      deleteButton.setAttribute("aria-label", `删除标签 ${tag.name}`);
      deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        actions.deleteTag(tag.tagId, event);
      });
      tagItem.append(deleteButton);
    }

    container.append(tagItem);
  }
}
