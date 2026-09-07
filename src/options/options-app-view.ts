import type { BlacklistTagUsageDto } from "../core/blacklist-query-rpc-contract.ts";
import { formatPlatformId } from "../ui/blacklist-list-values.ts";

export interface OptionsElements {
  readonly authorTotal: HTMLElement;
  readonly tagTotal: HTMLElement;
  readonly pageMessage: HTMLElement;
  readonly writeError: HTMLElement;
  readonly authorSearch: HTMLInputElement;
  readonly tagFilter: HTMLSelectElement;
  readonly platformFilter: HTMLSelectElement;
  readonly timeSort: HTMLSelectElement;
  readonly removeSelected: HTMLButtonElement;
  readonly viewport: HTMLElement;
  readonly authorList: HTMLElement;
  readonly listSummary: HTMLElement;
  readonly tagsHeading: HTMLElement;
  readonly tagSummary: HTMLElement;
  readonly tagList: HTMLElement;
}

export function requiredOptionsElement<ElementType extends HTMLElement>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Options element is missing: ${selector}`);
  return element;
}

export function resolveOptionsElements(document: Document): OptionsElements {
  return {
    authorTotal: requiredOptionsElement(document, "#author-total"),
    tagTotal: requiredOptionsElement(document, "#tag-total"),
    pageMessage: requiredOptionsElement(document, "#page-message"),
    writeError: requiredOptionsElement(document, "#write-error"),
    authorSearch: requiredOptionsElement(document, "#author-search"),
    tagFilter: requiredOptionsElement(document, "#tag-filter"),
    platformFilter: requiredOptionsElement(document, "#platform-filter"),
    timeSort: requiredOptionsElement(document, "#time-sort"),
    removeSelected: requiredOptionsElement(document, "#remove-selected"),
    viewport: requiredOptionsElement(document, "#author-viewport"),
    authorList: requiredOptionsElement(document, "#author-list"),
    listSummary: requiredOptionsElement(document, "#list-summary"),
    tagsHeading: requiredOptionsElement(document, "#tags-heading"),
    tagSummary: requiredOptionsElement(document, "#tag-summary"),
    tagList: requiredOptionsElement(document, "#tag-list"),
  };
}

interface TagFilterRenderOptions {
  readonly document: Document;
  readonly select: HTMLSelectElement;
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly selectedTagId: string | null;
  readonly tokens: Map<string, string>;
}

export function renderOptionsTagFilter(options: TagFilterRenderOptions): string | null {
  options.tokens.clear();
  const allTags = options.document.createElement("option");
  allTags.value = "";
  allTags.textContent = "全部标签";
  options.select.replaceChildren(allTags);
  const selectedTagId = options.tags.some((tag) => tag.tagId === options.selectedTagId)
    ? options.selectedTagId
    : null;
  let selectedToken = "";
  options.tags.forEach((tag, index) => {
    const token = `tag-filter-${index + 1}`;
    options.tokens.set(token, tag.tagId);
    const option = options.document.createElement("option");
    option.value = token;
    option.textContent = tag.name;
    options.select.add(option);
    if (tag.tagId === selectedTagId) selectedToken = token;
  });
  options.select.value = selectedToken;
  return selectedTagId;
}

interface PlatformFilterRenderOptions {
  readonly document: Document;
  readonly select: HTMLSelectElement;
  readonly platforms: readonly string[];
  readonly selectedPlatformId: string | null;
  readonly tokens: Map<string, string>;
}

export function renderOptionsPlatformFilter(options: PlatformFilterRenderOptions): string | null {
  options.tokens.clear();
  const allPlatforms = options.document.createElement("option");
  allPlatforms.value = "";
  allPlatforms.textContent = "全部站点";
  options.select.replaceChildren(allPlatforms);
  const platformIds = [...options.platforms].sort(
    (left, right) =>
      formatPlatformId(left).localeCompare(formatPlatformId(right), "zh-CN") ||
      left.localeCompare(right),
  );
  const selectedPlatformId = platformIds.includes(options.selectedPlatformId ?? "")
    ? options.selectedPlatformId
    : null;
  let selectedToken = "";
  platformIds.forEach((platformId, index) => {
    const token = `platform-filter-${index + 1}`;
    options.tokens.set(token, platformId);
    const option = options.document.createElement("option");
    option.value = token;
    option.textContent = formatPlatformId(platformId);
    options.select.add(option);
    if (platformId === selectedPlatformId) selectedToken = token;
  });
  options.select.value = selectedToken;
  return selectedPlatformId;
}
