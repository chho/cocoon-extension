import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import type { BlacklistAuthorDto } from "../core/blacklist-rpc-contract.ts";
import type { AuthorListItem } from "../ui/blacklist-list-values.ts";
import { focusPopupSearch, renderPopupRecordList } from "./record-list-view.ts";
import { POPUP_UNDO_DURATION_MS, createPopupUndoController } from "./undo-controller.ts";

const INTERNAL_USER_ID = "private-user-token";
const INTERNAL_HASH = "b".repeat(32);
const INTERNAL_TAG_ID = "private-tag-token";

function record(
  userId = INTERNAL_USER_ID,
  source: BlacklistAuthorDto["source"] = "direct",
): BlacklistAuthorDto {
  return {
    platformId: "zhihu",
    userId,
    memberHashId: INTERNAL_HASH,
    authorName: "Visible Author",
    tagId: INTERNAL_TAG_ID,
    blacklistedAt: "2026-08-21T10:00:00.000Z",
    source,
  };
}

class FakeScheduler {
  nextId = 1;
  readonly scheduled = new Map<number, { callback: () => void; delay: number }>();
  readonly cancelled: number[] = [];

  schedule = (callback: () => void, delay: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { callback, delay });
    return id;
  };

  cancel = (id: number): void => {
    this.cancelled.push(id);
  };

  fire(id: number): void {
    this.scheduled.get(id)?.callback();
  }
}

function createHarness() {
  const scheduler = new FakeScheduler();
  let expirations = 0;
  const controller = createPopupUndoController(scheduler.schedule, scheduler.cancel, () => {
    expirations += 1;
  });
  return { scheduler, controller, expirations: () => expirations };
}

test("POPUP-005 undo schedules the opportunity for exactly eight seconds", () => {
  const harness = createHarness();
  const author = record();
  harness.controller.start(author);
  const pending = harness.scheduler.scheduled.get(1);
  strictEqual(POPUP_UNDO_DURATION_MS, 8_000);
  strictEqual(pending?.delay, 8_000);
  strictEqual(harness.controller.current(), author);

  harness.scheduler.fire(1);
  strictEqual(harness.controller.current(), null);
  strictEqual(harness.expirations(), 1);
});

test("POPUP-005 a new removal supersedes the prior timer and stale callbacks are inert", () => {
  const harness = createHarness();
  const first = record("first");
  const second = record("second");
  harness.controller.start(first);
  harness.controller.start(second);
  deepStrictEqual(harness.scheduler.cancelled, [1]);
  strictEqual(harness.controller.current(), second);

  harness.scheduler.fire(1);
  strictEqual(harness.controller.current(), second);
  strictEqual(harness.expirations(), 0);
  harness.scheduler.fire(2);
  strictEqual(harness.controller.current(), null);
  strictEqual(harness.expirations(), 1);
});

test("POPUP-005 clear and Popup disposal cancel pending undo without expiry", () => {
  const clearHarness = createHarness();
  clearHarness.controller.start(record("clear"));
  clearHarness.controller.clear();
  strictEqual(clearHarness.controller.current(), null);
  deepStrictEqual(clearHarness.scheduler.cancelled, [1]);
  clearHarness.scheduler.fire(1);
  strictEqual(clearHarness.expirations(), 0);

  const disposeHarness = createHarness();
  disposeHarness.controller.start(record("dispose"));
  disposeHarness.controller.dispose();
  strictEqual(disposeHarness.controller.current(), null);
  deepStrictEqual(disposeHarness.scheduler.cancelled, [1]);
  disposeHarness.scheduler.fire(1);
  strictEqual(disposeHarness.expirations(), 0);
});

test("POPUP-005 failed restore attempts keep the exact pending record coherent", () => {
  const harness = createHarness();
  const author = record("failed-restore", "upvoter");
  harness.controller.start(author);

  // Production only calls take() after a successful RPC response.
  strictEqual(harness.controller.current(), author);
  deepStrictEqual(harness.scheduler.cancelled, []);
  const restoredAfterRetry = harness.controller.take();
  strictEqual(restoredAfterRetry, author);
  strictEqual(harness.controller.current(), null);
  deepStrictEqual(harness.scheduler.cancelled, [1]);
});

test("PROFILE-001/AC-086 record rendering links author names to encoded Zhihu profiles", () => {
  const dom = new JSDOM("<input id='search'><ul id='records'></ul>");
  const document = dom.window.document;
  const list = document.querySelector<HTMLUListElement>("#records");
  const search = document.querySelector<HTMLInputElement>("#search");
  if (!list || !search) {
    throw new Error("test fixture is incomplete");
  }
  const author = record();
  const item: AuthorListItem = {
    author,
    tag: { tagId: INTERNAL_TAG_ID, name: "Reading", isDefault: false },
  };
  let removed: BlacklistAuthorDto | null = null;
  renderPopupRecordList({
    list,
    items: [item],
    queryActive: false,
    writesEnabled: true,
    onRemove(value) {
      removed = value;
    },
  });

  const text = list.textContent ?? "";
  strictEqual(text.includes("Visible Author"), true);
  strictEqual(text.includes("Reading"), true);
  strictEqual(text.includes("手动屏蔽"), true);
  strictEqual(text.includes("解除屏蔽"), true);
  const profile = list.querySelector<HTMLAnchorElement>("a.author-name");
  strictEqual(profile?.textContent, "Visible Author");
  strictEqual(profile?.href, `https://www.zhihu.com/people/${INTERNAL_USER_ID}`);
  strictEqual(profile?.target, "_blank");
  strictEqual(profile?.rel, "noopener");
  const button = list.querySelector<HTMLButtonElement>("button");
  strictEqual(button?.getAttribute("aria-label"), "解除屏蔽 Visible Author");
  button?.click();
  strictEqual(removed, author);

  focusPopupSearch(search);
  strictEqual(document.activeElement, search);
});

test("POPUP-009 malformed/unreadable state can render records read-only", () => {
  const dom = new JSDOM("<ul id='records'></ul>");
  const list = dom.window.document.querySelector<HTMLUListElement>("#records");
  if (!list) {
    throw new Error("test fixture is incomplete");
  }
  renderPopupRecordList({
    list,
    items: [
      {
        author: record(),
        tag: { tagId: INTERNAL_TAG_ID, name: "Reading", isDefault: false },
      },
    ],
    queryActive: false,
    writesEnabled: false,
    onRemove() {
      throw new Error("disabled write action must not run");
    },
  });
  strictEqual(list.querySelector<HTMLButtonElement>("button")?.disabled, true);
});

test("POPUP-004 record rendering distinguishes recent and search empty states", () => {
  const dom = new JSDOM("<ul id='records'></ul>");
  const list = dom.window.document.querySelector<HTMLUListElement>("#records");
  if (!list) {
    throw new Error("test fixture is incomplete");
  }
  const base = {
    list,
    items: [],
    writesEnabled: true,
    onRemove() {},
  } as const;
  renderPopupRecordList({ ...base, queryActive: false });
  strictEqual(list.textContent, "暂无最近屏蔽记录");
  renderPopupRecordList({ ...base, queryActive: true });
  strictEqual(list.textContent, "没有匹配的本地记录");
});
