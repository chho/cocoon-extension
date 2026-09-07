import {
  BLACKLIST_PLATFORM_PAGE_SIZE,
  BLACKLIST_QUERY_PAGE_SIZE,
  BLACKLIST_TAG_PAGE_SIZE,
  createBlacklistQueryRequest,
  type BlacklistAuthorListItemDto,
  type BlacklistQueryResponse,
  type BlacklistSummaryDto,
  type BlacklistTagUsageDto,
  type BlacklistTimeDirection,
} from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistQueryRpcClient } from "../ui/background-rpc.ts";

export interface OptionsAuthorQuery {
  readonly search: string;
  readonly tagId: string | null;
  readonly platformId: string | null;
  readonly direction: BlacklistTimeDirection;
}

export interface OptionsAuthorPage extends BlacklistSummaryDto {
  readonly items: readonly BlacklistAuthorListItemDto[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface OptionsBoundedState {
  readonly summary: BlacklistSummaryDto;
  readonly tags: readonly BlacklistTagUsageDto[];
  readonly platforms: readonly string[];
  readonly authorQuery: OptionsAuthorQuery;
  readonly authorPage: OptionsAuthorPage;
}

export class StaleOptionsQueryError extends Error {
  constructor() {
    super("The options query revision is stale.");
  }
}

export class UnreadableOptionsQueryError extends Error {
  constructor() {
    super("The options query could not be read.");
  }
}

function responseData<Response extends BlacklistQueryResponse>(
  response: Response,
): NonNullable<Response["data"]> {
  if (!response.ok || !response.data) {
    if (response.error === "stale-cursor") throw new StaleOptionsQueryError();
    throw new UnreadableOptionsQueryError();
  }
  return response.data as NonNullable<Response["data"]>;
}

function hasSummary(data: BlacklistSummaryDto, expected: BlacklistSummaryDto): boolean {
  return (
    data.revision === expected.revision &&
    data.authorCount === expected.authorCount &&
    data.tagCount === expected.tagCount
  );
}

function requireSummary(data: BlacklistSummaryDto, expected: BlacklistSummaryDto): void {
  if (!hasSummary(data, expected)) throw new StaleOptionsQueryError();
}

function appendUniqueTags(
  target: BlacklistTagUsageDto[],
  page: readonly BlacklistTagUsageDto[],
  tagIds: Set<string>,
  tagNames: Set<string>,
): void {
  for (const tag of page) {
    const nameKey = tag.name.trim().toLocaleLowerCase("zh-CN");
    if (tagIds.has(tag.tagId) || tagNames.has(nameKey)) throw new UnreadableOptionsQueryError();
    tagIds.add(tag.tagId);
    tagNames.add(nameKey);
    target.push(tag);
  }
}

function advanceCursor(next: string | null, cursors: Set<string>): string | null {
  if (next === null) return null;
  if (cursors.has(next)) throw new UnreadableOptionsQueryError();
  cursors.add(next);
  return next;
}

function requireCompleteTags(
  tags: readonly BlacklistTagUsageDto[],
  summary: BlacklistSummaryDto,
): void {
  const defaultCount = tags.filter((tag) => tag.isDefault && tag.tagId === "default").length;
  if (tags.length !== summary.tagCount || defaultCount !== 1) {
    throw new UnreadableOptionsQueryError();
  }
}

async function loadTags(
  rpc: BlacklistQueryRpcClient,
  summary: BlacklistSummaryDto,
): Promise<readonly BlacklistTagUsageDto[]> {
  const tags: BlacklistTagUsageDto[] = [];
  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await rpc.query(
      createBlacklistQueryRequest("tags-page", {
        revision: summary.revision,
        cursor,
        limit: BLACKLIST_TAG_PAGE_SIZE,
      }),
    );
    if (response.operation !== "tags-page") throw new UnreadableOptionsQueryError();
    const data = responseData(response);
    requireSummary(data, summary);
    appendUniqueTags(tags, data.tags, tagIds, tagNames);
    cursor = advanceCursor(data.nextCursor, cursors);
  } while (cursor !== null);
  requireCompleteTags(tags, summary);
  return tags;
}

async function loadPlatforms(
  rpc: BlacklistQueryRpcClient,
  summary: BlacklistSummaryDto,
): Promise<readonly string[]> {
  const platforms: string[] = [];
  const platformIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await rpc.query(
      createBlacklistQueryRequest("platforms-page", {
        revision: summary.revision,
        cursor,
        limit: BLACKLIST_PLATFORM_PAGE_SIZE,
      }),
    );
    if (response.operation !== "platforms-page") throw new UnreadableOptionsQueryError();
    const data = responseData(response);
    requireSummary(data, summary);
    for (const platformId of data.platforms) {
      if (platformIds.has(platformId)) throw new UnreadableOptionsQueryError();
      platformIds.add(platformId);
      platforms.push(platformId);
    }
    cursor = data.nextCursor;
    if (cursor !== null && cursors.has(cursor)) throw new UnreadableOptionsQueryError();
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return platforms;
}

export async function loadOptionsAuthorPage(
  rpc: BlacklistQueryRpcClient,
  summary: BlacklistSummaryDto,
  query: OptionsAuthorQuery,
  cursor: string | null,
): Promise<OptionsAuthorPage> {
  const response = await rpc.query(
    createBlacklistQueryRequest("authors-page", {
      revision: summary.revision,
      cursor,
      limit: BLACKLIST_QUERY_PAGE_SIZE,
      search: query.search.trim(),
      searchScope: "author",
      tagId: query.tagId,
      platformId: query.platformId,
      direction: query.direction,
    }),
  );
  if (response.operation !== "authors-page") throw new UnreadableOptionsQueryError();
  const data = responseData(response);
  requireSummary(data, summary);
  return data;
}

export async function loadOptionsBoundedState(
  rpc: BlacklistQueryRpcClient,
  authorQuery: OptionsAuthorQuery,
): Promise<OptionsBoundedState> {
  const summaryResponse = await rpc.query(createBlacklistQueryRequest("summary", {}));
  if (summaryResponse.operation !== "summary") throw new UnreadableOptionsQueryError();
  const summary = responseData(summaryResponse);
  const [tags, platforms, authorPage] = await Promise.all([
    loadTags(rpc, summary),
    loadPlatforms(rpc, summary),
    loadOptionsAuthorPage(rpc, summary, authorQuery, null),
  ]);
  return { summary, tags, platforms, authorQuery, authorPage };
}
