export const EXACT_ZHIHU_URL = "https://www.zhihu.com/";

// Keep this function self-contained: the CLI serializes it into a clean CDP
// isolated world, while tests inject a small fake browser environment.
export async function captureZhihuPage(environment = globalThis, sampleLimit = 3) {
  const exactUrl = "https://www.zhihu.com/";
  if (environment.location.href !== exactUrl) {
    throw new Error("The Zhihu page URL changed before capture.");
  }

  const limit = sampleLimit;
  const cardSelector = ".TopstoryItem";
  const contentSelector = ".ContentItem[data-zop]";
  const authorSelector = ".AuthorInfo-name, .UserLink-link";
  const profileLinkSelector =
    "a.AuthorInfo-name[href], a.UserLink-link[href], .AuthorInfo-name a[href]";
  const allowedTags = new Set(["a", "article", "div", "section", "span"]);
  const allowedClasses = new Set([
    "TopstoryItem",
    "ContentItem",
    "AnswerItem",
    "ArticleItem",
    "Card",
    "AuthorInfo",
    "AuthorInfo-content",
    "AuthorInfo-head",
    "AuthorInfo-avatar",
    "AuthorInfo-name",
    "UserLink",
    "UserLink-link",
  ]);

  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const parseObjectAttribute = (element, attributeName) => {
    const source = element.getAttribute(attributeName);
    if (!source) return {};
    try {
      const value = JSON.parse(source);
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  };
  const toStringValue = (value) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  };
  const getNestedRecord = (value, key) =>
    isRecord(value) && isRecord(value[key]) ? value[key] : {};
  const classifyContent = (content, dataZop, extraContent) => {
    const candidates = [
      toStringValue(dataZop.type),
      toStringValue(extraContent.type),
      ...content.classList,
    ];
    for (const candidate of candidates) {
      const normalized = candidate?.toLowerCase();
      if (normalized?.includes("article") || normalized?.includes("post")) {
        return "article";
      }
      if (normalized?.includes("answer")) return "answer";
    }
    return null;
  };
  const getProfileUserId = (link) => {
    if (!(link instanceof environment.HTMLAnchorElement)) return null;
    try {
      const url = new URL(link.href, environment.location.href);
      const match = /^\/people\/([^/]+)\/?$/.exec(url.pathname);
      return url.origin === environment.location.origin && match
        ? decodeURIComponent(match[1])
        : null;
    } catch {
      return null;
    }
  };
  const captureStructure = (card, content, authorElement, profileLink) => {
    const selected = new Set([card, content]);
    const addPath = (start) => {
      let node = start;
      while (
        node instanceof environment.Element &&
        card.contains(node)
      ) {
        selected.add(node);
        if (node === card) break;
        node = node.parentElement;
      }
    };

    addPath(content);
    addPath(authorElement);
    addPath(profileLink);

    const serialize = (element) => {
      const tagName = element.tagName.toLowerCase();
      return {
      tagName: allowedTags.has(tagName) ? tagName : "div",
      classes: [...element.classList].filter((className) =>
        allowedClasses.has(className),
      ),
      markers: {
        content: element === content,
        author: element === authorElement,
        profileLink: element === profileLink,
      },
      children: [...element.children]
        .filter((child) => selected.has(child))
        .map(serialize),
      };
    };

    return serialize(card);
  };

  const selected = [];
  const counts = { answer: 0, article: 0 };
  const allCards = [...environment.document.querySelectorAll(cardSelector)];

  for (const card of allCards) {
    if (!(card instanceof environment.HTMLElement)) continue;
    const content = card.querySelector(contentSelector);
    if (!(content instanceof environment.HTMLElement)) continue;

    const dataZop = parseObjectAttribute(content, "data-zop");
    const extraModule = parseObjectAttribute(content, "data-za-extra-module");
    const cardData = getNestedRecord(extraModule, "card");
    const extraContent = getNestedRecord(cardData, "content");
    const contentType = classifyContent(content, dataZop, extraContent);
    if (!contentType || counts[contentType] >= limit) continue;

    const authorElement = card.querySelector(authorSelector);
    const profileLink = card.querySelector(profileLinkSelector);
    const authorName =
      toStringValue(dataZop.authorName) ??
      toStringValue(authorElement?.textContent) ??
      null;
    const profileUserId = getProfileUserId(profileLink);

    selected.push({
      contentType,
      authorName,
      authorMemberHashId: toStringValue(extraContent.author_member_hash_id),
      profileUserId,
      fieldEvidence: {
        dataZopAuthorName: Object.hasOwn(dataZop, "authorName"),
        dataZopType: Object.hasOwn(dataZop, "type"),
        extraMemberHash: Object.hasOwn(extraContent, "author_member_hash_id"),
        extraType: Object.hasOwn(extraContent, "type"),
      },
      structure: captureStructure(
        card,
        content,
        authorElement instanceof environment.Element ? authorElement : null,
        profileLink instanceof environment.Element ? profileLink : null,
      ),
      memberResponse: null,
    });
    counts[contentType] += 1;

    if (counts.answer >= limit && counts.article >= limit) break;
  }

  await Promise.all(
    selected.map(async (sample) => {
      if (!sample.authorMemberHashId) return;
      const memberPath =
        "/api/v4/members/" + encodeURIComponent(sample.authorMemberHashId);
      if (environment.location.href !== exactUrl) {
        throw new Error("The Zhihu page URL changed before a member request.");
      }
      try {
        const response = await environment.fetch(memberPath, {
          credentials: "same-origin",
        });
        let urlToken = null;
        if (response.ok) {
          const body = await response.json();
          urlToken = isRecord(body) ? toStringValue(body.url_token) : null;
        }
        sample.memberResponse = {
          ok: response.ok,
          status: response.status,
          urlToken,
        };
      } catch {
        sample.memberResponse = { ok: false, status: 0, urlToken: null };
      }
    }),
  );

  if (environment.location.href !== exactUrl) {
    throw new Error("The Zhihu page URL changed during capture.");
  }

  return {
    sourceUrl: environment.location.href,
    selectorCounts: {
      card: environment.document.querySelectorAll(cardSelector).length,
      content: environment.document.querySelectorAll(contentSelector).length,
      author: environment.document.querySelectorAll(authorSelector).length,
      profileLink: environment.document.querySelectorAll(profileLinkSelector).length,
    },
    samples: selected,
  };
}

export function createPageCaptureExpression(sampleLimit) {
  return `(${captureZhihuPage.toString()})(globalThis, ${sampleLimit})`;
}
