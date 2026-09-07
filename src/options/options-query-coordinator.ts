import type { BlacklistSummaryDto } from "../core/blacklist-query-rpc-contract.ts";
import type { BlacklistAuthorIdentityDto } from "../core/blacklist-rpc-contract.ts";
import type { StrictBlacklistRpcClient } from "../ui/background-rpc.ts";
import type { AuthorListItem } from "../ui/blacklist-list-values.ts";
import { createLatestRefreshController } from "../ui/latest-refresh-controller.ts";
import {
  loadOptionsAuthorPage,
  loadOptionsBoundedState,
  StaleOptionsQueryError,
  type OptionsAuthorPage,
  type OptionsAuthorQuery,
  type OptionsBoundedState,
} from "./options-query-client.ts";

export interface OptionsAuthorResults {
  readonly items: readonly AuthorListItem[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
}

interface OptionsQueryCoordinatorCallbacks {
  readonly currentQuery: () => OptionsAuthorQuery;
  readonly applyFacets: (state: OptionsBoundedState) => void;
  readonly applyAuthors: (results: OptionsAuthorResults) => void;
  readonly clearAuthors: () => void;
  readonly fail: () => void;
}

export interface OptionsQueryCoordinator {
  refresh(): Promise<void>;
  reloadAuthors(): Promise<void>;
  loadNextAuthors(): Promise<void>;
  acceptMutationSummary(summary: BlacklistSummaryDto): Promise<boolean>;
  updateLoadedAuthors(
    update: (items: readonly AuthorListItem[]) => readonly AuthorListItem[],
    totalCount?: number,
  ): void;
  hasUnloadedAuthors(): boolean;
}

interface RefreshController {
  request(): Promise<void>;
  invalidate(): void;
}

function sameAuthorQuery(left: OptionsAuthorQuery, right: OptionsAuthorQuery): boolean {
  return (
    left.search === right.search &&
    left.tagId === right.tagId &&
    left.platformId === right.platformId &&
    left.direction === right.direction
  );
}

export function optionsIdentityKey(identity: BlacklistAuthorIdentityDto): string {
  return JSON.stringify([identity.platformId, identity.userId]);
}

async function loadLatestBoundedState(
  rpc: StrictBlacklistRpcClient,
  query: OptionsAuthorQuery,
): Promise<OptionsBoundedState> {
  try {
    return await loadOptionsBoundedState(rpc, query);
  } catch (error) {
    if (!(error instanceof StaleOptionsQueryError)) throw error;
    return await loadOptionsBoundedState(rpc, query);
  }
}

function emptyResults(): OptionsAuthorResults {
  return { items: [], totalCount: 0, nextCursor: null };
}

class OptionsQueryCoordinatorImplementation implements OptionsQueryCoordinator {
  private readonly rpc: StrictBlacklistRpcClient;
  private readonly callbacks: OptionsQueryCoordinatorCallbacks;
  private summary: BlacklistSummaryDto | null = null;
  private results: OptionsAuthorResults = emptyResults();
  private requestPending = false;
  private requestSequence = 0;
  private readonly refreshController: RefreshController;

  constructor(rpc: StrictBlacklistRpcClient, callbacks: OptionsQueryCoordinatorCallbacks) {
    this.rpc = rpc;
    this.callbacks = callbacks;
    this.refreshController = createLatestRefreshController<OptionsBoundedState>({
      load: () => loadLatestBoundedState(this.rpc, this.callbacks.currentQuery()),
      apply: (state) => this.applyBoundedState(state),
      fail: () => this.fail(),
    });
  }

  refresh(): Promise<void> {
    this.beginNewRequestSequence();
    this.results = { ...this.results, nextCursor: null };
    return this.refreshController.request();
  }

  async reloadAuthors(): Promise<void> {
    const activeSummary = this.summary;
    if (!activeSummary) return;
    const query = this.callbacks.currentQuery();
    const sequence = this.beginAuthorRequest();
    this.clearAuthors();
    try {
      const page = await loadOptionsAuthorPage(this.rpc, activeSummary, query, null);
      if (sequence === this.requestSequence) this.applyPage(page, false);
    } catch (error) {
      this.handleAuthorFailure(error, sequence);
    } finally {
      this.finishAuthorRequest(sequence);
    }
  }

  async loadNextAuthors(): Promise<void> {
    const activeSummary = this.summary;
    const cursor = this.results.nextCursor;
    if (!activeSummary || !cursor || this.requestPending) return;
    const query = this.callbacks.currentQuery();
    const sequence = this.beginAuthorRequest();
    try {
      const page = await loadOptionsAuthorPage(this.rpc, activeSummary, query, cursor);
      if (sequence === this.requestSequence) this.applyPage(page, true);
    } catch (error) {
      this.handleAuthorFailure(error, sequence);
    } finally {
      this.finishAuthorRequest(sequence);
    }
  }

  async acceptMutationSummary(next: BlacklistSummaryDto): Promise<boolean> {
    if (!this.summary || next.revision > this.summary.revision + 1) {
      await this.refresh();
      return false;
    }
    if (next.revision <= this.summary.revision) return false;
    this.refreshController.invalidate();
    this.beginNewRequestSequence();
    this.results = { ...this.results, nextCursor: null };
    this.summary = next;
    return true;
  }

  updateLoadedAuthors(
    update: (items: readonly AuthorListItem[]) => readonly AuthorListItem[],
    totalCount = this.results.totalCount,
  ): void {
    this.results = {
      items: update(this.results.items),
      totalCount,
      nextCursor: this.results.nextCursor,
    };
    this.callbacks.applyAuthors(this.results);
  }

  hasUnloadedAuthors(): boolean {
    return this.results.nextCursor !== null;
  }

  private beginNewRequestSequence(): number {
    this.requestPending = false;
    this.requestSequence += 1;
    return this.requestSequence;
  }

  private beginAuthorRequest(): number {
    this.requestPending = true;
    this.requestSequence += 1;
    return this.requestSequence;
  }

  private finishAuthorRequest(sequence: number): void {
    if (sequence === this.requestSequence) this.requestPending = false;
  }

  private clearAuthors(): void {
    this.results = emptyResults();
    this.callbacks.clearAuthors();
  }

  private applyPage(page: OptionsAuthorPage, append: boolean): void {
    const retained = append ? this.results.items : [];
    const existingKeys = new Set(
      retained.map(({ author }) =>
        optionsIdentityKey({ platformId: author.platformId, userId: author.userId }),
      ),
    );
    if (append && page.totalCount !== this.results.totalCount) throw new StaleOptionsQueryError();
    for (const { author } of page.items) {
      const key = optionsIdentityKey({ platformId: author.platformId, userId: author.userId });
      if (existingKeys.has(key)) throw new StaleOptionsQueryError();
      existingKeys.add(key);
    }
    this.results = {
      items: [...retained, ...page.items],
      totalCount: page.totalCount,
      nextCursor: page.nextCursor,
    };
    this.callbacks.applyAuthors(this.results);
  }

  private applyBoundedState(state: OptionsBoundedState): void {
    this.beginNewRequestSequence();
    this.summary = state.summary;
    this.callbacks.applyFacets(state);
    if (sameAuthorQuery(state.authorQuery, this.callbacks.currentQuery())) {
      this.applyPage(state.authorPage, false);
      return;
    }
    this.clearAuthors();
    void this.reloadAuthors();
  }

  private handleAuthorFailure(error: unknown, sequence: number): void {
    if (sequence !== this.requestSequence) return;
    if (error instanceof StaleOptionsQueryError) void this.refresh();
    else this.fail();
  }

  private fail(): void {
    this.refreshController.invalidate();
    this.beginNewRequestSequence();
    this.summary = null;
    this.results = emptyResults();
    this.callbacks.fail();
  }
}

export function createOptionsQueryCoordinator(
  rpc: StrictBlacklistRpcClient,
  callbacks: OptionsQueryCoordinatorCallbacks,
): OptionsQueryCoordinator {
  return new OptionsQueryCoordinatorImplementation(rpc, callbacks);
}
