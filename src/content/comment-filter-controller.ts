import type { AuthorAliasPersistenceResult } from "./author-alias-persistence-controller.ts";
import { isMemberHashId, normalizeMemberHashId } from "./blacklist-state.ts";
import type { IdentityMatchStatus } from "./identity-batch-matcher.ts";
import { parseZhihuUserId } from "./parse-zhihu-user-id.ts";

const COMMENTS_CONTAINER_SELECTOR = ".Comments-container, .Modal-content";
const COMMENT_ROOT_SELECTOR = "div[data-id]";
export const COMMENT_HIDDEN_CLASS = "cocoon-comment-blacklisted";

interface ProfileEvidence {
  hasImageLink: boolean;
  hasTextLink: boolean;
}

function collectOwnProfileEvidence(commentRoot: HTMLElement): Map<string, ProfileEvidence> {
  const evidenceByUserId = new Map<string, ProfileEvidence>();
  for (const link of commentRoot.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.closest(COMMENT_ROOT_SELECTOR) !== commentRoot) continue;
    const href = link.getAttribute("href");
    const userId = href ? parseZhihuUserId(href) : null;
    if (!userId) continue;
    const stableUserId = normalizeMemberHashId(userId) ?? userId;
    const evidence = evidenceByUserId.get(stableUserId) ?? {
      hasImageLink: false,
      hasTextLink: false,
    };
    const hasImage = link.querySelector("img") !== null;
    evidence.hasImageLink ||= hasImage;
    evidence.hasTextLink ||= !hasImage && link.textContent.trim().length > 0;
    evidenceByUserId.set(stableUserId, evidence);
  }
  return evidenceByUserId;
}

function semanticMainUserId(evidenceByUserId: ReadonlyMap<string, ProfileEvidence>): string | null {
  const semanticCandidates = [...evidenceByUserId].filter(
    ([, evidence]) => evidence.hasImageLink && evidence.hasTextLink,
  );
  if (semanticCandidates.length !== 1) return null;
  const mainUserId = semanticCandidates[0]?.[0];
  if (!mainUserId) return null;
  const hasAnotherImage = [...evidenceByUserId].some(
    ([userId, evidence]) => userId !== mainUserId && evidence.hasImageLink,
  );
  return hasAnotherImage ? null : mainUserId;
}

export function resolveCommentAuthorUserId(commentRoot: HTMLElement): string | null {
  if (!commentRoot.matches(COMMENT_ROOT_SELECTOR)) return null;
  if (!commentRoot.closest(COMMENTS_CONTAINER_SELECTOR)) return null;
  const evidenceByUserId = collectOwnProfileEvidence(commentRoot);
  if (evidenceByUserId.size === 1) return evidenceByUserId.keys().next().value ?? null;
  return semanticMainUserId(evidenceByUserId);
}

export interface CommentFilterControllerDependencies {
  readonly schedule: (callback: () => void) => void | (() => void);
  readonly matchStableIdentifiers: (
    identifiers: ReadonlySet<string>,
  ) => IdentityMatchStatus | Promise<IdentityMatchStatus>;
  readonly resolveHistoricalAlias?: (
    memberHashId: string,
  ) => Promise<AuthorAliasPersistenceResult | void>;
  readonly onFirstHidden?: () => void;
  readonly batchSize?: number;
}

export interface CommentFilterController {
  scan(root: Node): void;
  reevaluateAll(): void;
  destroy(): void;
}

function elementFromNode(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : null;
}

class CommentFilterControllerImpl implements CommentFilterController {
  private readonly dependencies: CommentFilterControllerDependencies;
  private readonly batchSize: number;
  private readonly encountered = new Set<HTMLElement>();
  private readonly pending = new Map<HTMLElement, object>();
  private readonly currentEvaluations = new WeakMap<HTMLElement, object>();
  private readonly filtering = new WeakSet<HTMLElement>();
  private readonly inFlightAliases = new Map<
    string,
    Promise<AuthorAliasPersistenceResult | void>
  >();
  private readonly skipAliasOnce = new WeakMap<HTMLElement, string>();
  private readonly rootsEverObservedHidden = new WeakSet<HTMLElement>();
  private frameRequested = false;
  private cancelFrame: (() => void) | null = null;
  private destroyed = false;

  constructor(dependencies: CommentFilterControllerDependencies) {
    this.dependencies = dependencies;
    this.batchSize = dependencies.batchSize ?? 20;
  }

  scan(root: Node): void {
    this.forgetDetachedRoots();
    const element = elementFromNode(root);
    if (!element) return;
    if (element.closest(COMMENTS_CONTAINER_SELECTOR)) {
      this.enqueueCommentSubtree(element);
      return;
    }
    for (const container of element.querySelectorAll<HTMLElement>(COMMENTS_CONTAINER_SELECTOR)) {
      this.enqueueCommentSubtree(container);
    }
  }

  reevaluateAll(): void {
    if (this.destroyed) return;
    this.forgetDetachedRoots();
    let hasReadyEvaluation = false;
    for (const commentRoot of this.encountered) {
      this.supersedeEvaluation(commentRoot);
      hasReadyEvaluation ||= !this.filtering.has(commentRoot);
    }
    if (hasReadyEvaluation) this.requestFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.frameRequested = false;
    this.pending.clear();
    this.inFlightAliases.clear();
    for (const commentRoot of this.encountered) {
      commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
    }
    this.encountered.clear();
  }

  private requestFrame(): void {
    if (this.frameRequested || this.destroyed) return;
    this.frameRequested = true;
    const cancellation = this.dependencies.schedule(() => this.processPending());
    this.cancelFrame = typeof cancellation === "function" ? cancellation : null;
  }

  private supersedeEvaluation(commentRoot: HTMLElement): object {
    const evaluation = Object.freeze({});
    this.currentEvaluations.set(commentRoot, evaluation);
    this.pending.set(commentRoot, evaluation);
    return evaluation;
  }

  private enqueue(commentRoot: HTMLElement): void {
    if (this.destroyed) return;
    this.encountered.add(commentRoot);
    this.skipAliasOnce.delete(commentRoot);
    this.supersedeEvaluation(commentRoot);
    if (!this.filtering.has(commentRoot)) this.requestFrame();
  }

  private forgetRoot(commentRoot: HTMLElement): void {
    this.encountered.delete(commentRoot);
    this.pending.delete(commentRoot);
    this.skipAliasOnce.delete(commentRoot);
    if (commentRoot.classList.contains(COMMENT_HIDDEN_CLASS)) {
      this.rootsEverObservedHidden.add(commentRoot);
    }
    commentRoot.classList.remove(COMMENT_HIDDEN_CLASS);
  }

  private forgetDetachedRoots(): void {
    for (const commentRoot of this.encountered) {
      if (!commentRoot.isConnected) this.forgetRoot(commentRoot);
    }
  }

  private isCurrentEvaluation(commentRoot: HTMLElement, evaluation: object): boolean {
    return (
      !this.destroyed &&
      commentRoot.isConnected &&
      this.currentEvaluations.get(commentRoot) === evaluation
    );
  }

  private reenqueueAliasRoots(memberHashId: string, skipImmediateRetry: boolean): void {
    for (const commentRoot of this.encountered) {
      if (!commentRoot.isConnected) {
        this.forgetRoot(commentRoot);
        continue;
      }
      if (resolveCommentAuthorUserId(commentRoot) !== memberHashId) continue;
      if (skipImmediateRetry) this.skipAliasOnce.set(commentRoot, memberHashId);
      this.supersedeEvaluation(commentRoot);
    }
    this.requestFrame();
  }

  private resolveAlias(memberHashId: string): void {
    const resolver = this.dependencies.resolveHistoricalAlias;
    if (!resolver || this.inFlightAliases.has(memberHashId) || this.destroyed) return;
    const completion = this.resolveAliasSafely(resolver, memberHashId);
    this.inFlightAliases.set(memberHashId, completion);
    void this.finishAliasResolution(memberHashId, completion);
  }

  private async resolveAliasSafely(
    resolver: (memberHashId: string) => Promise<AuthorAliasPersistenceResult | void>,
    memberHashId: string,
  ): Promise<AuthorAliasPersistenceResult | void> {
    try {
      return await resolver(memberHashId);
    } catch {
      return { status: "failed" };
    }
  }

  private async finishAliasResolution(
    memberHashId: string,
    completion: Promise<AuthorAliasPersistenceResult | void>,
  ): Promise<void> {
    const result = await completion;
    if (this.inFlightAliases.get(memberHashId) !== completion) return;
    this.inFlightAliases.delete(memberHashId);
    if (this.destroyed) return;
    this.reenqueueAliasRoots(memberHashId, result === undefined || result.status === "failed");
  }

  private applyHiddenState(commentRoot: HTMLElement, hidden: boolean, evaluation: object): void {
    if (!this.isCurrentEvaluation(commentRoot, evaluation)) return;
    const wasHidden = commentRoot.classList.contains(COMMENT_HIDDEN_CLASS);
    if (wasHidden) this.rootsEverObservedHidden.add(commentRoot);
    commentRoot.classList.toggle(COMMENT_HIDDEN_CLASS, hidden);
    if (!hidden || wasHidden || this.rootsEverObservedHidden.has(commentRoot)) return;
    this.rootsEverObservedHidden.add(commentRoot);
    try {
      this.dependencies.onFirstHidden?.();
    } catch {
      // Badge reporting is observational and must never affect comment filtering.
    }
  }

  private applyMatchResult(
    commentRoot: HTMLElement,
    evaluation: object,
    userId: string,
    status: IdentityMatchStatus,
  ): void {
    if (!this.isCurrentEvaluation(commentRoot, evaluation)) return;
    this.applyHiddenState(commentRoot, status === "matched", evaluation);
    if (status !== "unmatched" || !isMemberHashId(userId)) return;
    if (this.skipAliasOnce.get(commentRoot) === userId) {
      this.skipAliasOnce.delete(commentRoot);
      return;
    }
    this.resolveAlias(userId);
  }

  private async filter(commentRoot: HTMLElement, evaluation: object): Promise<void> {
    try {
      const userId = resolveCommentAuthorUserId(commentRoot);
      if (!this.isCurrentEvaluation(commentRoot, evaluation)) return;
      if (userId === null) {
        this.applyHiddenState(commentRoot, false, evaluation);
        return;
      }
      const match = this.dependencies.matchStableIdentifiers(new Set([userId]));
      const status = typeof match === "string" ? match : await match;
      this.applyMatchResult(commentRoot, evaluation, userId, status);
    } catch {
      this.applyHiddenState(commentRoot, false, evaluation);
    } finally {
      this.filtering.delete(commentRoot);
      if (this.pending.has(commentRoot)) this.requestFrame();
    }
  }

  private takeBatch(): Array<readonly [HTMLElement, object]> {
    const batch: Array<readonly [HTMLElement, object]> = [];
    for (const entry of this.pending) {
      if (this.filtering.has(entry[0])) continue;
      batch.push(entry);
      if (batch.length === this.batchSize) break;
    }
    return batch;
  }

  private processEntry(commentRoot: HTMLElement, evaluation: object): void {
    if (this.pending.get(commentRoot) !== evaluation) return;
    this.pending.delete(commentRoot);
    if (!commentRoot.isConnected) {
      this.forgetRoot(commentRoot);
      return;
    }
    this.filtering.add(commentRoot);
    void this.filter(commentRoot, evaluation);
  }

  private processPending(): void {
    this.frameRequested = false;
    this.cancelFrame = null;
    if (this.destroyed) return;
    for (const [commentRoot, evaluation] of this.takeBatch()) {
      this.processEntry(commentRoot, evaluation);
    }
    if ([...this.pending].some(([root]) => !this.filtering.has(root))) this.requestFrame();
  }

  private enqueueCommentSubtree(element: Element): void {
    const ownCommentRoot = element.closest<HTMLElement>(COMMENT_ROOT_SELECTOR);
    if (ownCommentRoot?.closest(COMMENTS_CONTAINER_SELECTOR)) this.enqueue(ownCommentRoot);
    for (const commentRoot of element.querySelectorAll<HTMLElement>(COMMENT_ROOT_SELECTOR)) {
      this.enqueue(commentRoot);
    }
  }
}

export function createCommentFilterController(
  dependencies: CommentFilterControllerDependencies,
): CommentFilterController {
  const controller = new CommentFilterControllerImpl(dependencies);
  return {
    scan: (root) => controller.scan(root),
    reevaluateAll: () => controller.reevaluateAll(),
    destroy: () => controller.destroy(),
  };
}
