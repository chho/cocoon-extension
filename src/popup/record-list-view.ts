import type { BlacklistAuthorDto } from "../core/blacklist-rpc-contract.ts";
import {
  formatLocalTime,
  formatSource,
  type AuthorListItem,
} from "../ui/blacklist-view-model.ts";
import { createZhihuProfileUrl } from "../ui/zhihu-profile-url.ts";

export interface PopupRecordListViewOptions {
  readonly list: HTMLUListElement;
  readonly items: readonly AuthorListItem[];
  readonly queryActive: boolean;
  readonly writesEnabled: boolean;
  readonly onRemove: (
    author: BlacklistAuthorDto,
    button: HTMLButtonElement,
  ) => void;
}

export function focusPopupSearch(search: HTMLInputElement): void {
  search.focus();
}

export function renderPopupRecordList(
  options: PopupRecordListViewOptions,
): void {
  options.list.replaceChildren();
  if (options.items.length === 0) {
    const empty = options.list.ownerDocument.createElement("li");
    empty.className = "empty";
    empty.textContent = options.queryActive
      ? "没有匹配的本地记录"
      : "暂无最近屏蔽记录";
    options.list.append(empty);
    return;
  }

  for (const { author, tag } of options.items) {
    const item = options.list.ownerDocument.createElement("li");
    item.className = "record";
    const copy = options.list.ownerDocument.createElement("div");
    const name = options.list.ownerDocument.createElement("a");
    const visibleName = author.authorName || "未知作者";
    name.className = "author-name";
    name.href = createZhihuProfileUrl(author.userId);
    name.target = "_blank";
    name.rel = "noopener";
    name.textContent = visibleName;
    const metadata = options.list.ownerDocument.createElement("p");
    metadata.textContent = `${tag.name} · ${formatSource(author.source)} · ${formatLocalTime(author.blacklistedAt)}`;
    copy.append(name, metadata);

    const remove = options.list.ownerDocument.createElement("button");
    remove.type = "button";
    remove.className = "text-action";
    remove.textContent = "解除屏蔽";
    remove.setAttribute("aria-label", `解除屏蔽 ${visibleName}`);
    remove.disabled = !options.writesEnabled;
    remove.addEventListener("click", () => {
      options.onRemove(author, remove);
    });
    item.append(copy, remove);
    options.list.append(item);
  }
}
