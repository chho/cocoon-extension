import { EXACT_ZHIHU_URL } from "./zhihu-page-capture.mjs";

export function rawSample(overrides = {}) {
  return {
    contentType: "answer",
    authorName: "Actual Author",
    authorMemberHashId: "real-member-hash",
    profileUserId: "real-user-token",
    fieldEvidence: {
      dataZopAuthorName: true,
      dataZopType: true,
      extraMemberHash: true,
      extraType: true,
    },
    structure: {
      tagName: "div",
      classes: ["TopstoryItem"],
      markers: { content: false, author: false, profileLink: false },
      children: [
        {
          tagName: "div",
          classes: ["ContentItem", "AnswerItem"],
          markers: { content: true, author: false, profileLink: false },
          children: [
            {
              tagName: "a",
              classes: ["AuthorInfo-name", "UserLink-link"],
              markers: { content: false, author: true, profileLink: true },
              children: [],
            },
          ],
        },
      ],
    },
    memberResponse: {
      ok: true,
      status: 200,
      urlToken: "real-user-token",
    },
    ...overrides,
  };
}

export function validCapture(overrides = {}) {
  return {
    sourceUrl: EXACT_ZHIHU_URL,
    selectorCounts: { card: 3, content: 3, author: 2, profileLink: 1 },
    samples: [rawSample()],
    ...overrides,
  };
}
