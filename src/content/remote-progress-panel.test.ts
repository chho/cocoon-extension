import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  createRemoteProgressSession,
  formatVoterProgress,
} from "./remote-progress-panel.ts";

test("VOTER-003/008 progress reports actual totals and complete/partial status", () => {
  strictEqual(
    formatVoterProgress({
      phase: "complete",
      fetched: 12,
      success: 5,
      failed: 2,
      skipped: 4,
      unprocessed: 1,
      dataComplete: false,
    }),
    "点赞者：已获取 12 · 成功 5 · 失败 2 · 跳过 4 · 未处理 1 · 部分",
  );
  strictEqual(
    formatVoterProgress({
      phase: "complete",
      fetched: 3,
      success: 3,
      failed: 0,
      skipped: 0,
      unprocessed: 0,
      dataComplete: true,
    }).endsWith("· 完整"),
    true,
  );
});

test("VOTER-003 UI shows unique valid voters as fetched and raw invalid/duplicates as skipped", () => {
  strictEqual(
    formatVoterProgress({
      phase: "complete",
      fetched: 3,
      success: 3,
      failed: 0,
      skipped: 2,
      unprocessed: 0,
      dataComplete: true,
    }),
    "点赞者：已获取 3 · 成功 3 · 失败 0 · 跳过 2 · 未处理 0 · 完整",
  );
});

test("VOTER-008 progress UI exposes live statistics and stops exactly once", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  let stops = 0;
  const session = createRemoteProgressSession(dom.window.document, {
    showAuthor: false,
    showVoters: true,
    stop() {
      stops += 1;
    },
  });
  session.updateVoters({
    phase: "blocking",
    fetched: 9,
    success: 2,
    failed: 1,
    skipped: 3,
    unprocessed: 3,
    dataComplete: false,
  });

  const liveRegion = dom.window.document.querySelector<HTMLElement>(
    ".cocoon-remote-progress-body",
  );
  const statistics = dom.window.document.querySelector<HTMLElement>(
    ".cocoon-remote-progress-voters",
  );
  const stopButton = dom.window.document.querySelector<HTMLButtonElement>(
    ".cocoon-remote-progress-stop",
  );
  if (!liveRegion || !statistics || !stopButton) {
    throw new Error("Missing progress UI controls.");
  }

  strictEqual(liveRegion.getAttribute("aria-live"), "polite");
  strictEqual(statistics.hidden, false);
  strictEqual(
    statistics.textContent,
    "点赞者：已获取 9 · 成功 2 · 失败 1 · 跳过 3 · 未处理 3 · 部分",
  );
  strictEqual(stopButton.textContent, "停止");

  stopButton.click();
  stopButton.click();

  strictEqual(stops, 1);
  strictEqual(stopButton.disabled, true);
  strictEqual(stopButton.textContent, "停止中");
});
