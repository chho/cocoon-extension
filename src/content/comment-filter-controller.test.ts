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
const ALIAS_TIMESTAMP = "2026-08-14T12:00:00.000Z";

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
    const controller = createCommentFilterController({
      schedule: frames.schedule,
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
