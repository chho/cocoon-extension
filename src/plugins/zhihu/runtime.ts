import type { SitePluginMountContext } from "../../core/plugin/contract.ts";
import {
  ZHIHU_PLATFORM_ID,
  createInitialState,
  normalizeMemberHashId,
  validateNewTagLabel,
  type CocoonTag,
} from "../../content/blacklist-state.ts";
import { resolveProvenAuthorIdentity } from "../../content/author-identity.ts";
import {
  createCardFilterController,
  type CardFilterController,
  type CardFilterFreshness,
} from "../../content/card-filter-controller.ts";
import {
  createCommentFilterController,
  type CommentFilterController,
} from "../../content/comment-filter-controller.ts";
import { createBackgroundBlacklistGateway } from "../../content/background-blacklist-gateway.ts";
import { BLACKLIST_REVISION_STORAGE_KEY } from "../../content/background-blacklist-client.ts";
import { createDrawerView } from "../../content/drawer-view.ts";
import { createDrawerCommitHandler } from "./drawer-commit.ts";
import { installDevDiagnostics, recordDrawerObservation } from "../../diagnostics/content.ts";
import { createMeasuredCommitController } from "../../content/commit-performance.ts";
import {
  createDrawerController,
  type DrawerTarget,
  type TagSelection,
} from "../../content/drawer-controller.ts";
import {
  createDrawerVisibilityController,
  getDrawerMotionContract,
} from "../../content/drawer-visibility.ts";
import { parseAuthorMemberHashId } from "../../content/parse-zhihu-member-data.ts";
import { parseZhihuUserId } from "../../content/parse-zhihu-user-id.ts";
import { createMemberUserIdResolver } from "../../content/resolve-member-user-id.ts";
import { createTagDeletionController } from "../../content/tag-deletion-controller.ts";
import { createDrawerTagList } from "../../content/drawer-tag-list.ts";
import {
  REMOTE_PREFERENCES_STORAGE_KEY,
  createDefaultRemotePreferences,
  initializeRemotePreferences,
  parseRemotePreferences,
  updateRemotePreference,
  type RemotePreferences,
} from "../../content/remote-preferences.ts";
import {
  createRemotePreferenceController,
  runAfterRemotePreferencesReady,
} from "../../content/remote-preference-controller.ts";
import {
  createRemoteBlockCoordinator,
  type CrossContextTryLockResult,
} from "../../content/remote-block-coordinator.ts";
import { createRemoteBackgroundRunner } from "../../content/remote-background-runner.ts";
import { createRemoteOptionsView } from "../../content/remote-options-view.ts";
import {
  HOVER_BLOCK_BUTTON_CLASS,
  createHoverCardController,
  type HoverAuthorActivation,
} from "../../content/hover-card-controller.ts";
import { createVoterBatchController } from "../../content/voter-batch-controller.ts";
import {
  blockZhihuUser,
  fetchCurrentZhihuUser,
  fetchZhihuVoters,
} from "../../content/zhihu-remote-api.ts";
import { createZhihuBlacklistIdentityRuntime } from "./blacklist-identity-runtime.ts";
import { getCardContentSource, getCardSourcePost } from "./card-content-source.ts";
import { createHoverPostTracker } from "./hover-post-tracker.ts";
import { createHoverDrawerTarget } from "./hover-drawer-target.ts";

const CARD_SELECTOR = ".TopstoryItem";
const CONTENT_SELECTOR = ".ContentItem[data-zop]";
const AUTHOR_SELECTOR = ".AuthorInfo-name, .UserLink-link";
const AUTHOR_PROFILE_LINK_SELECTOR =
  "a.AuthorInfo-name[href], a.UserLink-link[href], .AuthorInfo-name a[href]";
const ENHANCED_CARD_CLASS = "cocoon-zhihu-card";
export const BLACKLISTED_CARD_CLASS = "cocoon-blacklisted";
const CLOSE_BUTTON_CLASS = "cocoon-zhihu-card-close";
const PREFERENCES_LOCK_NAME = "cocoon-remote-preferences-storage";
const BATCH_SIZE = 20;
export const COMMENT_MUTATION_ATTRIBUTE_FILTER = Object.freeze(["href", "data-id"]);

interface ZhihuCardMetadata {
  readonly authorName?: string;
}

type HtmlDrawerTarget = DrawerTarget<HTMLElement, HTMLButtonElement>;

interface PendingCardVisibility {
  readonly hidden: boolean;
  readonly isCurrent: CardFilterFreshness;
}

export interface CardVisibilityController {
  queue(card: HTMLElement, hidden: boolean, isCurrent: CardFilterFreshness): void;
}

interface CardVisibilityControllerDependencies {
  readonly schedule: (callback: () => void) => void;
  readonly onFirstHidden: () => void;
  readonly batchSize?: number;
}

export function applyCardHiddenState(
  card: HTMLElement,
  hidden: boolean,
  isCurrent: CardFilterFreshness,
  ...observation: readonly [WeakSet<HTMLElement>, () => void]
): void {
  const [rootsEverObservedHidden, onFirstHidden] = observation;
  if (!isCurrent() || !card.isConnected) {
    return;
  }

  const wasHidden = card.classList.contains(BLACKLISTED_CARD_CLASS);
  if (wasHidden) {
    rootsEverObservedHidden.add(card);
  }
  card.classList.toggle(BLACKLISTED_CARD_CLASS, hidden);
  if (!hidden || wasHidden || rootsEverObservedHidden.has(card)) {
    return;
  }

  rootsEverObservedHidden.add(card);
  try {
    onFirstHidden();
  } catch {
    // Badge reporting is observational and must never affect card filtering.
  }
}

export function createCardVisibilityController(
  dependencies: CardVisibilityControllerDependencies,
): CardVisibilityController {
  const batchSize = dependencies.batchSize ?? 20;
  const pendingVisibility = new Map<HTMLElement, PendingCardVisibility>();
  const rootsEverObservedHidden = new WeakSet<HTMLElement>();
  let frameRequested = false;

  function requestFrame(): void {
    if (frameRequested) {
      return;
    }
    frameRequested = true;
    dependencies.schedule(processPendingVisibility);
  }

  function processPendingVisibility(): void {
    frameRequested = false;
    const batch = Array.from(pendingVisibility.entries()).slice(0, batchSize);
    for (const [card, visibility] of batch) {
      if (pendingVisibility.get(card) !== visibility) {
        continue;
      }
      pendingVisibility.delete(card);
      applyCardHiddenState(
        card,
        visibility.hidden,
        visibility.isCurrent,
        rootsEverObservedHidden,
        dependencies.onFirstHidden,
      );
    }

    if (pendingVisibility.size > 0) {
      requestFrame();
    }
  }

  return {
    queue(card, hidden, isCurrent) {
      pendingVisibility.set(card, { hidden, isCurrent });
      requestFrame();
    },
  };
}

export function mountZhihuPlugin(context: SitePluginMountContext): void {
  const blacklistGateway = createBackgroundBlacklistGateway(chrome.runtime);
  const cardTargetIds = new WeakMap<HTMLElement, string>();
  const resolveMemberUserId = createMemberUserIdResolver(fetch);
  let currentTags: readonly CocoonTag[] = createInitialState().tags;
  let nextTargetId = 1;
  let blockedOutsideClickTarget: EventTarget | null = null;
  let lifecycleEnded = false;

  window.addEventListener("pagehide", () => {
    lifecycleEnded = true;
    drawerController.dismiss();
  });
  window.addEventListener("pageshow", () => {
    lifecycleEnded = false;
  });

  const cardVisibilityController = createCardVisibilityController({
    schedule(callback) {
      requestAnimationFrame(callback);
    },
    onFirstHidden() {
      context.badgeReporter.recordFirstHidden();
    },
    batchSize: BATCH_SIZE,
  });

  const runtimeFilters: {
    card?: CardFilterController<HTMLElement>;
    comment?: CommentFilterController;
  } = {};

  function reevaluateIdentityRoots(): void {
    runtimeFilters.card?.reevaluateAll();
    runtimeFilters.comment?.reevaluateAll();
  }

  const identityRuntime = createZhihuBlacklistIdentityRuntime({
    gateway: blacklistGateway,
    resolveMemberUserId,
    applyTags(tags) {
      currentTags = tags;
      renderTagChoices();
    },
    reevaluateRoots: reevaluateIdentityRoots,
    reportSyncFailure: reportBlacklistSyncFailure,
    schedule(callback) {
      const frameId = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frameId);
    },
  });
  const { client: blacklistClient, aliasPersistence } = identityRuntime;

  const commentFilterController = createCommentFilterController({
    schedule(callback) {
      const frameId = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frameId);
    },
    matchStableIdentifiers: identityRuntime.match,
    resolveHistoricalAlias(memberHashId) {
      return aliasPersistence.persistMemberHashAlias(memberHashId);
    },
    onFirstHidden() {
      context.badgeReporter.recordFirstHidden();
    },
    batchSize: BATCH_SIZE,
  });
  runtimeFilters.comment = commentFilterController;

  function getAuthorName(card: HTMLElement): string {
    const content = card.querySelector<HTMLElement>(CONTENT_SELECTOR);
    const metadata = content?.dataset.zop;

    if (metadata) {
      try {
        const value: unknown = JSON.parse(metadata);
        if (typeof value === "object" && value !== null) {
          const { authorName } = value as ZhihuCardMetadata;
          if (authorName?.trim()) {
            return authorName.trim();
          }
        }
      } catch (error) {
        console.warn("[Cocoon] 无法解析知乎卡片信息。", error);
      }
    }

    const visibleAuthor = card.querySelector<HTMLElement>(AUTHOR_SELECTOR);
    return visibleAuthor?.textContent?.trim() || "未知作者";
  }

  function getProfileLinkUserId(card: HTMLElement): string | null {
    const profileLinks = card.querySelectorAll<HTMLAnchorElement>(AUTHOR_PROFILE_LINK_SELECTOR);

    for (const profileLink of profileLinks) {
      const profileHref = profileLink.getAttribute("href");
      const userId = profileHref ? parseZhihuUserId(profileHref) : null;
      if (userId) return userId;
    }

    return null;
  }

  function getAuthorMemberHashId(card: HTMLElement): string | null {
    const content = card.querySelector<HTMLElement>(CONTENT_SELECTOR);
    const extraModuleMetadata = content?.getAttribute("data-za-extra-module");
    const memberHashId = extraModuleMetadata ? parseAuthorMemberHashId(extraModuleMetadata) : null;
    return normalizeMemberHashId(memberHashId);
  }

  function getDirectCardAuthorIds(card: HTMLElement): ReadonlySet<string> {
    const identifiers = new Set<string>();
    const profileUserId = getProfileLinkUserId(card);
    const memberHashId = getAuthorMemberHashId(card);
    if (profileUserId) {
      identifiers.add(profileUserId);
    }
    if (memberHashId) {
      identifiers.add(memberHashId);
    }
    return identifiers;
  }

  function reportBlacklistSyncFailure(): void {
    console.error("[Cocoon] 无法同步本地黑名单，等待后续 revision 重试。");
  }

  async function withRemoteBlockLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(name, { mode: "exclusive" }, operation);
  }

  async function tryWithRemoteBlockUserLock<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<CrossContextTryLockResult<T>> {
    return navigator.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock): Promise<CrossContextTryLockResult<T>> => {
        if (lock === null) {
          return { acquired: false };
        }
        return { acquired: true, value: await operation() };
      },
    );
  }

  async function readStoredRemotePreferences(): Promise<ReturnType<typeof parseRemotePreferences>> {
    const values = await chrome.storage.local.get(REMOTE_PREFERENCES_STORAGE_KEY);
    return parseRemotePreferences(values[REMOTE_PREFERENCES_STORAGE_KEY] as unknown);
  }

  async function withPreferencesLock<T>(operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request(PREFERENCES_LOCK_NAME, { mode: "exclusive" }, operation);
  }

  async function writeStoredRemotePreferences(preferences: RemotePreferences): Promise<void> {
    await chrome.storage.local.set({
      [REMOTE_PREFERENCES_STORAGE_KEY]: preferences,
    });
  }

  const remotePreferencesDependencies = {
    withExclusiveLock: withPreferencesLock,
    read: readStoredRemotePreferences,
    write: writeStoredRemotePreferences,
  };

  async function initializeStorage(): Promise<void> {
    try {
      await blacklistClient.initialize();
    } catch (error) {
      console.error("[Cocoon] 无法初始化或迁移本地黑名单。", error);
      currentTags = createInitialState().tags;
      renderTagChoices();
    } finally {
      enqueueAllCards();
    }
  }

  async function initializeRemotePreferenceStorage(): Promise<void> {
    try {
      const initialized = await initializeRemotePreferences(remotePreferencesDependencies);
      if (initialized.status === "malformed") {
        console.error("[Cocoon] 知乎操作偏好格式无效，已安全回退为关闭。");
      }
      replaceRemotePreferences(initialized.preferences);
    } catch {
      console.error("[Cocoon] 无法初始化知乎操作偏好，已安全回退为关闭。");
      replaceRemotePreferences(createDefaultRemotePreferences());
    }
  }

  function getCardTargetId(card: HTMLElement): string {
    const existing = cardTargetIds.get(card);
    if (existing) {
      return existing;
    }

    const targetId = `card-${nextTargetId}`;
    nextTargetId += 1;
    cardTargetIds.set(card, targetId);
    return targetId;
  }

  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function saveRemotePreference(
    key: "blockAuthorOnZhihu" | "blockContentVoters",
    value: boolean,
  ): void {
    void remotePreferenceController.setPreference(key, value);
  }

  const remoteOptionsView = createRemoteOptionsView(document, saveRemotePreference);

  const { drawer, drawerCloseButton, tagList, newTagForm, newTagInput, setSubmitting } =
    createDrawerView(document, remoteOptionsView.element);

  const drawerVisibility = createDrawerVisibilityController({
    setHidden(hidden) {
      drawer.hidden = hidden;
      drawer.setAttribute("aria-hidden", String(hidden));
      if (hidden) {
        drawer.style.removeProperty("left");
        drawer.style.removeProperty("top");
      }
    },
    setInert(inert) {
      drawer.inert = inert;
    },
    setPhase(phase) {
      drawer.dataset.phase = phase;
    },
    scheduleFrame(callback) {
      requestAnimationFrame(callback);
    },
    scheduleExit(callback) {
      const contract = getDrawerMotionContract(reducedMotionQuery.matches);
      const timeoutId = window.setTimeout(callback, contract.exitDurationMilliseconds + 30);
      return () => window.clearTimeout(timeoutId);
    },
  });

  function renderRemotePreferenceValues(preferences: RemotePreferences): void {
    remoteOptionsView.renderPreferences(preferences);
  }

  const remotePreferenceController = createRemotePreferenceController({
    initialPreferences: createDefaultRemotePreferences(),
    async save(key, value) {
      return updateRemotePreference(remotePreferencesDependencies, key, value);
    },
    render: renderRemotePreferenceValues,
    reportFailure() {
      console.error("[Cocoon] 无法保存知乎操作偏好，已恢复最近持久化的设置。");
    },
  });

  function replaceRemotePreferences(preferences: RemotePreferences): void {
    remotePreferenceController.replacePersisted(preferences);
  }

  const remotePreferencesReady = initializeRemotePreferenceStorage();

  function setVoterOptionAvailability(target: HtmlDrawerTarget): void {
    remoteOptionsView.setVoterAvailable(target.voterSource !== null);
  }

  const drawerController = createDrawerController<HTMLElement, HTMLButtonElement>({
    observeSubmission:
      import.meta.env?.MODE === "diagnostic"
        ? (event) => recordDrawerObservation(document, event)
        : undefined,
    setSubmitting,
    scheduleDeadline(callback) {
      const id = window.setTimeout(callback, 10_000);
      return () => window.clearTimeout(id);
    },
    reportIncomplete() {
      console.warn("[Cocoon] 本地处理或页面更新尚未确认；未撤销已提交操作，请检查结果后再操作。");
    },
    show(target) {
      renderTagChoices();
      setVoterOptionAvailability(target);
      drawerVisibility.open();
      positionDrawer();
    },
    hide() {
      drawerVisibility.close();
    },
    clearDraft() {
      newTagInput.value = "";
      newTagInput.setCustomValidity("");
    },
    focusInput() {
      newTagInput.focus({ preventScroll: true });
    },
    restoreFocus(button) {
      if (button.isConnected) {
        button.focus({ preventScroll: true });
      }
    },
    getRemoteAuthorization(target) {
      return remoteOptionsView.getAuthorization(target.voterSource !== null);
    },
    commit: (task, signal) => handleDrawerCommit(task, signal),
  });

  function positionDrawer(): void {
    const target = drawerController.getTarget();
    if (
      !target ||
      drawerController.getState().status !== "open" ||
      drawerVisibility.getPhase() === "hidden"
    ) {
      return;
    }

    const buttonBounds = target.anchorBounds ?? target.button.getBoundingClientRect();
    const horizontalGap = 0;
    const viewportPadding = 8;
    const width = drawer.offsetWidth;
    const height = drawer.offsetHeight;
    const left = Math.max(viewportPadding, buttonBounds.left - horizontalGap - width);
    const top = Math.min(
      Math.max(viewportPadding, buttonBounds.top),
      Math.max(viewportPadding, window.innerHeight - height - viewportPadding),
    );
    drawer.style.left = `${left}px`;
    drawer.style.top = `${top}px`;
  }

  const tagListController = createDrawerTagList(tagList, {
    getTags: () => currentTags,
    getStatus: () => drawerController.getState().status,
    onLayoutChange: positionDrawer,
    selectTag: (tag) => void submitDrawerSelection({ tag, isNewTag: false }),
    deleteTag: (tagId, event) => void tagDeletionController.deleteTag(tagId, event),
  });
  function renderTagChoices(): void {
    tagListController.render();
  }

  async function submitDrawerSelection(selection: TagSelection): Promise<void> {
    await runAfterRemotePreferencesReady(remotePreferencesReady, () => {
      drawerController.submit(selection);
    });
  }

  window.addEventListener("resize", positionDrawer);

  async function openDrawer(card: HTMLElement, button: HTMLButtonElement): Promise<void> {
    const target: HtmlDrawerTarget = {
      targetId: getCardTargetId(card),
      card,
      button,
      authorNameAtClick: getAuthorName(card),
      profileUserIdAtClick: getProfileLinkUserId(card),
      memberHashIdAtClick: getAuthorMemberHashId(card),
      anchorBounds: null,
      voterSource: getCardContentSource(card),
    };
    await runAfterRemotePreferencesReady(remotePreferencesReady, () => {
      drawerController.open(target);
    });
  }

  const hoverPostTracker = createHoverPostTracker(document);
  async function openHoverDrawer(activation: HoverAuthorActivation): Promise<void> {
    const target = createHoverDrawerTarget(
      activation,
      `hover-${nextTargetId++}`,
      hoverPostTracker.capture(activation),
    );
    await runAfterRemotePreferencesReady(remotePreferencesReady, () => {
      drawerController.open(target);
    });
  }

  const hoverCardController = createHoverCardController({
    onActivate(activation) {
      void openHoverDrawer(activation);
    },
    schedule(callback) {
      requestAnimationFrame(callback);
    },
  });

  function showTagValidationError(error: "empty" | "too-long" | "duplicate"): void {
    const messages = {
      empty: "标签名称不能为空。",
      "too-long": "标签名称最多 30 个字符。",
      duplicate: "标签名称已存在，请选择已有标签。",
    } as const;
    newTagInput.setCustomValidity(messages[error]);
    newTagInput.reportValidity();
  }

  newTagInput.addEventListener("input", () => {
    drawerController.setDraft(newTagInput.value);
    newTagInput.setCustomValidity("");
  });

  newTagForm.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const validation = validateNewTagLabel(newTagInput.value, currentTags);
    if (validation.error) {
      showTagValidationError(validation.error);
      return;
    }

    void submitDrawerSelection({
      tag: {
        tagId: `tag-${crypto.randomUUID()}`,
        name: validation.normalized,
      },
      isNewTag: true,
    });
  });

  drawerCloseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    drawerController.cancel();
  });

  drawer.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (drawerController.getState().status !== "open" || event.key !== "Escape") {
        return;
      }

      drawerController.cancel(event);
    },
    true,
  );

  function isDrawerTrigger(element: Element | null): boolean {
    return Boolean(element?.closest(`.${CLOSE_BUTTON_CLASS}, .${HOVER_BLOCK_BUTTON_CLASS}`));
  }

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (drawerController.getState().status !== "open" || !(event.target instanceof Node)) {
        blockedOutsideClickTarget = null;
        return;
      }

      blockedOutsideClickTarget = null;

      if (drawer.contains(event.target)) {
        return;
      }

      const element = event.target instanceof Element ? event.target : null;
      if (isDrawerTrigger(element)) {
        return;
      }

      blockedOutsideClickTarget = event.target;
      drawerController.cancel(event);
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (
        blockedOutsideClickTarget &&
        (event.target === blockedOutsideClickTarget ||
          (blockedOutsideClickTarget instanceof Node &&
            event.target instanceof Node &&
            blockedOutsideClickTarget.contains(event.target)))
      ) {
        blockedOutsideClickTarget = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      blockedOutsideClickTarget = null;
      if (drawerController.getState().status !== "open" || !(event.target instanceof Node)) {
        return;
      }

      if (
        !drawer.contains(event.target) &&
        !isDrawerTrigger(event.target instanceof Element ? event.target : null)
      ) {
        drawerController.cancel(event);
      }
    },
    true,
  );

  window.addEventListener("scroll", positionDrawer, true);

  function enhanceCard(card: HTMLElement): void {
    if (!card.querySelector(CONTENT_SELECTOR)) {
      return;
    }

    card.classList.add(ENHANCED_CARD_CLASS);
    if (card.querySelector(`:scope > .${CLOSE_BUTTON_CLASS}`)) {
      return;
    }

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = CLOSE_BUTTON_CLASS;
    closeButton.textContent = "×";
    closeButton.title = "为作者选择标签并屏蔽";
    closeButton.setAttribute("aria-label", "为这张卡片的作者选择标签并屏蔽");
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openDrawer(card, closeButton);
    });

    card.append(closeButton);
  }

  const filterController = createCardFilterController<HTMLElement>({
    prepareCard: enhanceCard,
    resolveStableIdentifiers: getDirectCardAuthorIds,
    matchStableIdentifiers: identityRuntime.match,
    resolveHistoricalAlias(memberHashId) {
      return aliasPersistence.persistMemberHashAlias(memberHashId);
    },
    setHidden(card, hidden, isCurrent) {
      cardVisibilityController.queue(card, hidden, isCurrent);
    },
    isConnected: (card) => card.isConnected,
    reportFailure(error) {
      console.warn("[Cocoon] 无法判断卡片作者。", error);
    },
    schedule(callback) {
      const frameId = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frameId);
    },
    batchSize: BATCH_SIZE,
  });
  runtimeFilters.card = filterController;

  function enqueueCard(card: HTMLElement): void {
    filterController.enqueue(card);
  }

  function findCards(root: Node): void {
    if (!(root instanceof HTMLElement)) {
      return;
    }

    const parentCard = root.closest<HTMLElement>(CARD_SELECTOR);
    if (parentCard) {
      enqueueCard(parentCard);
    }

    for (const card of root.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
      enqueueCard(card);
    }
  }

  function enqueueAllCards(): void {
    for (const card of document.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
      enqueueCard(card);
    }
  }

  const commitController = createMeasuredCommitController<HTMLElement, HTMLButtonElement>(
    {
      async resolveAuthorIdentity(target) {
        return resolveProvenAuthorIdentity(
          {
            profileUserId: target.profileUserIdAtClick,
            memberHashId: target.memberHashIdAtClick,
          },
          resolveMemberUserId,
        );
      },
      now: () => new Date(),
      resolveSourcePost: (target) =>
        target.sourcePost === undefined
          ? getCardSourcePost(target.card, target.voterSource)
          : target.sourcePost,
      ensurePost: blacklistClient.ensurePost,
      commitAuthor: blacklistClient.commitAuthor,
      // The owning drawer submission restores focus; late failures must not steal it.
      requestFailureFocus() {},
      reportFailure(error) {
        console.error("[Cocoon] 屏蔽作者失败，未保留会话内黑名单。", error);
      },
    },
    {
      now: () => performance.now(),
      report(summary) {
        console.info("[Cocoon][perf] 作者本地屏蔽耗时", summary);
      },
    },
  );

  const remoteBlockCoordinator = createRemoteBlockCoordinator({
    withCrossContextLock: withRemoteBlockLock,
    tryWithCrossContextUserLock: tryWithRemoteBlockUserLock,
    preflightDirect(userId, expectedBlacklistedAt) {
      return blacklistClient.preflightDirect(
        { platformId: ZHIHU_PLATFORM_ID, userId },
        expectedBlacklistedAt,
      );
    },
    commitUpvoter: blacklistClient.commitUpvoter,
    now: () => new Date(),
    async blockUser(userId, isStopped) {
      return blockZhihuUser(fetch, userId, document.cookie, { isStopped });
    },
    reportStorageFailure() {
      console.error("[Cocoon] 无法读取或保存屏蔽操作所需的本地状态。");
    },
  });

  const remoteBackgroundRunner = createRemoteBackgroundRunner<HTMLElement, HTMLButtonElement>({
    async blockAuthor(_task, committed) {
      return remoteBlockCoordinator.block(
        {
          source: "direct",
          userId: committed.userId,
          expectedBlacklistedAt: committed.blacklistedAt,
        },
        () => lifecycleEnded,
      );
    },
    async blockVoters(task, committed, voterSource) {
      const voterBatchController = createVoterBatchController({
        fetchCurrentUser: async (isStopped) => fetchCurrentZhihuUser(fetch, { isStopped }),
        fetchVoters: async (source, isStopped, onProgress) =>
          fetchZhihuVoters(fetch, source, {
            isStopped,
            onProgress,
          }),
        coordinator: remoteBlockCoordinator,
        reportProgress() {},
      });
      return voterBatchController.run({
        source: voterSource,
        tagId: task.selection.tag.tagId,
        directAuthorUserId: committed.userId,
        sourcePostId: committed.author.sourcePostId,
        isStopped: () => lifecycleEnded,
      });
    },
    reportFailure(scope) {
      if (scope === "author") {
        console.warn("[Cocoon] 作者知乎拉黑未完整完成。");
        return;
      }
      console.warn("[Cocoon] 点赞者本地处理或保存未完整完成。");
    },
  });

  const handleDrawerCommit = createDrawerCommitHandler({
    document,
    commitController,
    remoteBackgroundRunner,
    cardRoots: (identifiers) => filterController.getMatchingRoots(identifiers),
    commentRoots: (identifiers) => commentFilterController.getMatchingRoots(identifiers),
    readCardIdentifiers: getDirectCardAuthorIds,
  });

  const tagDeletionController = createTagDeletionController({
    deleteTag: blacklistClient.deleteTag,
    reportFailure(error) {
      console.error("[Cocoon] 删除标签失败，未更改标签或作者记录。", error);
    },
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (BLACKLIST_REVISION_STORAGE_KEY in changes) {
      void blacklistClient
        .handleRevisionValue(changes[BLACKLIST_REVISION_STORAGE_KEY]?.newValue as unknown)
        .catch(reportBlacklistSyncFailure);
    }

    if (REMOTE_PREFERENCES_STORAGE_KEY in changes) {
      const parsed = parseRemotePreferences(
        changes[REMOTE_PREFERENCES_STORAGE_KEY]?.newValue as unknown,
      );
      if (parsed.status === "malformed") {
        console.error("[Cocoon] 知乎操作偏好格式无效，已安全回退为关闭。");
      }
      replaceRemotePreferences(parsed.preferences);
      if (parsed.status === "missing") {
        void initializeRemotePreferenceStorage();
      }
    }
  });

  findCards(document.body);
  commentFilterController.scan(document.body);
  hoverCardController.scan(document.body);
  void initializeStorage();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") {
        continue;
      }
      hoverCardController.handleChildListMutation(
        mutation.target,
        mutation.addedNodes,
        mutation.removedNodes,
      );
    }

    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        commentFilterController.scan(mutation.target);
        continue;
      }

      for (const node of mutation.addedNodes) {
        findCards(node);
        commentFilterController.scan(node);
        hoverCardController.scan(node);
      }
      for (const node of mutation.removedNodes) {
        commentFilterController.scan(node);
      }
    }
  });

  if (import.meta.env?.MODE === "diagnostic") installDevDiagnostics(document);

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...COMMENT_MUTATION_ATTRIBUTE_FILTER],
  });
}
