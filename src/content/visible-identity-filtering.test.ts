import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createCardFilterController } from "./card-filter-controller.ts";
import {
  COMMENT_HIDDEN_CLASS,
  createCommentFilterController,
} from "./comment-filter-controller.ts";
import type { IdentityMatchStatus } from "./identity-batch-matcher.ts";

function frames() {
  const pending: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      pending.push(callback);
    },
    async flush() {
      while (pending.length > 0) {
        pending.shift()?.();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      }
    },
  };
}

interface CardFixture {
  identifiers: ReadonlySet<string>;
  hidden: boolean;
}

test("BUG-016 existing and dynamic cards query only parsed identities and fail open", async () => {
  const raf = frames();
  const queried: string[][] = [];
  let fail = false;
  const controller = createCardFilterController<CardFixture>({
    prepareCard() {},
    resolveStableIdentifiers(card: CardFixture) {
      return card.identifiers;
    },
    async matchStableIdentifiers(identifiers: ReadonlySet<string>) {
      queried.push([...identifiers]);
      if (fail) return "unavailable" as IdentityMatchStatus;
      return identifiers.has("blocked") ? "matched" : "unmatched";
    },
    async resolveHistoricalAlias() {
      return { status: "failed" as const };
    },
    setHidden(card: CardFixture, hidden: boolean) {
      card.hidden = hidden;
    },
    reportFailure() {},
    schedule: raf.schedule,
  } as unknown as Parameters<typeof createCardFilterController<CardFixture>>[0]);

  const existing = { identifiers: new Set(["blocked"]), hidden: false };
  controller.enqueue(existing);
  await raf.flush();
  strictEqual(existing.hidden, true);

  const dynamic = { identifiers: new Set(["visible"]), hidden: false };
  controller.enqueue(dynamic);
  await raf.flush();
  strictEqual(dynamic.hidden, false);

  fail = true;
  existing.identifiers = new Set(["query-failure"]);
  controller.enqueue(existing);
  await raf.flush();
  strictEqual(existing.hidden, false);
  strictEqual(
    queried.some((batch) => batch.includes("query-failure")),
    true,
  );
});

test("BUG-016 comments keep nested-root semantics, alias immediately rechecks, and Badge counts once", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="Comments-container">
      <div data-id="top" id="top"><a href="/people/${"a".repeat(32)}">author</a>
        <div data-id="reply" id="reply"><a href="/people/visible">reply</a></div>
      </div>
    </div>
  </body>`);
  const raf = frames();
  const matched = new Set<string>();
  let aliasCalls = 0;
  let badgeCount = 0;
  const controller = createCommentFilterController({
    schedule: raf.schedule,
    async matchStableIdentifiers(identifiers: ReadonlySet<string>) {
      return [...identifiers].some((identifier) => matched.has(identifier))
        ? "matched"
        : "unmatched";
    },
    async resolveHistoricalAlias(memberHashId: string) {
      aliasCalls += 1;
      matched.add(memberHashId);
      return { status: "persisted" as const };
    },
    onFirstHidden() {
      badgeCount += 1;
    },
  } as unknown as Parameters<typeof createCommentFilterController>[0]);

  controller.scan(dom.window.document.body);
  await raf.flush();
  const top = dom.window.document.querySelector<HTMLElement>("#top");
  const reply = dom.window.document.querySelector<HTMLElement>("#reply");
  if (!top || !reply) throw new Error("Missing comments.");
  strictEqual(aliasCalls, 1);
  strictEqual(top.classList.contains(COMMENT_HIDDEN_CLASS), true);
  strictEqual(reply.classList.contains(COMMENT_HIDDEN_CLASS), false);
  strictEqual(badgeCount, 1);

  controller.scan(top);
  await raf.flush();
  strictEqual(badgeCount, 1);
});
