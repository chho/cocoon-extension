import {
  BLACKLIST_QUERY_PAGE_SIZE,
  createBlacklistQueryRequest,
  type BlacklistAuthorListItemDto,
  type BlacklistQueryError,
  type BlacklistSummaryDto,
} from "../core/blacklist-query-rpc-contract.ts";
import type { StrictBlacklistRpcClient } from "../ui/background-rpc.ts";

export const POPUP_RECENT_LIMIT = 5;

export interface PopupQueryData {
  readonly summary: BlacklistSummaryDto;
  readonly items: readonly BlacklistAuthorListItemDto[];
}

export class PopupQueryError extends Error {
  readonly code: BlacklistQueryError | "transport";

  constructor(code: BlacklistQueryError | "transport") {
    super("Popup blacklist query failed.");
    this.code = code;
  }
}

async function querySummary(
  rpc: StrictBlacklistRpcClient,
  minimumRevision: number,
): Promise<BlacklistSummaryDto> {
  const response = await rpc.query(createBlacklistQueryRequest("summary", {}));
  if (response.operation !== "summary" || !response.ok || !response.data) {
    throw new PopupQueryError(response.error ?? "transport");
  }
  if (response.data.revision < minimumRevision) throw new PopupQueryError("stale-cursor");
  return response.data;
}

async function queryAuthors(
  rpc: StrictBlacklistRpcClient,
  summary: BlacklistSummaryDto,
  query: string,
): Promise<readonly BlacklistAuthorListItemDto[]> {
  const response = await rpc.query(
    createBlacklistQueryRequest("authors-page", {
      revision: summary.revision,
      cursor: null,
      limit: query ? BLACKLIST_QUERY_PAGE_SIZE : POPUP_RECENT_LIMIT,
      search: query,
      searchScope: "author-or-tag",
      tagId: null,
      platformId: null,
      direction: "desc",
    }),
  );
  if (response.operation !== "authors-page" || !response.ok || !response.data) {
    throw new PopupQueryError(response.error ?? "transport");
  }
  if (response.data.revision !== summary.revision) throw new PopupQueryError("invalid-query");
  return response.data.items;
}

async function queryOnce(
  rpc: StrictBlacklistRpcClient,
  query: string,
  minimumRevision: number,
): Promise<PopupQueryData> {
  const summary = await querySummary(rpc, minimumRevision);
  const items = await queryAuthors(rpc, summary, query);
  return { summary, items };
}

export async function queryPopupData(
  rpc: StrictBlacklistRpcClient,
  query: string,
  minimumRevision: number,
): Promise<PopupQueryData> {
  try {
    return await queryOnce(rpc, query, minimumRevision);
  } catch (error) {
    if (!(error instanceof PopupQueryError) || error.code !== "stale-cursor") throw error;
    return queryOnce(rpc, query, minimumRevision);
  }
}
