import type {
  VoterBatchObservation,
  VoterObservation,
  VoterPageObservation,
  VoterPageReason,
} from "../content/voter-observation.ts";

const PAGE_REASONS = {
  response: "收到响应",
  network: "网络失败",
  "rate-limit": "请求限流",
  authentication: "认证失败",
  http: "HTTP 失败",
  "invalid-response": "响应格式无效",
  "invalid-next": "下一页地址无效",
  "repeated-next": "下一页地址重复",
  "page-limit": "页数安全上限",
  "user-limit": "人数安全上限",
  stopped: "请求停止",
  end: "接口声明末页",
  next: "继续下一页",
} satisfies Record<VoterPageReason, string>;
const REASONS = {
  ...PAGE_REASONS,
  existing: "本地已存在",
  concurrent: "并发任务跳过",
  csrf: "CSRF 校验失败",
  storage: "单条持久化失败或无法确认",
  "storage-global": "全局存储/RPC 边界失败，底层原因未知",
  "exception-preparing": "准备阶段捕获异常",
  "exception-fetching": "获取阶段捕获异常",
  "exception-persisting": "保存阶段捕获异常",
};
const PHASES = { preparing: "准备身份", fetching: "获取分页", persisting: "保存用户" };
const OUTCOMES = {
  running: "结束状态未知（仍在运行或未收到结束事件），不能据此认定崩溃",
  complete: "已获取队列处理结束",
  partial: "已获取部分的队列处理结束，不代表全部点赞者处理完成",
  failed: "批次失败",
  stopped: "批次停止",
  exception: "捕获到未预期异常",
  pagehide: "页面离开，后续状态未知",
};

export interface VoterSummary {
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly operation: number | null;
  readonly displayedCount: null;
  readonly outcome: keyof typeof OUTCOMES;
  readonly phase: keyof typeof PHASES;
  readonly dataComplete: boolean | null;
  readonly rawRows: number;
  readonly rawRowsUnknown: number;
  readonly fetched: number;
  readonly unique: number;
  readonly invalid: number;
  readonly duplicates: number;
  readonly self: number;
  readonly direct: number;
  readonly eligible: number | null;
  readonly dispatched: number;
  readonly success: number;
  readonly existing: number;
  readonly concurrent: number;
  readonly failed: number;
  readonly stopped: number;
  readonly requestFailures: number;
  readonly reasons: readonly (keyof typeof REASONS)[];
}

export function createVoterSummary(startedAt: number, operation: number | null): VoterSummary {
  return {
    startedAt,
    updatedAt: startedAt,
    operation,
    displayedCount: null,
    outcome: "running",
    phase: "preparing",
    dataComplete: null,
    rawRows: 0,
    rawRowsUnknown: 0,
    fetched: 0,
    unique: 0,
    invalid: 0,
    duplicates: 0,
    self: 0,
    direct: 0,
    eligible: null,
    dispatched: 0,
    success: 0,
    existing: 0,
    concurrent: 0,
    failed: 0,
    stopped: 0,
    requestFailures: 0,
    reasons: [],
  };
}

function withReason(
  summary: VoterSummary,
  reason: keyof typeof REASONS | undefined | null,
): VoterSummary {
  if (!reason || summary.reasons.includes(reason)) return summary;
  return { ...summary, reasons: [...summary.reasons, reason] };
}

function updatePage(summary: VoterSummary, event: VoterPageObservation): VoterSummary {
  const next = withReason({ ...summary, phase: "fetching" }, event.reason);
  if (event.stage !== "end") return next;
  const invalid = event.invalid ?? 0;
  const duplicates = event.duplicates ?? 0;
  const added = event.added ?? 0;
  return {
    ...next,
    rawRows: next.rawRows + (event.rows ?? 0),
    rawRowsUnknown: next.rawRowsUnknown + (event.rows === undefined ? 1 : 0),
    fetched: next.fetched + invalid + duplicates + added,
    unique: Math.max(next.unique, event.unique ?? next.unique + added),
    invalid: next.invalid + invalid,
    duplicates: next.duplicates + duplicates,
  };
}

function updateResult(
  summary: VoterSummary,
  event: Extract<VoterBatchObservation, { kind: "result" }>,
): VoterSummary {
  const next = withReason(summary, event.reason);
  if (event.status !== "skipped") {
    return { ...next, [event.status]: next[event.status] + 1 };
  }
  if (event.reason === "existing" || event.reason === "concurrent") {
    return { ...next, [event.reason]: next[event.reason] + 1 };
  }
  // Unclassified skips remain a reconciliation gap, never invented existing records.
  return next;
}

type LifecycleObservation = Extract<
  VoterBatchObservation,
  {
    kind: "batch-start" | "preparation" | "finish" | "exception";
  }
>;

function updateLifecycle(summary: VoterSummary, event: LifecycleObservation): VoterSummary {
  switch (event.kind) {
    case "batch-start":
      return summary;
    case "preparation":
      return withReason(
        { ...summary, phase: event.status === "success" ? "fetching" : "preparing" },
        event.reason,
      );
    case "exception":
      return withReason({ ...summary, outcome: "exception" }, `exception-${event.stage}`);
    case "finish": {
      const phase = event.phase === "complete" && !event.dataComplete ? "partial" : event.phase;
      return {
        ...summary,
        dataComplete: event.dataComplete,
        outcome: summary.outcome === "running" ? phase : summary.outcome,
      };
    }
  }
}

export function updateVoterSummary(
  summary: VoterSummary,
  event: VoterObservation,
  at: number,
): VoterSummary {
  const next = { ...summary, updatedAt: at };
  switch (event.kind) {
    case "page":
      return updatePage(next, event);
    case "fetch":
      return withReason(
        {
          ...next,
          fetched: event.fetched,
          unique: event.unique,
          invalid: event.invalid,
          duplicates: event.duplicates,
          requestFailures: event.requestFailures,
          dataComplete: event.complete,
        },
        event.fatalReason,
      );
    case "queue":
      return {
        ...next,
        phase: "persisting",
        eligible: event.eligible,
        self: event.self,
        direct: event.direct,
      };
    case "dispatch":
      return { ...next, dispatched: next.dispatched + 1 };
    case "result":
      return updateResult(next, event);
    case "batch-start":
    case "preparation":
    case "finish":
    case "exception":
      return updateLifecycle(next, event);
  }
}

export function interruptVoterSummary(summary: VoterSummary, at: number): VoterSummary {
  if (summary.outcome !== "running") return summary;
  return { ...summary, updatedAt: at, outcome: "pagehide" };
}

function analyzeQueue(summary: VoterSummary): string[] {
  if (summary.eligible === null) return ["队列尚未确认，不能将唯一用户直接认定为待写入人数。"];
  const acknowledged =
    summary.success + summary.existing + summary.concurrent + summary.failed + summary.stopped;
  const inFlight = Math.max(0, summary.dispatched - acknowledged);
  const unprocessed = Math.max(0, summary.eligible - summary.dispatched);
  const lines = [
    `唯一用户 ${summary.unique}；排除本人 ${summary.self}、直接作者 ${summary.direct}；进入队列 ${summary.eligible}。`,
    `新增 ${summary.success}；已存在 ${summary.existing}；并发跳过 ${summary.concurrent}；失败/无法确认 ${summary.failed}；停止回执 ${summary.stopped}。`,
    `已派发 ${summary.dispatched}；尚未派发 ${unprocessed}；在途未确认 ${inFlight}。`,
  ];
  if (inFlight > 0)
    lines.push("在途未确认仅表示未收到回执，不能据此认定未写入。该人数也可能包含未分类回执。");
  const accounted = summary.self + summary.direct + acknowledged + inFlight + unprocessed;
  if (
    summary.unique !== accounted ||
    acknowledged > summary.dispatched ||
    summary.dispatched > summary.eligible
  ) {
    lines.push(`队列对账差额 ${summary.unique - accounted}；计数证据不一致，原因未知。`);
  }
  return lines;
}

export function analyzeVoterSummary(summary: VoterSummary): readonly string[] {
  const raw =
    summary.rawRowsUnknown > 0
      ? `已知原始条数 ${summary.rawRows}，另 ${summary.rawRowsUnknown} 页条数未知`
      : `原始条数 ${summary.rawRows}`;
  const difference =
    summary.rawRowsUnknown > 0 ? "差额未知" : `差额 ${summary.rawRows - summary.fetched}`;
  const lines = [
    OUTCOMES[summary.outcome],
    `最后观察阶段：${PHASES[summary.phase]}。`,
    "页面点赞数未知；页面数字不保证等于可枚举人数，不推断实际应获取人数。",
    `${raw}；解析条数 ${summary.fetched}；${difference}（可能为分页校验拒绝、上限截断或缺少页面证据，不能算作遗漏用户）。`,
    `解析条数 ${summary.fetched} = 唯一用户 ${summary.unique} + 无效 ${summary.invalid} + 重复 ${summary.duplicates}。`,
  ];
  if (summary.fetched !== summary.unique + summary.invalid + summary.duplicates) {
    lines.push("解析计数尚未对齐，差额原因未知。");
  }
  if (summary.dataComplete === false) lines.push("已获取部分；保存结束不代表点赞者列表完整。");
  if (summary.dataComplete === null) lines.push("获取完整性未知。");
  lines.push(...analyzeQueue(summary));
  if (summary.requestFailures > 0) lines.push(`获取请求失败 ${summary.requestFailures} 次。`);
  if (summary.reasons.length > 0)
    lines.push(`已观察类别：${summary.reasons.map((reason) => REASONS[reason]).join("；")}。`);
  return lines;
}

type Validator = (input: unknown) => boolean;
const count: Validator = (input) =>
  typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
const boolean: Validator = (input) => typeof input === "boolean";
const nullableCount: Validator = (input) => input === null || count(input);

function member(input: unknown, values: object): boolean {
  return typeof input === "string" && Object.hasOwn(values, input);
}

function reasonList(input: unknown): boolean {
  return (
    Array.isArray(input) &&
    input.length <= Object.keys(REASONS).length &&
    Reflect.ownKeys(input).length === input.length + 1 &&
    [...input].every((reason: unknown) => member(reason, REASONS)) &&
    new Set(input).size === input.length
  );
}

const SUMMARY_FIELDS: Record<string, Validator> = {
  rawRows: count,
  rawRowsUnknown: count,
  fetched: count,
  unique: count,
  invalid: count,
  duplicates: count,
  self: count,
  direct: count,
  dispatched: count,
  success: count,
  existing: count,
  concurrent: count,
  failed: count,
  stopped: count,
  requestFailures: count,
  startedAt: count,
  updatedAt: count,
  operation: nullableCount,
  displayedCount: (input) => input === null,
  outcome: (input) => member(input, OUTCOMES),
  phase: (input) => member(input, PHASES),
  dataComplete: (input) => input === null || boolean(input),
  eligible: nullableCount,
  reasons: reasonList,
};
const PAGE_FIELDS: Record<string, Validator> = {
  kind: (input) => input === "page",
  order: (input) => input === "default" || input === "newest",
  page: count,
  stage: (input) => input === "start" || input === "attempt" || input === "end",
  attempt: count,
  durationMs: (input) =>
    typeof input === "number" &&
    Number.isFinite(input) &&
    input >= 0 &&
    input <= Number.MAX_SAFE_INTEGER,
  status: (input) => count(input) && Number(input) >= 100 && Number(input) <= 599,
  reason: (input) => member(input, PAGE_REASONS),
  rows: count,
  invalid: count,
  duplicates: count,
  added: count,
  unique: count,
  isEnd: boolean,
  hasNext: boolean,
};

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function parseFields(
  input: unknown,
  fields: Readonly<Record<string, Validator>>,
  required: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(input)) return null;
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !Object.hasOwn(fields, key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || !fields[key](descriptor.value))
      return null;
    output[key] = descriptor.value;
  }
  return required.every((key) => Object.hasOwn(output, key)) ? output : null;
}

export function parseVoterSummary(input: unknown): VoterSummary | null {
  const parsed = parseFields(input, SUMMARY_FIELDS, Object.keys(SUMMARY_FIELDS));
  if (!parsed) return null;
  return {
    ...parsed,
    reasons: [...(parsed.reasons as VoterSummary["reasons"])],
  } as unknown as VoterSummary;
}

export function parseVoterPageObservation(input: unknown): VoterPageObservation | null {
  return parseFields(input, PAGE_FIELDS, [
    "kind",
    "order",
    "page",
    "stage",
  ]) as unknown as VoterPageObservation | null;
}
