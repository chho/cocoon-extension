import { normalizeMemberHashId } from "./blacklist-state.ts";
import type { DrawerAnchorBounds } from "./drawer-controller.ts";
import { parseZhihuUserId } from "./parse-zhihu-user-id.ts";

const HOVER_ITEM_SELECTOR = ".HoverCard-item";
const HOVER_BUTTON_GROUP_SELECTOR =
  ".MemberButtonGroup.ProfileButtonGroup.HoverCard-buttons";
const PROFILE_LINK_SELECTOR = "a[href]";
const PRIMARY_PROFILE_LINK_SELECTOR = "a.UserLink-link[href]";
const MAX_HOVER_ROOT_ASCENT = 6;
const UNKNOWN_AUTHOR_NAME = "未知作者";

export const HOVER_CARD_ROOT_CLASS = "cocoon-author-hover-card";
export const HOVER_POSITION_ANCHOR_CLASS = "cocoon-hover-position-anchor";
export const HOVER_BLOCK_BUTTON_CLASS = "cocoon-hover-block-button";

export interface HoverAuthorActivation {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly userId: string;
  readonly authorName: string;
  readonly anchorBounds: DrawerAnchorBounds;
}

export interface HoverCardControllerDependencies {
  readonly onActivate: (activation: HoverAuthorActivation) => void;
  readonly schedule: (callback: () => void) => void;
}

export interface HoverCardController {
  handleChildListMutation(
    target: Node,
    addedNodes: Iterable<Node>,
    removedNodes: Iterable<Node>,
  ): void;
  scan(root: Node): void;
}

interface PopupIdentity {
  readonly userId: string;
  readonly authorName: string;
}

interface ResolvedHoverCard extends PopupIdentity {
  readonly root: HTMLElement;
}

function authorNameFromLinks(
  links: readonly HTMLAnchorElement[],
): string | null {
  const textName = links
    .map((link) => link.textContent?.trim())
    .find((name): name is string => Boolean(name));
  if (textName) {
    return textName;
  }

  for (const attribute of ["aria-label", "title"] as const) {
    const attributeName = links
      .map((link) => link.getAttribute(attribute)?.trim())
      .find((name): name is string => Boolean(name));
    if (attributeName) {
      return attributeName;
    }
  }
  return null;
}

function groupProfileLinksByUserId(
  links: Iterable<HTMLAnchorElement>,
): ReadonlyMap<string, readonly HTMLAnchorElement[]> {
  const linksByUserId = new Map<string, HTMLAnchorElement[]>();
  for (const link of links) {
    const href = link.getAttribute("href");
    const parsedUserId = href ? parseZhihuUserId(href) : null;
    if (!parsedUserId) {
      continue;
    }
    const userId = normalizeMemberHashId(parsedUserId) ?? parsedUserId;
    const matchingLinks = linksByUserId.get(userId) ?? [];
    matchingLinks.push(link);
    linksByUserId.set(userId, matchingLinks);
  }
  return linksByUserId;
}

function resolvePopupIdentity(root: HTMLElement): PopupIdentity | null {
  const primaryLinks = root.querySelectorAll<HTMLAnchorElement>(
    PRIMARY_PROFILE_LINK_SELECTOR,
  );
  const linksByUserId = groupProfileLinksByUserId(
    primaryLinks.length > 0
      ? primaryLinks
      : root.querySelectorAll<HTMLAnchorElement>(PROFILE_LINK_SELECTOR),
  );

  if (linksByUserId.size !== 1) {
    return null;
  }

  const entry = linksByUserId.entries().next().value;
  if (!entry) {
    return null;
  }
  const [userId, profileLinks] = entry;
  return {
    userId,
    authorName: authorNameFromLinks(profileLinks) ?? UNKNOWN_AUTHOR_NAME,
  };
}

function resolveHoverCardFromItem(item: HTMLElement): ResolvedHoverCard | null {
  if (!item.isConnected) {
    return null;
  }

  const document = item.ownerDocument;
  let candidate: HTMLElement | null = item;
  for (
    let depth = 0;
    candidate && depth <= MAX_HOVER_ROOT_ASCENT;
    depth += 1
  ) {
    if (
      candidate === document.body ||
      candidate === document.documentElement
    ) {
      return null;
    }

    if (candidate.querySelector(HOVER_BUTTON_GROUP_SELECTOR)) {
      const identity = resolvePopupIdentity(candidate);
      if (identity) {
        return { root: candidate, ...identity };
      }
    }
    candidate = candidate.parentElement;
  }

  return null;
}

function hoverItemsWithin(root: Node): readonly HTMLElement[] {
  const items = new Set<HTMLElement>();
  const document = root.nodeType === 9
    ? root as Document
    : root.ownerDocument;
  const ElementConstructor = document?.defaultView?.Element;

  if (root.nodeType === 9) {
    for (const item of (root as Document).querySelectorAll<HTMLElement>(
      HOVER_ITEM_SELECTOR,
    )) {
      items.add(item);
    }
    return Array.from(items);
  }

  if (root.nodeType === 11) {
    for (const item of (root as DocumentFragment).querySelectorAll<HTMLElement>(
      HOVER_ITEM_SELECTOR,
    )) {
      items.add(item);
    }
    return Array.from(items);
  }

  const start = ElementConstructor && root instanceof ElementConstructor
    ? root as Element
    : root.parentElement;
  if (!start) {
    return [];
  }

  function addItems(element: Element): void {
    if (element.matches(HOVER_ITEM_SELECTOR)) {
      items.add(element as HTMLElement);
    }
    for (const item of element.querySelectorAll<HTMLElement>(
      HOVER_ITEM_SELECTOR,
    )) {
      items.add(item);
    }
  }

  addItems(start);
  if (start === document?.body || start === document?.documentElement) {
    return Array.from(items);
  }

  let ancestor = start.parentElement;
  for (
    let depth = 0;
    ancestor && depth < MAX_HOVER_ROOT_ASCENT;
    depth += 1
  ) {
    if (ancestor === document?.body || ancestor === document?.documentElement) {
      break;
    }
    addItems(ancestor);
    ancestor = ancestor.parentElement;
  }

  return Array.from(items);
}

function directButtons(root: HTMLElement): readonly HTMLButtonElement[] {
  const ButtonConstructor =
    root.ownerDocument.defaultView?.HTMLButtonElement;
  if (!ButtonConstructor) {
    return [];
  }

  return Array.from(root.children).filter(
    (child): child is HTMLButtonElement =>
      child instanceof ButtonConstructor &&
      child.classList.contains(HOVER_BLOCK_BUTTON_CLASS),
  );
}

function snapshotBounds(bounds: DOMRect): DrawerAnchorBounds {
  return {
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    left: bounds.left,
    width: bounds.width,
    height: bounds.height,
  };
}

function resolveCurrentHoverCard(
  button: HTMLButtonElement,
): ResolvedHoverCard | null {
  const root = button.parentElement;
  if (!button.isConnected || !root?.isConnected) {
    return null;
  }

  const items = Array.from(
    root.querySelectorAll<HTMLElement>(HOVER_ITEM_SELECTOR),
  );
  if (root.matches(HOVER_ITEM_SELECTOR)) {
    items.unshift(root);
  }

  for (const item of items) {
    const resolved = resolveHoverCardFromItem(item);
    if (resolved?.root === root) {
      return resolved;
    }
  }
  return null;
}

function isButtonNode(node: Node): boolean {
  return node.nodeType === 1 &&
    (node as Element).classList.contains(HOVER_BLOCK_BUTTON_CLASS);
}

export function createHoverCardController(
  dependencies: HoverCardControllerDependencies,
): HoverCardController {
  const pendingItems = new Set<HTMLElement>();
  const ownedButtons = new WeakSet<HTMLButtonElement>();
  let frameRequested = false;

  function createButton(root: HTMLElement): HTMLButtonElement {
    const button = root.ownerDocument.createElement("button");
    button.type = "button";
    button.className = HOVER_BLOCK_BUTTON_CLASS;
    button.textContent = "屏蔽";
    button.title = "为该作者选择标签并屏蔽";
    button.setAttribute("aria-label", "为悬浮卡片中的作者选择标签并屏蔽");
    ownedButtons.add(button);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const current = resolveCurrentHoverCard(button);
      if (!current) {
        return;
      }
      dependencies.onActivate({
        ...current,
        button,
        anchorBounds: snapshotBounds(button.getBoundingClientRect()),
      });
    });

    root.append(button);
    return button;
  }

  function ensureSingleButton(root: HTMLElement): void {
    root.classList.add(HOVER_CARD_ROOT_CLASS);
    const position = root.ownerDocument.defaultView
      ?.getComputedStyle(root).position;
    if (!position || position === "static") {
      root.classList.add(HOVER_POSITION_ANCHOR_CLASS);
    }

    const buttons = directButtons(root);
    const button = buttons.find((candidate) => ownedButtons.has(candidate)) ??
      createButton(root);
    for (const candidate of directButtons(root)) {
      if (candidate !== button) {
        candidate.remove();
      }
    }
  }

  function processPendingItems(): void {
    frameRequested = false;
    const items = Array.from(pendingItems);
    pendingItems.clear();
    const roots = new Set<HTMLElement>();

    for (const item of items) {
      const resolved = resolveHoverCardFromItem(item);
      if (resolved) {
        roots.add(resolved.root);
      }
    }
    for (const root of roots) {
      ensureSingleButton(root);
    }
  }

  function requestFrame(): void {
    if (frameRequested || pendingItems.size === 0) {
      return;
    }
    frameRequested = true;
    dependencies.schedule(processPendingItems);
  }

  function scan(root: Node): void {
    if (isButtonNode(root)) {
      return;
    }
    for (const item of hoverItemsWithin(root)) {
      pendingItems.add(item);
    }
    requestFrame();
  }

  function handleChildListMutation(
    target: Node,
    addedNodesInput: Iterable<Node>,
    removedNodesInput: Iterable<Node>,
  ): void {
    const addedNodes = Array.from(addedNodesInput);
    const removedNodes = Array.from(removedNodesInput);
    const isOwnButtonAddition =
      removedNodes.length === 0 &&
      addedNodes.length > 0 &&
      addedNodes.every(
        (node) =>
          isButtonNode(node) &&
          ownedButtons.has(node as HTMLButtonElement),
      );
    if (isOwnButtonAddition) {
      return;
    }

    scan(target);
    for (const node of addedNodes) {
      scan(node);
    }
  }

  return { handleChildListMutation, scan };
}
