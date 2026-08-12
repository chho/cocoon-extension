const CARD_SELECTOR = ".TopstoryItem";
const CONTENT_SELECTOR = ".ContentItem[data-zop]";
const ENHANCED_CARD_CLASS = "cocoon-zhihu-card";
const CLOSE_BUTTON_CLASS = "cocoon-zhihu-card-close";
const BATCH_SIZE = 20;

interface ZhihuCardMetadata {
  authorName?: string;
}

const pendingCards = new Set<HTMLElement>();
let frameRequested = false;

function getAuthorName(card: HTMLElement): string {
  const content = card.querySelector<HTMLElement>(CONTENT_SELECTOR);
  const metadata = content?.dataset.zop;

  if (metadata) {
    try {
      const { authorName } = JSON.parse(metadata) as ZhihuCardMetadata;
      if (authorName?.trim()) {
        return authorName.trim();
      }
    } catch (error) {
      console.warn("[Cocoon] 无法解析知乎卡片信息。", error);
    }
  }

  const visibleAuthor = card.querySelector<HTMLElement>(
    ".AuthorInfo-name, .UserLink-link",
  );

  return visibleAuthor?.textContent?.trim() || "未知作者";
}

function enhanceCard(card: HTMLElement): void {
  if (
    card.classList.contains(ENHANCED_CARD_CLASS) ||
    !card.querySelector(CONTENT_SELECTOR)
  ) {
    return;
  }

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = CLOSE_BUTTON_CLASS;
  closeButton.textContent = "×";
  closeButton.title = "查看卡片作者";
  closeButton.setAttribute("aria-label", "查看这张卡片的作者");

  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    console.info(`[Cocoon] 卡片作者：${getAuthorName(card)}`);
  });

  card.classList.add(ENHANCED_CARD_CLASS);
  card.append(closeButton);
}

function processPendingCards(): void {
  frameRequested = false;
  const batch = Array.from(pendingCards).slice(0, BATCH_SIZE);

  for (const card of batch) {
    pendingCards.delete(card);
    enhanceCard(card);
  }

  if (pendingCards.size > 0) {
    requestProcessingFrame();
  }
}

function requestProcessingFrame(): void {
  if (frameRequested) {
    return;
  }

  frameRequested = true;
  requestAnimationFrame(processPendingCards);
}

function enqueueCard(card: HTMLElement): void {
  if (!card.classList.contains(ENHANCED_CARD_CLASS)) {
    pendingCards.add(card);
    requestProcessingFrame();
  }
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

findCards(document.body);

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
