import type {
  BlacklistAuthorDto,
  BlacklistAuthorIdentityDto,
} from "../core/blacklist-rpc-contract.ts";
import {
  formatLocalTime,
  formatPlatformId,
  formatSource,
  type AuthorListItem,
} from "../ui/blacklist-list-values.ts";
import { createAuthorProfileUrl } from "../ui/zhihu-profile-url.ts";

interface OptionsAuthorRowOptions {
  readonly document: Document;
  readonly item: AuthorListItem;
  readonly writesEnabled: boolean;
  readonly selected: boolean;
  readonly onSelectionChange: (identity: BlacklistAuthorIdentityDto, selected: boolean) => boolean;
  readonly onRemove: (author: BlacklistAuthorDto, button: HTMLButtonElement) => void;
}

export function createOptionsAuthorRow(options: OptionsAuthorRowOptions): HTMLElement {
  const { document, item, writesEnabled } = options;
  const { author, tag } = item;
  const row = document.createElement("div");
  row.className = "author-row";
  row.setAttribute("role", "listitem");

  const identity = { platformId: author.platformId, userId: author.userId };
  const selection = document.createElement("input");
  selection.type = "checkbox";
  selection.checked = options.selected;
  selection.setAttribute("aria-label", `选择 ${author.authorName || "未知作者"}`);
  selection.disabled = !writesEnabled;
  selection.addEventListener("change", () => {
    if (!options.onSelectionChange(identity, selection.checked)) {
      selection.checked = !selection.checked;
    }
  });

  const profileUrl = createAuthorProfileUrl(author.platformId, author.userId);
  const name = profileUrl ? document.createElement("a") : document.createElement("span");
  name.className = "author-name";
  name.textContent = author.authorName || "未知作者";
  if (name instanceof document.defaultView!.HTMLAnchorElement) {
    name.href = profileUrl!;
    name.target = "_blank";
    name.rel = "noopener";
  }

  const tagName = document.createElement("span");
  tagName.className = "tag-name";
  tagName.textContent = tag.name;
  const platform = document.createElement("span");
  platform.className = "platform-name";
  platform.textContent = formatPlatformId(author.platformId);
  const source = document.createElement("span");
  source.className = "source-name";
  source.textContent = formatSource(author.source);
  const time = document.createElement("time");
  time.textContent = formatLocalTime(author.blacklistedAt);
  if (author.blacklistedAt) time.dateTime = author.blacklistedAt;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-text";
  remove.textContent = "解除屏蔽";
  remove.setAttribute("aria-label", `解除屏蔽 ${author.authorName || "未知作者"}`);
  remove.disabled = !writesEnabled;
  remove.addEventListener("click", () => {
    options.onRemove(author, remove);
  });

  row.append(selection, name, tagName, platform, source, time, remove);
  return row;
}
