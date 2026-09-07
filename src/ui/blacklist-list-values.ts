import type {
  BlacklistAuthorListItemDto,
  BlacklistTimeDirection,
} from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistAuthorDto } from "../core/blacklist-rpc-contract.ts";

export type AuthorListItem = BlacklistAuthorListItemDto;
export type TimeSortDirection = BlacklistTimeDirection;

function timestampValue(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatSource(source: BlacklistAuthorDto["source"]): string {
  return source === "direct" ? "手动屏蔽" : "来自点赞者";
}

export function formatPlatformId(platformId: string): string {
  if (platformId === "zhihu") return "知乎";
  if (platformId === "youtube") return "YouTube";
  return platformId;
}

export function formatLocalTime(value: string | null, locale = "zh-CN"): string {
  const timestamp = timestampValue(value);
  if (timestamp === null) return "时间未知";
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

export function virtualRange(
  scrollTop: number,
  viewportHeight: number,
  loadedCount: number,
  overscan = 4,
): VirtualRange {
  const safeLoaded = Number.isSafeInteger(loadedCount) ? Math.max(0, loadedCount) : 0;
  const safeScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const safeOverscan = Number.isSafeInteger(overscan) ? Math.max(0, overscan) : 0;
  const visibleStart = Math.floor(safeScrollTop / VIRTUAL_ROW_HEIGHT);
  const start = Math.min(safeLoaded, Math.max(0, visibleStart - safeOverscan));
  const visibleEnd = Math.ceil((safeScrollTop + safeViewportHeight) / VIRTUAL_ROW_HEIGHT);
  const end = Math.min(safeLoaded, visibleEnd + safeOverscan);
  return {
    start,
    end: Math.max(start, end),
    offset: start * VIRTUAL_ROW_HEIGHT,
    totalHeight: safeLoaded * VIRTUAL_ROW_HEIGHT,
  };
}
