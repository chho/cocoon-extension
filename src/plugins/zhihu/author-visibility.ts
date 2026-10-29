import {
  ZHIHU_PLATFORM_ID,
  normalizeMemberHashId,
  type BlacklistedAuthor,
} from "../../content/blacklist-state.ts";
import { resolveCommentAuthorUserId } from "../../content/comment-filter-controller.ts";

interface VisibilityTarget {
  readonly root: HTMLElement;
  readonly isRelevant: () => boolean;
}
interface AuthorVisibilityDependencies {
  readonly cardRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly commentRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly readCardIdentifiers: (root: HTMLElement) => ReadonlySet<string>;
}
const HIDDEN_SELECTOR = ".cocoon-blacklisted, .cocoon-comment-blacklisted";

// Read-only acknowledgement of existing filters; the owning submission bounds the signal.
export function waitForHiddenTargets(
  targets: readonly VisibilityTarget[],
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (targets.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const document = targets[0]!.root.ownerDocument;
    const observer = new document.defaultView!.MutationObserver(check);
    function finish(completed: boolean): void {
      observer.disconnect();
      signal.removeEventListener("abort", abort);
      resolve(completed);
    }
    function abort(): void {
      finish(false);
    }
    function check(): void {
      try {
        if (
          targets.every(
            ({ root, isRelevant }) =>
              !root.isConnected || !isRelevant() || root.closest(HIDDEN_SELECTOR),
          )
        )
          finish(true);
      } catch {
        finish(false);
      }
    }
    signal.addEventListener("abort", abort, { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
    for (const { root } of targets) {
      observer.observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "href", "data-id", "data-zop", "data-za-extra-module"],
      });
    }
    check();
  });
}

export function waitForAuthorVisibility(
  author: BlacklistedAuthor,
  dependencies: AuthorVisibilityDependencies,
  signal: AbortSignal,
): Promise<boolean> {
  if (author.platformId !== ZHIHU_PLATFORM_ID) return Promise.resolve(false);
  const identifiers = new Set([
    author.userId,
    ...(author.memberHashId ? [author.memberHashId] : []),
  ]);
  const cards = dependencies.cardRoots(identifiers).map((root) => ({
    root,
    isRelevant: () =>
      [...dependencies.readCardIdentifiers(root)].some((id) =>
        identifiers.has(normalizeMemberHashId(id) ?? id),
      ),
  }));
  const comments = dependencies.commentRoots(identifiers).map((root) => ({
    root,
    isRelevant: () => identifiers.has(resolveCommentAuthorUserId(root) ?? ""),
  }));
  return waitForHiddenTargets([...cards, ...comments], signal);
}
