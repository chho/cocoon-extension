import type {
  BlacklistAuthorDto,
  BlacklistSnapshotDto,
  BlacklistTagDto,
} from "../core/blacklist-rpc-contract.ts";

export type TimeSortDirection = "desc" | "asc";

export interface AuthorListItem {
  readonly author: BlacklistAuthorDto;
  readonly tag: BlacklistTagDto;
}

export interface BlacklistCountSummary {
  readonly authorCount: number;
  readonly tagCount: number;
}

function timestampValue(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function joinAuthorsWithTags(
  snapshot: BlacklistSnapshotDto,
): readonly AuthorListItem[] {
  const tags = new Map(snapshot.tags.map((tag) => [tag.tagId, tag]));
  return snapshot.authors.flatMap((author) => {
    const tag = tags.get(author.tagId);
    return tag ? [{ author, tag }] : [];
  });
}

function compareAuthorIdentity(
  left: AuthorListItem,
  right: AuthorListItem,
): number {
  return left.author.authorName.localeCompare(right.author.authorName) ||
    left.author.userId.localeCompare(right.author.userId);
}

function compareTimestamps(
  left: AuthorListItem,
  right: AuthorListItem,
  direction: TimeSortDirection,
): number {
  const leftTime = timestampValue(left.author.blacklistedAt);
  const rightTime = timestampValue(right.author.blacklistedAt);
  if (leftTime === null && rightTime === null) {
    return compareAuthorIdentity(left, right);
  }
  if (leftTime === null) {
    return 1;
  }
  if (rightTime === null) {
    return -1;
  }
  const timeDifference = direction === "asc"
    ? leftTime - rightTime
    : rightTime - leftTime;
  return timeDifference || compareAuthorIdentity(left, right);
}

export function popupResults(
  snapshot: BlacklistSnapshotDto,
  query: string,
): readonly AuthorListItem[] {
  const items = joinAuthorsWithTags(snapshot);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  if (normalizedQuery) {
    return items.filter(({ author, tag }) =>
      author.authorName.toLocaleLowerCase("zh-CN").includes(normalizedQuery) ||
      tag.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    );
  }
  return [...items]
    .sort((left, right) => compareTimestamps(left, right, "desc"))
    .slice(0, 5);
}

export function managementResults(
  snapshot: BlacklistSnapshotDto,
  query: string,
  tagId: string | null,
  direction: TimeSortDirection,
): readonly AuthorListItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return joinAuthorsWithTags(snapshot)
    .filter(({ author }) =>
      (!normalizedQuery ||
        author.authorName.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) &&
      (tagId === null || author.tagId === tagId)
    )
    .sort((left, right) => compareTimestamps(left, right, direction));
}

export function summarizeBlacklist(
  snapshot: BlacklistSnapshotDto,
): BlacklistCountSummary {
  return {
    authorCount: snapshot.authors.length,
    tagCount: snapshot.tags.length,
  };
}

export function formatSource(source: BlacklistAuthorDto["source"]): string {
  return source === "direct" ? "手动屏蔽" : "来自点赞者";
}

export function formatLocalTime(
  value: string | null,
  locale = "zh-CN",
): string {
  const timestamp = timestampValue(value);
  if (timestamp === null) {
    return "时间未知";
  }
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return "时间未知";
  }
}

export const MANAGEMENT_BATCH_SIZE = 50;
export const VIRTUALIZATION_THRESHOLD = 200;
export const VIRTUAL_ROW_HEIGHT = 64;

export interface VirtualRange {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
  readonly totalHeight: number;
}

export function nextLoadedCount(current: number, total: number): number {
  const safeCurrent = Number.isSafeInteger(current) ? Math.max(0, current) : 0;
  const safeTotal = Number.isSafeInteger(total) ? Math.max(0, total) : 0;
  return Math.min(safeTotal, safeCurrent + MANAGEMENT_BATCH_SIZE);
}

export function virtualRange(
  scrollTop: number,
  viewportHeight: number,
  loadedCount: number,
  overscan = 4,
): VirtualRange {
  const safeLoaded = Number.isSafeInteger(loadedCount)
    ? Math.max(0, loadedCount)
    : 0;
  const safeScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight)
    ? Math.max(0, viewportHeight)
    : 0;
  const safeOverscan = Number.isSafeInteger(overscan) ? Math.max(0, overscan) : 0;
  const visibleStart = Math.floor(safeScrollTop / VIRTUAL_ROW_HEIGHT);
  const start = Math.min(
    safeLoaded,
    Math.max(0, visibleStart - safeOverscan),
  );
  const visibleEnd = Math.ceil(
    (safeScrollTop + safeViewportHeight) / VIRTUAL_ROW_HEIGHT,
  );
  const end = Math.min(safeLoaded, visibleEnd + safeOverscan);
  return {
    start,
    end: Math.max(start, end),
    offset: start * VIRTUAL_ROW_HEIGHT,
    totalHeight: safeLoaded * VIRTUAL_ROW_HEIGHT,
  };
}
