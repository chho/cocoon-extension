import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  createInitialState,
  parseBlacklistState,
  type BlacklistState,
} from "./blacklist-state.ts";
import { createAuthorAliasPersistenceController } from "./author-alias-persistence-controller.ts";
import {
  COMMENT_HIDDEN_CLASS,
  createCommentFilterController,
  resolveCommentAuthorUserId,
} from "./comment-filter-controller.ts";
import { createMemberUserIdResolver } from "./resolve-member-user-id.ts";
import { COMMENT_MUTATION_ATTRIBUTE_FILTER } from "../plugins/zhihu/runtime.ts";

function fixture(): JSDOM {
  return new JSDOM(`<!doctype html><body>
    <div class="TopstoryItem">
      <div class="Comments-container">
        <div data-id="comment-record-not-a-user-id" id="top-blocked">
          <a href="/people/blocked-top">avatar</a>
          <a href="https://www.zhihu.com/people/blocked-top">Blocked top</a>
          <p>top body</p>
          <div data-id="reply-record-not-a-user-id" id="reply-visible">
            <a href="/people/visible-reply">Visible reply</a>
            <p>reply body</p>
          </div>
        </div>
        <div data-id="ambiguous" id="ambiguous">
          <a href="/people/first">comment author</a>
          <p>mentions <a href="/people/second">another profile</a></p>
        </div>
        <div data-id="name-only" id="name-only">blocked-top</div>
      </div>
    </div>
    <div data-id="outside-comment-boundary" id="outside-boundary">
      <a href="/people/blocked-top">outside</a>
    </div>
  </body>`);
}

function createFrames() {
  const frames: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      frames.push(callback);
    },
    flushNext() {
      frames.shift()?.();
    },
    flush() {
      while (frames.length > 0) {
        frames.shift()?.();
      }
    },
  };
}

test("COMMENT-001/004/AC-062/065 uses only own-root exact links and fails open when a profile mention makes them ambiguous", () => {
  const dom = fixture();
  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  const reply = dom.window.document.querySelector<HTMLElement>("#reply-visible");
  const ambiguous = dom.window.document.querySelector<HTMLElement>("#ambiguous");
  const nameOnly = dom.window.document.querySelector<HTMLElement>("#name-only");
  const outside = dom.window.document.querySelector<HTMLElement>(
    "#outside-boundary",
  );
  if (!top || !reply || !ambiguous || !nameOnly || !outside) {
    throw new Error("Missing comment fixtures.");
  }

  strictEqual(resolveCommentAuthorUserId(top), "blocked-top");
  strictEqual(resolveCommentAuthorUserId(reply), "visible-reply");
  strictEqual(resolveCommentAuthorUserId(ambiguous), null);
  strictEqual(resolveCommentAuthorUserId(nameOnly), null);
  strictEqual(resolveCommentAuthorUserId(outside), null);
  strictEqual(resolveCommentAuthorUserId(top), "blocked-top");
});

test("COMMENT-001/003/AC-062 filters direct and upvoter IDs with one CSS state only", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  controller.scan(dom.window.document.body);
  controller.scan(dom.window.document.body);
  controller.updateStableUserIds(new Set(["blocked-top", "visible-reply"]));
  frames.flush();

  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  const reply = dom.window.document.querySelector<HTMLElement>("#reply-visible");
  const ambiguous = dom.window.document.querySelector<HTMLElement>("#ambiguous");
  const outside = dom.window.document.querySelector<HTMLElement>(
    "#outside-boundary",
  );
  if (!top || !reply || !ambiguous || !outside) {
    throw new Error("Missing fixtures.");
  }
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(reply.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(
    top.className.split(/\s+/).filter((name) => name === COMMENT_HIDDEN_CLASS).length,
    1,
  );
  strictEqual(ambiguous.classList.contains(COMMENT_HIDDEN_CLASS), false);
  strictEqual(outside.classList.contains(COMMENT_HIDDEN_CLASS), false);
  strictEqual(top.querySelector("p")?.textContent, "top body");
  strictEqual(top.isConnected, true);
});

test("COMMENT-002/AC-063 dynamically inserted comments and replies are RAF-batched and idempotent", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    batchSize: 1,
  });
  controller.updateStableUserIds(new Set(["dynamic-author"]));
  frames.flush();

  const container = dom.window.document.querySelector<HTMLElement>(
    ".Comments-container",
  );
  if (!container) throw new Error("Missing comments container.");
  const wrapper = dom.window.document.createElement("section");
  wrapper.innerHTML = `
    <div data-id="dynamic-top" id="dynamic-top">
      <a href="/people/dynamic-author">dynamic</a>
      <div data-id="dynamic-reply" id="dynamic-reply">
        <a href="/people/dynamic-author">dynamic reply</a>
      </div>
    </div>`;
  container.append(wrapper);
  controller.scan(wrapper);
  controller.scan(wrapper);
  frames.flush();

  strictEqual(
    dom.window.document.querySelector("#dynamic-top")?.classList.contains(
      COMMENT_HIDDEN_CLASS,
    ),
    true,
  );
  strictEqual(
    dom.window.document.querySelector("#dynamic-reply")?.classList.contains(
      COMMENT_HIDDEN_CLASS,
    ),
    true,
  );
});

test("COMMENT-002 pending processing forgets detached roots until their reinserted DOM is scanned", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  controller.updateStableUserIds(new Set(["blocked-top"]));
  frames.flush();

  const container = dom.window.document.querySelector<HTMLElement>(
    ".Comments-container",
  );
  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!container || !top) throw new Error("Missing comment fixture.");
  controller.scan(top);
  top.remove();
  frames.flush();

  container.append(top);
  controller.updateStableUserIds(new Set(["blocked-top"]));
  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), false);

  controller.scan(top);
  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
});

test("BUG-003/AC-066 refresh discovers connected roots that were never encountered and filters them in RAF batches", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    batchSize: 1,
  });
  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  const reply = dom.window.document.querySelector<HTMLElement>("#reply-visible");
  if (!top || !reply) throw new Error("Missing comment fixtures.");

  controller.refreshStableUserIds(
    new Set(["blocked-top", "visible-reply"]),
    dom.window.document.body,
  );

  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), false);
  strictEqual(reply.classList.contains(COMMENT_HIDDEN_CLASS), false);
  frames.flushNext();
  strictEqual(
    [top, reply].filter((root) => root.classList.contains(COMMENT_HIDDEN_CLASS))
      .length,
    1,
  );
  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(reply.classList.contains(COMMENT_HIDDEN_CLASS), true);
});

test("BUG-003/AC-066 a current encountered root hides as soon as the applied state batch runs", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  controller.scan(dom.window.document.body);
  frames.flush();

  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!top) throw new Error("Missing top comment.");
  controller.refreshStableUserIds(
    new Set(["blocked-top"]),
    dom.window.document.body,
  );
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), false);

  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(top.isConnected, true);
});

test("BUG-003/AC-067 retained comment DOM stays hidden across collapse and reopen", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  const container = dom.window.document.querySelector<HTMLElement>(
    ".Comments-container",
  );
  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!container || !top) throw new Error("Missing comment fixture.");

  controller.refreshStableUserIds(
    new Set(["blocked-top"]),
    dom.window.document.body,
  );
  frames.flush();
  container.hidden = true;
  container.hidden = false;

  strictEqual(top.isConnected, true);
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
});

test("BUG-003/AC-067 replacement comment DOM is filtered by MutationObserver-style scanning with current IDs", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  controller.refreshStableUserIds(
    new Set(["blocked-top"]),
    dom.window.document.body,
  );
  frames.flush();

  const current = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!current) throw new Error("Missing current comment.");
  const replacement = dom.window.document.createElement("div");
  replacement.id = "replacement-blocked";
  replacement.dataset.id = "replacement-comment-record";
  replacement.innerHTML = '<a href="/people/blocked-top">replacement author</a>';
  current.replaceWith(replacement);

  controller.scan(replacement);
  strictEqual(replacement.classList.contains(COMMENT_HIDDEN_CLASS), false);
  frames.flush();
  strictEqual(replacement.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(replacement.isConnected, true);
});

test("COMMENT-003/004/AC-064 state refresh re-filters open roots and fails open", () => {
  const dom = fixture();
  const frames = createFrames();
  const controller = createCommentFilterController({ schedule: frames.schedule });
  controller.scan(dom.window.document.body);
  frames.flush();

  const top = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!top) throw new Error("Missing top comment.");
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), false);

  controller.updateStableUserIds(new Set(["blocked-top"]));
  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);

  controller.updateStableUserIds(new Set());
  frames.flush();
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), false);
});

const MEMBER_HASH = "a".repeat(32);
const OTHER_HASH = "b".repeat(32);
const MENTION_HASH = "c".repeat(32);
const ALIAS_TIMESTAMP = "2026-08-14T12:00:00.000Z";

type ProfileLinkKind = "image" | "text" | "empty";

interface ProfileLinkFixture {
  readonly userId: string;
  readonly kind: ProfileLinkKind;
}

interface CommentEvidenceFixtureOptions {
  readonly mainLinks: readonly ProfileLinkFixture[];
  readonly mentionLinks?: readonly ProfileLinkFixture[];
  readonly mentionsBeforeMain?: boolean;
  readonly rootCount?: number;
  readonly containerClass?: "Comments-container" | "Modal-content";
}

function profileLink(userId: string, kind: ProfileLinkKind): ProfileLinkFixture {
  return { userId, kind };
}

function semanticProfileLinks(userId: string): readonly ProfileLinkFixture[] {
  return [profileLink(userId, "image"), profileLink(userId, "text")];
}

function renderProfileLinks(links: readonly ProfileLinkFixture[]): string {
  return links.map(({ userId, kind }, linkIndex) => {
    const content = kind === "image"
      ? "<img>"
      : kind === "text"
      ? `profile ${linkIndex}`
      : "   ";
    return `<a href="/people/${userId}">${content}</a>`;
  }).join("");
}

function commentEvidenceFixture({
  mainLinks,
  mentionLinks = [],
  mentionsBeforeMain = false,
  rootCount = 1,
  containerClass = "Modal-content",
}: CommentEvidenceFixtureOptions): JSDOM {
  const mainMarkup = renderProfileLinks(mainLinks);
  const mentionMarkup = `<p>${renderProfileLinks(mentionLinks)}</p>`;
  const ownProfileMarkup = mentionsBeforeMain
    ? `${mentionMarkup}${mainMarkup}`
    : `${mainMarkup}${mentionMarkup}`;

  return new JSDOM(`<!doctype html><body>
    <div class="${containerClass}">
      ${Array.from({ length: rootCount }, (_, rootIndex) => `
        <div data-id="comment-${rootIndex}" id="comment-${rootIndex}">
          ${ownProfileMarkup}
        </div>`).join("")}
    </div>
  </body>`);
}

test("BUG-011 preserves the single unique stable-ID rule regardless of link shape or count", () => {
  const scenarios: readonly (readonly ProfileLinkFixture[])[] = [
    [profileLink("single-profile", "text")],
    [profileLink("single-profile", "image")],
    [
      profileLink("single-profile", "empty"),
      profileLink("single-profile", "text"),
      profileLink("single-profile", "image"),
    ],
  ];

  for (const mainLinks of scenarios) {
    const dom = commentEvidenceFixture({ mainLinks });
    const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
    if (!root) throw new Error("Missing single-identity fixture.");
    strictEqual(resolveCommentAuthorUserId(root), "single-profile");
  }
});

test("BUG-011/AC-070 a single-link unblocked main author plus a duplicated blocked text mention stays visible without alias work", () => {
  const dom = commentEvidenceFixture({
    mainLinks: [profileLink("visible-main", "text")],
    mentionLinks: [
      profileLink("blocked-mention", "text"),
      profileLink("blocked-mention", "text"),
    ],
  });
  const frames = createFrames();
  let aliasAttempts = 0;
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias() {
      aliasAttempts += 1;
    },
  });
  const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
  if (!root) throw new Error("Missing duplicated direct-mention fixture.");

  strictEqual(resolveCommentAuthorUserId(root), null);
  controller.updateStableUserIds(new Set(["blocked-mention"]));
  controller.scan(dom.window.document.body);
  frames.flush();

  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false);
  strictEqual(aliasAttempts, 0);
});

test("BUG-011/AC-070 a duplicated text-only hash mention never triggers an alias GET", () => {
  const dom = commentEvidenceFixture({
    mainLinks: [profileLink("visible-main", "text")],
    mentionLinks: [
      profileLink(MENTION_HASH, "text"),
      profileLink(MENTION_HASH, "text"),
    ],
  });
  const frames = createFrames();
  const requestedAliases: string[] = [];
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias(memberHashId) {
      requestedAliases.push(memberHashId);
    },
  });
  const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
  if (!root) throw new Error("Missing duplicated hash-mention fixture.");

  strictEqual(resolveCommentAuthorUserId(root), null);
  controller.updateStableUserIds(new Set(["canonical-token"]));
  controller.scan(dom.window.document.body);
  frames.flush();

  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false);
  deepStrictEqual(requestedAliases, []);
});

test("BUG-011/AC-070 the unique semantic main pair filters direct token and member-hash matches with zero GETs", () => {
  const scenarios = [
    {
      name: "token main with hash mention before it",
      mainUserId: "blocked-main",
      mentionUserId: MENTION_HASH,
      mentionsBeforeMain: true,
    },
    {
      name: "member-hash main with token mention after it",
      mainUserId: MEMBER_HASH,
      mentionUserId: "blocked-mention",
      mentionsBeforeMain: false,
    },
  ] as const;

  for (const scenario of scenarios) {
    const dom = commentEvidenceFixture({
      mainLinks: semanticProfileLinks(scenario.mainUserId),
      mentionLinks: [profileLink(scenario.mentionUserId, "text")],
      mentionsBeforeMain: scenario.mentionsBeforeMain,
    });
    const frames = createFrames();
    let aliasAttempts = 0;
    const controller = createCommentFilterController({
      schedule: frames.schedule,
      async resolveHistoricalAlias() {
        aliasAttempts += 1;
      },
    });
    const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
    if (!root) throw new Error(`Missing ${scenario.name} fixture.`);

    strictEqual(
      resolveCommentAuthorUserId(root),
      scenario.mainUserId,
      scenario.name,
    );
    controller.updateStableUserIds(new Set([
      scenario.mainUserId,
      scenario.mentionUserId,
    ]));
    controller.scan(dom.window.document.body);
    frames.flush();

    strictEqual(
      root.classList.contains(COMMENT_HIDDEN_CLASS),
      true,
      scenario.name,
    );
    strictEqual(aliasAttempts, 0, scenario.name);
  }
});

test("BUG-011/AC-070 multiple semantic pairs or another image-bearing identity fail open", () => {
  const scenarios: readonly (readonly ProfileLinkFixture[])[] = [
    semanticProfileLinks(OTHER_HASH),
    [profileLink(OTHER_HASH, "image")],
  ];

  for (const mentionLinks of scenarios) {
    const dom = commentEvidenceFixture({
      mainLinks: semanticProfileLinks(MEMBER_HASH),
      mentionLinks,
    });
    const frames = createFrames();
    let aliasAttempts = 0;
    const controller = createCommentFilterController({
      schedule: frames.schedule,
      async resolveHistoricalAlias() {
        aliasAttempts += 1;
      },
    });
    const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
    if (!root) throw new Error("Missing image-ambiguity fixture.");

    strictEqual(resolveCommentAuthorUserId(root), null);
    controller.updateStableUserIds(new Set([MEMBER_HASH, OTHER_HASH]));
    controller.scan(dom.window.document.body);
    frames.flush();

    strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false);
    strictEqual(aliasAttempts, 0);
  }
});

test("BUG-011/COMMENT-004 nested comment roots own their semantic profile evidence independently", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="Modal-content">
      <div data-id="outer" id="semantic-outer">
        ${renderProfileLinks(semanticProfileLinks("outer-main"))}
        <p>${renderProfileLinks([profileLink("outer-mention", "text")])}</p>
        <div data-id="nested" id="semantic-nested">
          ${renderProfileLinks(semanticProfileLinks("nested-main"))}
        </div>
      </div>
    </div>
  </body>`);
  const outer = dom.window.document.querySelector<HTMLElement>("#semantic-outer");
  const nested = dom.window.document.querySelector<HTMLElement>("#semantic-nested");
  if (!outer || !nested) throw new Error("Missing nested semantic fixtures.");

  strictEqual(resolveCommentAuthorUserId(outer), "outer-main");
  strictEqual(resolveCommentAuthorUserId(nested), "nested-main");
});

function aliasCommentFixture(
  count = 1,
  containerClass = "Comments-container",
): JSDOM {
  return new JSDOM(`<!doctype html><body>
    <div class="${containerClass}">
      ${Array.from({ length: count }, (_, index) => `
        <div data-id="hash-comment-${index}" id="hash-comment-${index}">
          <a href="/people/${MEMBER_HASH}">author</a>
        </div>`).join("")}
    </div>
  </body>`);
}

function blockedAliasState(memberHashId: string | null = null): BlacklistState {
  return {
    ...createInitialState(),
    authors: [{
      userId: "canonical-token",
      memberHashId,
      authorNameAtCapture: "Stored name",
      tagId: "default",
      blacklistedAt: ALIAS_TIMESTAMP,
      blockSource: "direct",
    }],
  };
}

function stableIds(state: BlacklistState): ReadonlySet<string> {
  return new Set(state.authors.flatMap((author) =>
    author.memberHashId === null
      ? [author.userId]
      : [author.userId, author.memberHashId]
  ));
}

async function settleAliasWork(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

interface CommentMutationScanner {
  scan(root: Node): void;
}

function observeCommentMutations(
  dom: JSDOM,
  scanner: CommentMutationScanner,
  onMutation?: (mutation: MutationRecord) => void,
) {
  const observer = new dom.window.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      onMutation?.(mutation);
      if (mutation.type === "attributes") {
        scanner.scan(mutation.target);
        continue;
      }

      for (const node of mutation.addedNodes) {
        scanner.scan(node);
      }
      for (const node of mutation.removedNodes) {
        scanner.scan(node);
      }
    }
  });
  observer.observe(dom.window.document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...COMMENT_MUTATION_ATTRIBUTE_FILTER],
  });
  return observer;
}

async function deliverMutationRecords(dom: JSDOM): Promise<void> {
  await new Promise<void>((resolve) => {
    dom.window.queueMicrotask(resolve);
  });
}

test("BUG-012/AC-071 data-id maturation reaches alias backfill through the production observer whitelist", async () => {
  deepStrictEqual(COMMENT_MUTATION_ATTRIBUTE_FILTER, ["href", "data-id"]);

  const dom = new JSDOM(`<!doctype html><body>
    <div class="Comments-container" id="progressive-comments"></div>
  </body>`);
  const frames = createFrames();
  let stored = blockedAliasState();
  let writes = 0;
  const requestedMemberPaths: string[] = [];
  const resolveMemberUserId = createMemberUserIdResolver(async (input, init) => {
    requestedMemberPaths.push(String(input));
    strictEqual(input, `/api/v4/members/${MEMBER_HASH}`);
    deepStrictEqual(init, { credentials: "same-origin" });
    return {
      ok: true,
      async json() {
        return { url_token: "canonical-token" };
      },
    };
  });
  let controller: ReturnType<typeof createCommentFilterController>;
  const aliasController = createAuthorAliasPersistenceController({
    resolveMemberUserId,
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      stored = state;
    },
    applyPersistedState(state) {
      controller.updateStableUserIds(stableIds(state));
    },
  });
  const completions: Promise<unknown>[] = [];
  controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias(memberHashId) {
      const completion = aliasController.persistMemberHashAlias(memberHashId);
      completions.push(completion);
      await completion;
    },
  });
  controller.updateStableUserIds(stableIds(stored));
  frames.flush();

  const scannedMutationRoots: Node[] = [];
  const observedAttributeNames: string[] = [];
  const observer = observeCommentMutations(
    dom,
    {
      scan(root) {
        scannedMutationRoots.push(root);
        controller.scan(root);
      },
    },
    (mutation) => {
      if (mutation.type === "attributes" && mutation.attributeName) {
        observedAttributeNames.push(mutation.attributeName);
      }
    },
  );
  const container = dom.window.document.querySelector<HTMLElement>(
    "#progressive-comments",
  );
  if (!container) throw new Error("Missing progressive comments container.");
  const progressiveRoot = dom.window.document.createElement("div");
  progressiveRoot.id = "progressive-comment";
  progressiveRoot.innerHTML = `
    ${renderProfileLinks(semanticProfileLinks(MEMBER_HASH))}
    <p>${renderProfileLinks([profileLink(MENTION_HASH, "text")])}</p>`;

  container.append(progressiveRoot);
  await deliverMutationRecords(dom);
  frames.flush();

  strictEqual(progressiveRoot.hasAttribute("data-id"), false);
  strictEqual(requestedMemberPaths.length, 0);
  strictEqual(writes, 0);
  strictEqual(progressiveRoot.classList.contains(COMMENT_HIDDEN_CLASS), false);
  const scansAfterInsertion = scannedMutationRoots.length;

  progressiveRoot.setAttribute("title", "unrelated mutation");
  await deliverMutationRecords(dom);
  frames.flush();

  strictEqual(scannedMutationRoots.length, scansAfterInsertion);
  deepStrictEqual(observedAttributeNames, []);
  strictEqual(requestedMemberPaths.length, 0);

  progressiveRoot.setAttribute("data-id", "mature-comment-root");
  await deliverMutationRecords(dom);
  strictEqual(scannedMutationRoots.length, scansAfterInsertion + 1);
  deepStrictEqual(observedAttributeNames, ["data-id"]);
  frames.flush();
  await Promise.all(completions);
  await settleAliasWork();
  frames.flush();
  await deliverMutationRecords(dom);

  deepStrictEqual(requestedMemberPaths, [
    `/api/v4/members/${MEMBER_HASH}`,
  ]);
  strictEqual(writes, 1);
  strictEqual(stored.authors[0]?.memberHashId, MEMBER_HASH);
  strictEqual(progressiveRoot.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(scannedMutationRoots.length, scansAfterInsertion + 1);
  deepStrictEqual(observedAttributeNames, ["data-id"]);
  observer.disconnect();
});

test("BUG-012/AC-071 the shared whitelist retains href identity rescans", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="Modal-content" id="href-comments"></div>
  </body>`);
  const frames = createFrames();
  let aliasAttempts = 0;
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias() {
      aliasAttempts += 1;
    },
  });
  controller.updateStableUserIds(new Set(["blocked-after-href-change"]));
  frames.flush();

  const scannedMutationRoots: Node[] = [];
  const observedAttributeNames: string[] = [];
  const observer = observeCommentMutations(
    dom,
    {
      scan(root) {
        scannedMutationRoots.push(root);
        controller.scan(root);
      },
    },
    (mutation) => {
      if (mutation.type === "attributes" && mutation.attributeName) {
        observedAttributeNames.push(mutation.attributeName);
      }
    },
  );
  const container = dom.window.document.querySelector<HTMLElement>(
    "#href-comments",
  );
  if (!container) throw new Error("Missing href comments container.");
  const root = dom.window.document.createElement("div");
  root.dataset.id = "href-comment";
  root.innerHTML = '<a href="/people/visible-before-change">author</a>';
  const link = root.querySelector<HTMLAnchorElement>("a[href]");
  if (!link) throw new Error("Missing href mutation link.");

  container.append(root);
  await deliverMutationRecords(dom);
  frames.flush();
  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false);
  const scansAfterInsertion = scannedMutationRoots.length;

  link.setAttribute("aria-label", "unrelated mutation");
  await deliverMutationRecords(dom);
  frames.flush();
  strictEqual(scannedMutationRoots.length, scansAfterInsertion);
  deepStrictEqual(observedAttributeNames, []);

  link.setAttribute("href", "/people/blocked-after-href-change");
  await deliverMutationRecords(dom);
  frames.flush();

  strictEqual(scannedMutationRoots.length, scansAfterInsertion + 1);
  deepStrictEqual(observedAttributeNames, ["href"]);
  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(aliasAttempts, 0);
  observer.disconnect();
});

async function runSemanticMainAliasScenario(rootCount: number): Promise<{
  readonly requestedMemberPaths: readonly string[];
  readonly writes: number;
  readonly stored: BlacklistState;
  readonly roots: readonly HTMLElement[];
}> {
  const dom = commentEvidenceFixture({
    mainLinks: semanticProfileLinks(MEMBER_HASH),
    mentionLinks: [
      profileLink(OTHER_HASH, "text"),
      profileLink(OTHER_HASH, "text"),
      profileLink(MENTION_HASH, "text"),
    ],
    mentionsBeforeMain: true,
    rootCount,
  });
  const frames = createFrames();
  let stored = blockedAliasState();
  let writes = 0;
  const requestedMemberPaths: string[] = [];
  const resolveMemberUserId = createMemberUserIdResolver(async (input, init) => {
    requestedMemberPaths.push(String(input));
    strictEqual(input, `/api/v4/members/${MEMBER_HASH}`);
    deepStrictEqual(init, { credentials: "same-origin" });
    return {
      ok: true,
      async json() {
        return { url_token: "canonical-token" };
      },
    };
  });
  let controller: ReturnType<typeof createCommentFilterController>;
  const aliasController = createAuthorAliasPersistenceController({
    resolveMemberUserId,
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      stored = state;
    },
    applyPersistedState(state) {
      controller.updateStableUserIds(stableIds(state));
    },
  });
  const completions: Promise<unknown>[] = [];
  controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias(memberHashId) {
      const completion = aliasController.persistMemberHashAlias(memberHashId);
      completions.push(completion);
      await completion;
    },
  });

  controller.updateStableUserIds(stableIds(stored));
  controller.scan(dom.window.document.body);
  frames.flush();
  await Promise.all(completions);
  await settleAliasWork();
  frames.flush();

  return {
    requestedMemberPaths,
    writes,
    stored,
    roots: Array.from(
      dom.window.document.querySelectorAll<HTMLElement>("div[data-id]"),
    ),
  };
}

test("BUG-011/AC-070 an approved main hash pair aliases and hides while text-only mention hashes never GET", async () => {
  const result = await runSemanticMainAliasScenario(1);

  deepStrictEqual(result.requestedMemberPaths, [
    `/api/v4/members/${MEMBER_HASH}`,
  ]);
  strictEqual(result.writes, 1);
  strictEqual(result.stored.authors[0]?.memberHashId, MEMBER_HASH);
  strictEqual(result.roots[0]?.classList.contains(COMMENT_HIDDEN_CLASS), true);
});

test("BUG-011/AC-070 repeated roots share one approved main alias request and storage write", async () => {
  const result = await runSemanticMainAliasScenario(2);

  deepStrictEqual(result.requestedMemberPaths, [
    `/api/v4/members/${MEMBER_HASH}`,
  ]);
  strictEqual(result.writes, 1);
  strictEqual(result.stored.authors[0]?.memberHashId, MEMBER_HASH);
  strictEqual(result.roots.length, 2);
  for (const root of result.roots) {
    strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  }
});

test("BUG-008/010 inline and modal direct matches never request an alias GET", () => {
  for (const containerClass of ["Comments-container", "Modal-content"]) {
    for (const [profileId, blockedId] of [
      ["canonical-token", "canonical-token"],
      [MEMBER_HASH, MEMBER_HASH],
    ] as const) {
      const dom = aliasCommentFixture(1, containerClass);
      const link = dom.window.document.querySelector<HTMLAnchorElement>("a[href]");
      const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
      if (!link || !root) throw new Error("Missing direct alias fixture.");
      link.href = `/people/${profileId}`;
      const frames = createFrames();
      let aliasRequests = 0;
      const controller = createCommentFilterController({
        schedule: frames.schedule,
        async resolveHistoricalAlias() {
          aliasRequests += 1;
        },
      });
      controller.updateStableUserIds(new Set([blockedId]));
      controller.scan(dom.window.document.body);
      frames.flush();
      strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
      strictEqual(aliasRequests, 0);
    }
  }
});

test("BUG-008/010 modal comment roots share one member GET and one atomic alias write", async () => {
  const dom = aliasCommentFixture(2, "Modal-content");
  const frames = createFrames();
  let stored = blockedAliasState();
  let fetches = 0;
  let writes = 0;
  const resolveMemberUserId = createMemberUserIdResolver(async (input, init) => {
    fetches += 1;
    strictEqual(input, `/api/v4/members/${MEMBER_HASH}`);
    deepStrictEqual(init, { credentials: "same-origin" });
    return {
      ok: true,
      async json() {
        return { url_token: "canonical-token" };
      },
    };
  });
  let controller: ReturnType<typeof createCommentFilterController>;
  const aliasController = createAuthorAliasPersistenceController({
    resolveMemberUserId,
    async withExclusiveLock(operation) {
      return operation();
    },
    async readState() {
      return parseBlacklistState(stored);
    },
    async writeState(state) {
      writes += 1;
      stored = state;
    },
    applyPersistedState(state) {
      controller.updateStableUserIds(stableIds(state));
    },
  });
  const completions: Promise<unknown>[] = [];
  controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias(memberHashId) {
      const completion = aliasController.persistMemberHashAlias(memberHashId);
      completions.push(completion);
      await completion;
    },
  });

  controller.updateStableUserIds(stableIds(stored));
  controller.scan(dom.window.document.body);
  frames.flush();
  await Promise.all(completions);
  await settleAliasWork();
  frames.flush();

  strictEqual(fetches, 1);
  strictEqual(writes, 1);
  strictEqual(stored.authors[0]?.memberHashId, MEMBER_HASH);
  for (const root of dom.window.document.querySelectorAll<HTMLElement>("div[data-id]")) {
    strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  }
});

test("BUG-008/010 modal alias failures keep comments visible", async () => {
  const scenarios = [
    { name: "API null", resolved: null, initial: blockedAliasState() },
    { name: "unknown token", resolved: "unknown-token", initial: blockedAliasState() },
    { name: "existing hash conflict", resolved: "canonical-token", initial: blockedAliasState(OTHER_HASH) },
    { name: "storage failure", resolved: "canonical-token", initial: blockedAliasState(), failWrite: true },
  ] as const;

  for (const scenario of scenarios) {
    const dom = aliasCommentFixture(1, "Modal-content");
    const frames = createFrames();
    let stored: BlacklistState = scenario.initial;
    let applies = 0;
    let controller: ReturnType<typeof createCommentFilterController>;
    const aliasController = createAuthorAliasPersistenceController({
      async resolveMemberUserId() {
        return scenario.resolved;
      },
      async withExclusiveLock(operation) {
        return operation();
      },
      async readState() {
        return parseBlacklistState(stored);
      },
      async writeState(state) {
        if ("failWrite" in scenario && scenario.failWrite) {
          throw new Error("write failed");
        }
        stored = state;
      },
      applyPersistedState(state) {
        applies += 1;
        controller.updateStableUserIds(stableIds(state));
      },
    });
    const completions: Promise<unknown>[] = [];
    controller = createCommentFilterController({
      schedule: frames.schedule,
      async resolveHistoricalAlias(memberHashId) {
        const completion = aliasController.persistMemberHashAlias(memberHashId);
        completions.push(completion);
        await completion;
      },
    });
    controller.updateStableUserIds(stableIds(stored));
    controller.scan(dom.window.document.body);
    frames.flush();
    await Promise.all(completions);
    await settleAliasWork();
    frames.flush();

    const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
    if (!root) throw new Error(`Missing ${scenario.name} fixture.`);
    strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false, scenario.name);
    strictEqual(applies, 0, scenario.name);
  }
});

test("BUG-008 detached roots and changed author links cannot be stale-hidden after alias success", async () => {
  for (const mutation of ["detach", "change-link"] as const) {
    const dom = aliasCommentFixture();
    const frames = createFrames();
    const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
    const link = root?.querySelector<HTMLAnchorElement>("a[href]");
    if (!root || !link) throw new Error("Missing stale alias fixture.");
    let release: (() => void) | undefined;
    const proof = new Promise<void>((resolve) => {
      release = resolve;
    });
    let badgeReports = 0;
    const controller = createCommentFilterController({
      schedule: frames.schedule,
      onFirstHidden() {
        badgeReports += 1;
      },
      async resolveHistoricalAlias() {
        await proof;
        controller.updateStableUserIds(new Set(["canonical-token", MEMBER_HASH]));
      },
    });
    controller.updateStableUserIds(new Set(["canonical-token"]));
    controller.scan(dom.window.document.body);
    frames.flush();

    if (mutation === "detach") {
      root.remove();
    } else {
      link.setAttribute("href", "/people/different-token");
    }
    release?.();
    await settleAliasWork();
    frames.flush();

    strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false, mutation);
    strictEqual(badgeReports, 0, mutation);
  }
});

test("BUG-008 an intervening runtime state remains authoritative after an unchanged alias attempt", async () => {
  const dom = aliasCommentFixture();
  const frames = createFrames();
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    async resolveHistoricalAlias() {
      await pending;
    },
  });
  controller.updateStableUserIds(new Set(["canonical-token"]));
  controller.scan(dom.window.document.body);
  frames.flush();

  controller.updateStableUserIds(new Set(["new-runtime-author"]));
  release?.();
  await settleAliasWork();
  frames.flush();

  const root = dom.window.document.querySelector<HTMLElement>("div[data-id]");
  if (!root) throw new Error("Missing intervening state fixture.");
  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), false);
});

test("BADGE-002/003 comments and replies count once per connected DOM root", () => {
  const dom = fixture();
  const frames = createFrames();
  let count = 0;
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    onFirstHidden() {
      count += 1;
    },
  });
  controller.updateStableUserIds(new Set(["blocked-top", "visible-reply"]));
  controller.scan(dom.window.document.body);
  controller.scan(dom.window.document.body);
  frames.flush();
  strictEqual(count, 2);

  controller.updateStableUserIds(new Set(["blocked-top", "visible-reply"]));
  frames.flush();
  strictEqual(count, 2);

  controller.updateStableUserIds(new Set());
  frames.flush();
  controller.updateStableUserIds(new Set(["blocked-top", "visible-reply"]));
  frames.flush();
  strictEqual(count, 2);

  const container = dom.window.document.querySelector<HTMLElement>(
    ".Comments-container",
  );
  if (!container) throw new Error("Missing badge comments container.");
  const newSameAuthorRoot = dom.window.document.createElement("div");
  newSameAuthorRoot.dataset.id = "new-same-author-root";
  newSameAuthorRoot.innerHTML = '<a href="/people/blocked-top">new root</a>';
  container.append(newSameAuthorRoot);
  controller.scan(newSameAuthorRoot);
  frames.flush();
  strictEqual(count, 3);
});

test("BADGE-002/003 preexisting hidden and detached comment roots do not count", () => {
  const dom = fixture();
  const frames = createFrames();
  let count = 0;
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    onFirstHidden() {
      count += 1;
    },
  });
  const preexisting = dom.window.document.querySelector<HTMLElement>(
    "#top-blocked",
  );
  const detached = dom.window.document.querySelector<HTMLElement>(
    "#reply-visible",
  );
  if (!preexisting || !detached) throw new Error("Missing badge fixtures.");
  preexisting.classList.add(COMMENT_HIDDEN_CLASS);

  controller.updateStableUserIds(new Set(["blocked-top", "visible-reply"]));
  controller.scan(dom.window.document.body);
  detached.remove();
  frames.flush();
  strictEqual(count, 0);

  controller.updateStableUserIds(new Set());
  frames.flush();
  controller.updateStableUserIds(new Set(["blocked-top"]));
  frames.flush();
  strictEqual(count, 0);
});

test("BADGE-006 callback failures do not enter comment fail-open handling", () => {
  const dom = fixture();
  const frames = createFrames();
  let attempts = 0;
  const controller = createCommentFilterController({
    schedule: frames.schedule,
    onFirstHidden() {
      attempts += 1;
      throw new Error("reporting failed");
    },
  });
  const root = dom.window.document.querySelector<HTMLElement>("#top-blocked");
  if (!root) throw new Error("Missing callback failure fixture.");

  controller.updateStableUserIds(new Set(["blocked-top"]));
  controller.scan(root);
  frames.flush();
  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(attempts, 1);

  controller.scan(root);
  frames.flush();
  strictEqual(root.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(attempts, 1);
});
