import {
  STORAGE_KEY,
  createInitialState,
  parseBlacklistState,
  validateNewTagLabel,
  type BlacklistState,
} from "./blacklist-state";
import { createCardFilterController } from "./card-filter-controller";
import { captureCardImage } from "./capture-card-image";
import { createCommitController } from "./commit-controller";
import {
  createDrawerController,
  type DrawerTarget,
  type TagSelection,
} from "./drawer-controller";
import {
  createDrawerVisibilityController,
  getDrawerMotionContract,
} from "./drawer-visibility";
import { initializeBlacklistState } from "./initialize-blacklist-state";
import { parseAuthorMemberHashId } from "./parse-zhihu-member-data";
import { parseZhihuUserId } from "./parse-zhihu-user-id";
import { createMemberUserIdResolver } from "./resolve-member-user-id";
import { createTagDeletionController } from "./tag-deletion-controller";
import { renderTagList } from "./tag-list";

const CARD_SELECTOR = ".TopstoryItem";
const CONTENT_SELECTOR = ".ContentItem[data-zop]";
const AUTHOR_SELECTOR = ".AuthorInfo-name, .UserLink-link";
const AUTHOR_PROFILE_LINK_SELECTOR =
  "a.AuthorInfo-name[href], a.UserLink-link[href], .AuthorInfo-name a[href]";
const ENHANCED_CARD_CLASS = "cocoon-zhihu-card";
const BLACKLISTED_CARD_CLASS = "cocoon-blacklisted";
const CLOSE_BUTTON_CLASS = "cocoon-zhihu-card-close";
const DRAWER_CLASS = "cocoon-tag-drawer";
const STORAGE_LOCK_NAME = "cocoon-blacklist-storage";
const BATCH_SIZE = 20;

interface ZhihuCardMetadata {
  readonly authorName?: string;
}

type HtmlDrawerTarget = DrawerTarget<HTMLElement, HTMLButtonElement>;

const pendingVisibility = new Map<HTMLElement, boolean>();
const cardTargetIds = new WeakMap<HTMLElement, string>();
const resolveMemberUserId = createMemberUserIdResolver(fetch);
let currentState: BlacklistState = createInitialState();
let visibilityFrameRequested = false;
let nextTargetId = 1;
let blockedOutsideClickTarget: EventTarget | null = null;

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
  const profileLinks = card.querySelectorAll<HTMLAnchorElement>(
    AUTHOR_PROFILE_LINK_SELECTOR,
  );

  for (const profileLink of profileLinks) {
    const profileHref = profileLink.getAttribute("href");
    const userId = profileHref ? parseZhihuUserId(profileHref) : null;
    if (userId) {
      return userId;
    }
  }

  return null;
}

async function getAuthorUserId(card: HTMLElement): Promise<string | null> {
  const profileLinkUserId = getProfileLinkUserId(card);
  if (profileLinkUserId) {
    return profileLinkUserId;
  }

  const content = card.querySelector<HTMLElement>(CONTENT_SELECTOR);
  const extraModuleMetadata = content?.getAttribute("data-za-extra-module");
  const memberHash = extraModuleMetadata
    ? parseAuthorMemberHashId(extraModuleMetadata)
    : null;
  if (!memberHash) {
    return null;
  }

  return resolveMemberUserId(memberHash);
}

function replaceRuntimeState(state: BlacklistState): void {
  currentState = state;
  renderTagChoices();
  filterController.loadStableUserIds(
    new Set(state.authors.map((author) => author.userId)),
  );
}

async function readStoredState(): Promise<ReturnType<typeof parseBlacklistState>> {
  const values = await chrome.storage.local.get(STORAGE_KEY);
  return parseBlacklistState(values[STORAGE_KEY] as unknown);
}

function reportMalformedStorage(): void {
  console.error(
    "[Cocoon] 本地黑名单数据格式无效，已安全回退为空黑名单。",
  );
}

async function withStorageLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(
    STORAGE_LOCK_NAME,
    { mode: "exclusive" },
    operation,
  );
}

async function writeStoredState(state: BlacklistState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function initializeStorage(): Promise<void> {
  try {
    const initialized = await initializeBlacklistState({
      withExclusiveLock: withStorageLock,
      readState: readStoredState,
      writeState: writeStoredState,
    });
    if (initialized.status === "malformed") {
      reportMalformedStorage();
    }
    replaceRuntimeState(initialized.state);
  } catch (error) {
    console.error("[Cocoon] 无法初始化或迁移本地黑名单。", error);
    replaceRuntimeState(createInitialState());
  } finally {
    enqueueAllCards();
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

const drawer = document.createElement("aside");
drawer.className = DRAWER_CLASS;
drawer.hidden = true;
drawer.inert = true;
drawer.dataset.phase = "hidden";
drawer.setAttribute("role", "dialog");
drawer.setAttribute("aria-hidden", "true");
drawer.setAttribute("aria-label", "选择作者标签并屏蔽");
const reducedMotionQuery = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);

const drawerHeader = document.createElement("div");
drawerHeader.className = "cocoon-tag-drawer-header";
const drawerTitle = document.createElement("span");
drawerTitle.className = "cocoon-tag-drawer-title";
drawerTitle.textContent = "标签";
const drawerCloseButton = document.createElement("button");
drawerCloseButton.type = "button";
drawerCloseButton.className = "cocoon-tag-drawer-close";
drawerCloseButton.textContent = "×";
drawerCloseButton.setAttribute("aria-label", "取消并关闭标签选择");
drawerHeader.append(drawerTitle, drawerCloseButton);

const tagList = document.createElement("div");
tagList.className = "cocoon-tag-list";
tagList.setAttribute("aria-label", "已有标签");

const newTagForm = document.createElement("form");
newTagForm.className = "cocoon-tag-form";
const newTagLabel = document.createElement("label");
newTagLabel.className = "cocoon-visually-hidden";
newTagLabel.htmlFor = "cocoon-new-tag-input";
newTagLabel.textContent = "新标签名称";
const newTagInput = document.createElement("input");
newTagInput.id = "cocoon-new-tag-input";
newTagInput.className = "cocoon-tag-input";
newTagInput.type = "text";
newTagInput.autocomplete = "off";
newTagInput.placeholder = "新标签，按 Enter";
newTagInput.setAttribute("aria-label", "新标签名称，按 Enter 创建并屏蔽作者");
newTagForm.append(newTagLabel, newTagInput);
drawer.append(drawerHeader, tagList, newTagForm);
document.body.append(drawer);

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
    const timeoutId = window.setTimeout(
      callback,
      contract.exitDurationMilliseconds + 30,
    );
    return () => window.clearTimeout(timeoutId);
  },
});

const drawerController = createDrawerController<HTMLElement, HTMLButtonElement>({
  show() {
    renderTagChoices();
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
  commit(task) {
    void commitController.commit(task);
  },
});

function positionDrawer(): void {
  const target = drawerController.getTarget();
  if (!target || drawerVisibility.getPhase() === "hidden") {
    return;
  }

  const buttonBounds = target.button.getBoundingClientRect();
  const horizontalGap = 0;
  const viewportPadding = 8;
  const width = drawer.offsetWidth;
  const height = drawer.offsetHeight;
  const left = Math.max(
    viewportPadding,
    buttonBounds.left - horizontalGap - width,
  );
  const top = Math.min(
    Math.max(viewportPadding, buttonBounds.top),
    Math.max(viewportPadding, window.innerHeight - height - viewportPadding),
  );
  drawer.style.left = `${left}px`;
  drawer.style.top = `${top}px`;
}

function renderTagChoices(): void {
  renderTagList(tagList, currentState.tags, {
    selectTag(tag) {
      submitDrawerSelection({ tag, isNewTag: false });
    },
    deleteTag(tagId, event) {
      void tagDeletionController.deleteTag(tagId, event);
    },
  });
}

function openDrawer(card: HTMLElement, button: HTMLButtonElement): void {
  const target: HtmlDrawerTarget = {
    targetId: getCardTargetId(card),
    card,
    button,
    authorNameAtClick: getAuthorName(card),
  };
  drawerController.open(target);
}

function showTagValidationError(error: "empty" | "too-long" | "duplicate"): void {
  const messages = {
    empty: "标签名称不能为空。",
    "too-long": "标签名称最多 30 个字符。",
    duplicate: "标签名称已存在，请选择已有标签。",
  } as const;
  newTagInput.setCustomValidity(messages[error]);
  newTagInput.reportValidity();
}

function submitDrawerSelection(selection: TagSelection): void {
  drawerController.submit(selection);
}

newTagInput.addEventListener("input", () => {
  drawerController.setDraft(newTagInput.value);
  newTagInput.setCustomValidity("");
});

newTagForm.addEventListener("submit", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const validation = validateNewTagLabel(newTagInput.value, currentState.tags);
  if (validation.error) {
    showTagValidationError(validation.error);
    return;
  }

  submitDrawerSelection({
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
    if (
      drawerController.getState().status !== "open" ||
      event.key !== "Escape"
    ) {
      return;
    }

    drawerController.cancel(event);
  },
  true,
);

document.addEventListener(
  "pointerdown",
  (event) => {
    if (
      drawerController.getState().status !== "open" ||
      !(event.target instanceof Node)
    ) {
      blockedOutsideClickTarget = null;
      return;
    }

    blockedOutsideClickTarget = null;

    if (drawer.contains(event.target)) {
      return;
    }

    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest(`.${CLOSE_BUTTON_CLASS}`)) {
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
    if (
      drawerController.getState().status !== "open" ||
      !(event.target instanceof Node)
    ) {
      return;
    }

    if (
      !drawer.contains(event.target) &&
      !(event.target instanceof Element &&
        event.target.closest(`.${CLOSE_BUTTON_CLASS}`))
    ) {
      drawerController.cancel(event);
    }
  },
  true,
);

window.addEventListener("resize", positionDrawer);
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
    openDrawer(card, closeButton);
  });

  card.append(closeButton);
}

function queueVisibility(card: HTMLElement, hidden: boolean): void {
  pendingVisibility.set(card, hidden);
  if (!visibilityFrameRequested) {
    visibilityFrameRequested = true;
    requestAnimationFrame(processPendingVisibility);
  }
}

function processPendingVisibility(): void {
  visibilityFrameRequested = false;
  const batch = Array.from(pendingVisibility.entries()).slice(0, BATCH_SIZE);
  for (const [card, hidden] of batch) {
    pendingVisibility.delete(card);
    if (card.isConnected) {
      card.classList.toggle(BLACKLISTED_CARD_CLASS, hidden);
    }
  }

  if (pendingVisibility.size > 0) {
    visibilityFrameRequested = true;
    requestAnimationFrame(processPendingVisibility);
  }
}

const filterController = createCardFilterController<HTMLElement>({
  prepareCard: enhanceCard,
  resolveStableUserId: getAuthorUserId,
  setHidden: queueVisibility,
  reportFailure(error) {
    console.warn("[Cocoon] 无法判断卡片作者。", error);
  },
  schedule(callback) {
    requestAnimationFrame(callback);
  },
  batchSize: BATCH_SIZE,
});

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

const commitController = createCommitController<HTMLElement, HTMLButtonElement>({
  withExclusiveLock: withStorageLock,
  resolveStableUserId: getAuthorUserId,
  captureCardImage,
  now: () => new Date(),
  readState: readStoredState,
  writeState: writeStoredState,
  applyPersistedState: replaceRuntimeState,
  requestFailureFocus(button) {
    if (drawerController.getState().status === "closed" && button.isConnected) {
      button.focus({ preventScroll: true });
    }
  },
  reportMalformedStorage,
  reportCaptureFailure(error) {
    console.warn(
      "[Cocoon] 无法采集卡片图像，将保存最小黑名单记录。",
      error,
    );
  },
  reportImageOmitted() {
    console.warn("[Cocoon] 无法保存卡片图像，已保存最小黑名单记录。");
  },
  reportFailure(error) {
    console.error("[Cocoon] 屏蔽作者失败，未保留会话内黑名单。", error);
  },
});

const tagDeletionController = createTagDeletionController({
  withExclusiveLock: withStorageLock,
  readState: readStoredState,
  writeState: writeStoredState,
  applyPersistedState: replaceRuntimeState,
  reportFailure(error) {
    console.error("[Cocoon] 删除标签失败，未更改标签或作者记录。", error);
  },
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(STORAGE_KEY in changes)) {
    return;
  }

  const parsed = parseBlacklistState(changes[STORAGE_KEY]?.newValue as unknown);
  if (parsed.status === "malformed") {
    reportMalformedStorage();
  }
  replaceRuntimeState(parsed.state);
  if (parsed.status === "missing" || parsed.status === "migrated") {
    void initializeStorage();
  }
});

findCards(document.body);
void initializeStorage();

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      findCards(node);
    }
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
