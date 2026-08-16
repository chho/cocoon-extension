import {
  isMemberHashId,
  normalizeMemberHashId,
} from "./blacklist-state.ts";
import { parseZhihuUserId } from "./parse-zhihu-user-id.ts";

const COMMENTS_CONTAINER_SELECTOR = ".Comments-container, .Modal-content";
const COMMENT_ROOT_SELECTOR = "div[data-id]";
export const COMMENT_HIDDEN_CLASS = "cocoon-comment-blacklisted";

export function resolveCommentAuthorUserId(
  commentRoot: HTMLElement,
): string | null {
  if (
    !commentRoot.matches(COMMENT_ROOT_SELECTOR) ||
    !commentRoot.closest(COMMENTS_CONTAINER_SELECTOR)
  ) {
    return null;
  }

  const ownUserIds = new Set<string>();
  for (const link of commentRoot.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.closest(COMMENT_ROOT_SELECTOR) !== commentRoot) {
      continue;
    }
    const href = link.getAttribute("href");
    const userId = href ? parseZhihuUserId(href) : null;
    if (userId) {
      ownUserIds.add(normalizeMemberHashId(userId) ?? userId);
      if (ownUserIds.size > 1) {
        return null;
      }
    }
  }

  return ownUserIds.size === 1 ? [...ownUserIds][0] : null;
}

export interface CommentFilterControllerDependencies {
  readonly schedule: (callback: () => void) => void;
  readonly resolveHistoricalAlias?: (memberHashId: string) => Promise<void>;
  readonly batchSize?: number;
}

export interface CommentFilterController {
  scan(root: Node): void;
  updateStableUserIds(userIds: ReadonlySet<string>): void;
  refreshStableUserIds(userIds: ReadonlySet<string>, root: Node): void;
}

function elementFromNode(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : null;
}

export function createCommentFilterController(
  dependencies: CommentFilterControllerDependencies,
): CommentFilterController {
  const batchSize = dependencies.batchSize ?? 20;
  const encountered = new Set<HTMLElement>();
  const pending = new Set<HTMLElement>();
  const inFlightAliases = new Map<string, Promise<void>>();
  const skipAliasOnce = new WeakMap<HTMLElement, string>();
  let stableUserIds = new Set<string>();
  let storageLoaded = false;
  let frameRequested = false;

  function requestFrame(): void {
    if (frameRequested) {
      return;
    }
    frameRequested = true;
    dependencies.schedule(processPending);
  }

  function enqueue(commentRoot: HTMLElement): void {
    encountered.add(commentRoot);
    pending.add(commentRoot);
    skipAliasOnce.delete(commentRoot);
    requestFrame();
  }

  function forgetDetachedRoots(): void {
    for (const commentRoot of encountered) {
      if (commentRoot.isConnected) {
        continue;
      }
      encountered.delete(commentRoot);
      pending.delete(commentRoot);
      skipAliasOnce.delete(commentRoot);
      commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
    }
  }

  function reenqueueUnchangedAliasRoots(memberHashId: string): void {
    for (const commentRoot of encountered) {
      if (!commentRoot.isConnected) {
        encountered.delete(commentRoot);
        pending.delete(commentRoot);
        skipAliasOnce.delete(commentRoot);
        commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
        continue;
      }
      if (resolveCommentAuthorUserId(commentRoot) !== memberHashId) {
        continue;
      }
      skipAliasOnce.set(commentRoot, memberHashId);
      pending.add(commentRoot);
    }
    requestFrame();
  }

  function resolveAlias(memberHashId: string): void {
    const canonicalMemberHashId = normalizeMemberHashId(memberHashId);
    const resolveHistoricalAlias = dependencies.resolveHistoricalAlias;
    if (
      canonicalMemberHashId === null ||
      inFlightAliases.has(canonicalMemberHashId)
    ) {
      return;
    }
    if (!resolveHistoricalAlias) {
      return;
    }
    const aliasKey = canonicalMemberHashId;
    const requestHistoricalAlias = resolveHistoricalAlias;

    async function run(): Promise<void> {
      try {
        await requestHistoricalAlias(aliasKey);
      } catch {
        // Alias failures are fail-open; a later scan may retry the resolver.
      } finally {
        inFlightAliases.delete(aliasKey);
        reenqueueUnchangedAliasRoots(aliasKey);
      }
    }

    inFlightAliases.set(aliasKey, run());
  }

  function processPending(): void {
    frameRequested = false;
    const batch = Array.from(pending).slice(0, batchSize);
    for (const commentRoot of batch) {
      pending.delete(commentRoot);
      if (!commentRoot.isConnected) {
        encountered.delete(commentRoot);
        skipAliasOnce.delete(commentRoot);
        commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
        continue;
      }
      if (!storageLoaded) {
        continue;
      }
      try {
        const userId = resolveCommentAuthorUserId(commentRoot);
        const hidden = userId !== null && stableUserIds.has(userId);
        commentRoot.classList.toggle(COMMENT_HIDDEN_CLASS, hidden);
        if (hidden || userId === null || !isMemberHashId(userId)) {
          continue;
        }
        if (skipAliasOnce.get(commentRoot) === userId) {
          skipAliasOnce.delete(commentRoot);
          continue;
        }
        resolveAlias(userId);
      } catch {
        commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
      }
    }
    if (pending.size > 0) {
      requestFrame();
    }
  }

  function enqueueCommentSubtree(element: Element): void {
    const ownCommentRoot = element.closest<HTMLElement>(COMMENT_ROOT_SELECTOR);
    if (ownCommentRoot?.closest(COMMENTS_CONTAINER_SELECTOR)) {
      enqueue(ownCommentRoot);
    }
    for (const commentRoot of element.querySelectorAll<HTMLElement>(
      COMMENT_ROOT_SELECTOR,
    )) {
      enqueue(commentRoot);
    }
  }

  function scan(root: Node): void {
    forgetDetachedRoots();
    const element = elementFromNode(root);
    if (!element) {
      return;
    }

    if (element.closest(COMMENTS_CONTAINER_SELECTOR)) {
      enqueueCommentSubtree(element);
      return;
    }
    for (const container of element.querySelectorAll<HTMLElement>(
      COMMENTS_CONTAINER_SELECTOR,
    )) {
      enqueueCommentSubtree(container);
    }
  }

  function updateStableUserIds(userIds: ReadonlySet<string>): void {
    forgetDetachedRoots();
    storageLoaded = true;
    stableUserIds = new Set(
      Array.from(userIds, (userId) => normalizeMemberHashId(userId) ?? userId),
    );
    for (const commentRoot of encountered) {
      pending.add(commentRoot);
    }
    requestFrame();
  }

  return {
    scan,
    updateStableUserIds,
    refreshStableUserIds(userIds, root) {
      updateStableUserIds(userIds);
      scan(root);
    },
  };
}
