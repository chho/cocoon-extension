import { deepStrictEqual, match, strictEqual } from "node:assert";
import { test } from "node:test";
import type { VoterObservation, VoterPageObservation } from "../content/voter-observation.ts";
import {
  analyzeVoterSummary,
  createVoterSummary,
  interruptVoterSummary,
  parseVoterPageObservation,
  parseVoterSummary,
  updateVoterSummary,
} from "./voter-summary.ts";

function summarize(events: readonly VoterObservation[]) {
  return events.reduce(
    (summary, event, index) => updateVoterSummary(summary, event, index + 11),
    createVoterSummary(10, 7),
  );
}

test("DIAG-004 unknown response row counts cannot be presented as an exact zero difference", () => {
  const summary = summarize([
    { kind: "page", order: "default", page: 1, stage: "end", reason: "invalid-response" },
  ]);
  strictEqual(summary.rawRowsUnknown, 1);
  match(analyzeVoterSummary(summary).join("\n"), /条数未知/);
  match(analyzeVoterSummary(summary).join("\n"), /差额未知/);
});

function fetched(unique: number, complete = true): VoterObservation {
  return {
    kind: "fetch",
    fetched: unique,
    unique,
    invalid: 0,
    duplicates: 0,
    complete,
    requestFailures: 0,
    fatalReason: null,
  };
}

const page: VoterPageObservation = {
  kind: "page",
  order: "default",
  page: 1,
  stage: "end",
  attempt: 1,
  durationMs: 1.5,
  status: 200,
  reason: "end",
  rows: 50,
  invalid: 2,
  duplicates: 3,
  added: 45,
  unique: 45,
  isEnd: true,
  hasNext: false,
};

test("DIAG-004 explains 120 unique voters with 20 added and 100 existing", () => {
  const events: VoterObservation[] = [
    fetched(120),
    { kind: "queue", eligible: 120, self: 0, direct: 0 },
  ];
  for (let index = 0; index < 120; index++) {
    events.push(
      { kind: "dispatch" },
      index < 20
        ? { kind: "result", status: "success" }
        : { kind: "result", status: "skipped", reason: "existing" },
    );
  }
  events.push({ kind: "finish", phase: "complete", dataComplete: true });
  const summary = summarize(events);
  strictEqual(summary.success, 20);
  strictEqual(summary.existing, 100);
  strictEqual(summary.outcome, "complete");
  strictEqual(summary.displayedCount, null);
  match(analyzeVoterSummary(summary).join("\n"), /新增 20.*已存在 100/);
  match(analyzeVoterSummary(summary).join("\n"), /尚未派发 0.*在途未确认 0/);
  deepStrictEqual(parseVoterSummary(summary), summary);
});

test("DIAG-004 overlapping page counts are replaced, not re-added, by fetch aggregate", () => {
  const initial = createVoterSummary(10, null);
  const first = updateVoterSummary(initial, page, 11);
  strictEqual(initial.rawRows, 0);
  const second = updateVoterSummary(
    first,
    {
      ...page,
      order: "newest",
      invalid: 0,
      duplicates: 40,
      added: 10,
      unique: 55,
    },
    12,
  );
  strictEqual(second.rawRows, 100);
  strictEqual(second.fetched, 100);
  strictEqual(second.unique, 55);
  strictEqual(second.duplicates, 43);
  const result = updateVoterSummary(
    second,
    {
      kind: "fetch",
      fetched: 100,
      unique: 55,
      invalid: 2,
      duplicates: 43,
      complete: true,
      requestFailures: 0,
      fatalReason: null,
    },
    13,
  );
  strictEqual(result.fetched, 100);
  strictEqual(result.invalid, 2);
  strictEqual(result.duplicates, 43);
  deepStrictEqual(result.reasons, ["end"]);
});

test("DIAG-004 caps preserve raw rows separately and never claim all voters completed", () => {
  const summary = summarize([
    { ...page, rows: 50, invalid: 0, duplicates: 0, added: 20, unique: 20, reason: "user-limit" },
    fetched(20, false),
    { kind: "queue", eligible: 20, self: 0, direct: 0 },
    { kind: "finish", phase: "complete", dataComplete: false },
  ]);
  strictEqual(summary.rawRows, 50);
  strictEqual(summary.fetched, 20);
  strictEqual(summary.outcome, "partial");
  const analysis = analyzeVoterSummary(summary).join("\n");
  match(analysis, /原始条数 50.*解析条数 20.*差额 30/);
  match(analysis, /已获取部分/);
  match(analysis, /人数安全上限/);
  match(analysis, /页面点赞数未知/);
});

test("DIAG-004 queue evidence separates filters, failures, stopped, queued and in-flight", () => {
  const beforeQueue = summarize([fetched(10)]);
  strictEqual(beforeQueue.eligible, null);
  match(analyzeVoterSummary(beforeQueue).join("\n"), /队列尚未确认/);
  const summary = summarize([
    fetched(10),
    { kind: "queue", eligible: 8, self: 1, direct: 1 },
    ...Array.from({ length: 5 }, (): VoterObservation => ({ kind: "dispatch" })),
    { kind: "result", status: "success" },
    { kind: "result", status: "skipped", reason: "concurrent" },
    { kind: "result", status: "failed", reason: "storage-global" },
    { kind: "result", status: "stopped" },
  ]);
  const analysis = analyzeVoterSummary(summary).join("\n");
  match(analysis, /本人 1.*直接作者 1/);
  match(analysis, /并发跳过 1.*失败.*1.*停止回执 1/);
  match(analysis, /尚未派发 3.*在途未确认 1/);
  match(analysis, /结束状态未知/);
  match(analysis, /不能据此认定未写入/);
  strictEqual(summary.outcome, "running");
});

test("DIAG-004 pagehide only terminates running summaries and late results retain exception", () => {
  const running = summarize([
    fetched(2),
    { kind: "queue", eligible: 2, self: 0, direct: 0 },
    { kind: "dispatch" },
    { kind: "dispatch" },
  ]);
  const hidden = interruptVoterSummary(running, 20);
  strictEqual(hidden.outcome, "pagehide");
  match(analyzeVoterSummary(hidden).join("\n"), /在途未确认 2/);
  const exception = updateVoterSummary(running, { kind: "exception", stage: "persisting" }, 20);
  const late = updateVoterSummary(exception, { kind: "result", status: "success" }, 21);
  strictEqual(late.success, 1);
  strictEqual(late.outcome, "exception");
  deepStrictEqual(late.reasons, ["exception-persisting"]);
  strictEqual(interruptVoterSummary(late, 22).outcome, "exception");
  const finished = summarize([{ kind: "finish", phase: "stopped", dataComplete: false }]);
  strictEqual(interruptVoterSummary(finished, 20).outcome, "stopped");
});

test("DIAG-004 reasons preserve request and result categories without raw errors", () => {
  const summary = summarize([
    { kind: "preparation", status: "failed", reason: "authentication" },
    { ...page, stage: "attempt", reason: "network" },
    { ...page, stage: "attempt", reason: "network" },
    { ...page, reason: "invalid-next" },
    { kind: "result", status: "failed", reason: "csrf" },
    { kind: "finish", phase: "failed", dataComplete: false },
  ]);
  strictEqual(summary.rawRows, 50);
  strictEqual(summary.outcome, "failed");
  deepStrictEqual(summary.reasons, ["authentication", "network", "invalid-next", "csrf"]);
  match(analyzeVoterSummary(summary).join("\n"), /认证.*网络.*下一页.*CSRF/);
});

test("DIAG-004 summary parser rejects extra/private keys, unsafe counts and invalid reasons", () => {
  const valid = createVoterSummary(10, 7);
  deepStrictEqual(parseVoterSummary(valid), valid);
  const missing: Record<string, unknown> = { ...valid };
  delete missing.outcome;
  for (const input of [
    missing,
    null,
    [],
    { ...valid, name: "private" },
    { ...valid, userId: "private" },
    { ...valid, url: "https://example.test/private" },
    { ...valid, error: "private" },
    { ...valid, rawRows: -1 },
    { ...valid, failed: 0.5 },
    { ...valid, unique: Infinity },
    { ...valid, dispatched: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, operation: "7" },
    { ...valid, outcome: "crashed" },
    { ...valid, dataComplete: "yes" },
    { ...valid, displayedCount: 100 },
    { ...valid, reasons: ["secret"] },
    { ...valid, reasons: Array.from({ length: 100 }, () => "network") },
    { ...valid, reasons: ["network", "network"] },
    { ...valid, reasons: new Array(1) },
    { ...valid, reasons: Object.assign(["network"], { name: "private" }) },
    { ...valid, eligible: undefined },
  ])
    strictEqual(parseVoterSummary(input), null);
});

test("DIAG-004 page parser accepts bounded metadata and rejects unknown fields/enums", () => {
  deepStrictEqual(parseVoterPageObservation(page), page);
  deepStrictEqual(
    parseVoterPageObservation({ kind: "page", page: 0, order: "newest", stage: "start" }),
    { kind: "page", page: 0, order: "newest", stage: "start" },
  );
  for (const input of [
    null,
    [],
    { ...page, rows: -1 },
    { ...page, added: Number.MAX_SAFE_INTEGER + 1 },
    { ...page, status: 999 },
    { ...page, durationMs: Infinity },
    { ...page, attempt: 1.5 },
    { ...page, reason: "exception-fetching" },
    { ...page, reason: "x".repeat(1000) },
    { ...page, order: "private" },
    { ...page, stage: "error" },
    { ...page, hasNext: "true" },
    { ...page, reason: undefined },
    { ...page, authorName: "private" },
    { ...page, url: "https://example.test/private" },
    { ...page, error: "private" },
  ])
    strictEqual(parseVoterPageObservation(input), null);
});
