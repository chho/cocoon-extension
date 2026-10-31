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
export interface VisibilityObservation {
  phase: "start" | "end";
  reason: "completed" | "aborted" | "error" | "initial";
  total: number;
  hidden: number;
  detached: number;
  changed: number;
  pending: number;
}

type VisibilityObserver = (event: VisibilityObservation) => void;

function observeVisibility(
  targets: readonly VisibilityTarget[],
  observe: VisibilityObserver | undefined,
  phase: VisibilityObservation["phase"],
  reason: VisibilityObservation["reason"],
): void {
  if (!observe) return;
  try {
    const counts = { total: targets.length, hidden: 0, detached: 0, changed: 0, pending: 0 };
    for (const { root, isRelevant } of targets) {
      if (!root.isConnected) counts.detached++;
      else if (!isRelevant()) counts.changed++;
      else if (root.closest(HIDDEN_SELECTOR)) counts.hidden++;
      else counts.pending++;
    }
    observe({ phase, reason, ...counts });
  } catch {
    /* Diagnostics cannot change visibility acknowledgement. */
  }
}

interface AuthorVisibilityDependencies {
  readonly observe?: VisibilityObserver;
  readonly cardRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly commentRoots: (identifiers: ReadonlySet<string>) => readonly HTMLElement[];
  readonly readCardIdentifiers: (root: HTMLElement) => ReadonlySet<string>;
}
const HIDDEN_SELECTOR = ".cocoon-blacklisted, .cocoon-comment-blacklisted";

// Read-only acknowledgement of existing filters; the owning submission bounds the signal.
export function waitForHiddenTargets(
  targets: readonly VisibilityTarget[],
  signal: AbortSignal,
  observe?: VisibilityObserver,
): Promise<boolean> {
  if (import.meta.env?.MODE !== "production")
    observeVisibility(targets, observe, "start", "initial");
  if (signal.aborted || targets.length === 0) {
    if (import.meta.env?.MODE !== "production")
      observeVisibility(targets, observe, "end", signal.aborted ? "aborted" : "completed");
    return Promise.resolve(!signal.aborted);
  }
  return new Promise((resolve) => {
    const document = targets[0]!.root.ownerDocument;
    const observer = new document.defaultView!.MutationObserver(check);
    function finish(completed: boolean, reason: VisibilityObservation["reason"]): void {
      if (import.meta.env?.MODE !== "production")
        observeVisibility(targets, observe, "end", reason);
      observer.disconnect();
      signal.removeEventListener("abort", abort);
      resolve(completed);
    }
    function abort(): void {
      finish(false, "aborted");
    }
    function check(): void {
      try {
        if (
          targets.every(
            ({ root, isRelevant }) =>
              !root.isConnected || !isRelevant() || root.closest(HIDDEN_SELECTOR),
          )
        )
          finish(true, "completed");
      } catch {
        finish(false, "error");
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
  return waitForHiddenTargets([...cards, ...comments], signal, dependencies.observe);
}
