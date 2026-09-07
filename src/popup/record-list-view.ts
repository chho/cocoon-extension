import type { BlacklistAuthorListItemDto } from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistAuthorDto } from "../core/blacklist-rpc-contract.ts";
import { formatLocalTime, formatSource } from "../ui/blacklist-list-values.ts";
import { createAuthorProfileUrl } from "../ui/zhihu-profile-url.ts";

export interface PopupRecordListViewOptions {
  readonly list: HTMLUListElement;
  readonly items: readonly BlacklistAuthorListItemDto[];
  readonly queryActive: boolean;
  readonly writesEnabled: boolean;
  readonly onRemove: (author: BlacklistAuthorDto, button: HTMLButtonElement) => void;
}

export function focusPopupSearch(search: HTMLInputElement): void {
  search.focus();
}

export function renderPopupRecordList(options: PopupRecordListViewOptions): void {
  options.list.replaceChildren();
  if (options.items.length === 0) {
    const empty = options.list.ownerDocument.createElement("li");
    empty.className = "empty";
    empty.textContent = options.queryActive ? "没有匹配的本地记录" : "暂无最近屏蔽记录";
    options.list.append(empty);
    return;
  }

  for (const { author, tag } of options.items) {
    const item = options.list.ownerDocument.createElement("li");
    item.className = "record";
    const copy = options.list.ownerDocument.createElement("div");
    const visibleName = author.authorName || "未知作者";
    const profileUrl = createAuthorProfileUrl(author.platformId, author.userId);
    const name = profileUrl
      ? options.list.ownerDocument.createElement("a")
      : options.list.ownerDocument.createElement("span");
    name.className = "author-name";
    name.textContent = visibleName;
    if (name instanceof options.list.ownerDocument.defaultView!.HTMLAnchorElement) {
      name.href = profileUrl!;
      name.target = "_blank";
      name.rel = "noopener";
    }
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
