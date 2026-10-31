import type { CommitResult } from "../content/commit-controller.ts";
import type { SubmissionObservation } from "../content/drawer-controller.ts";
import type { VisibilityObservation } from "../plugins/zhihu/author-visibility.ts";
import { DIAGNOSTIC_CHANNEL, type DiagnosticRequest, type DiagnosticIncident } from "./contract.ts";
import { createDiagnosticRecorder, type DiagnosticInput } from "./recorder.ts";
import { geometry, observeDiagnosticDom } from "./dom-observer.ts";

interface SessionDependencies {
  now(): number;
  nextId(): string;
  send(request: DiagnosticRequest): Promise<unknown>;
  schedule(callback: () => void, milliseconds: number): () => void;
}

const sessions = new WeakMap<Document, DiagnosticSession>();
const HANDLE = "__cocoonDevDiagnostics";

class DiagnosticSession {
  private readonly recorder;
  private readonly document: Document;
  private readonly dependencies: SessionDependencies;
  private readonly nodes = new WeakMap<Element, number>();
  private readonly operations = new WeakMap<AbortSignal, { id: number; startedAt: number }>();
  private nextNode = 0;
  private nextOperation = 0;
  private active = false;
  private lifecycle = new AbortController();
  private observer: ReturnType<typeof observeDiagnosticDom> | null = null;
  private pendingIncident: DiagnosticIncident | null = null;
  private cancelCapture: (() => void) | null = null;
  private lastSave: boolean | null = null;

  readonly handle = {
    snapshot: () => ({ active: this.active, lastSave: this.lastSave, ...this.recorder.snapshot() }),
    save: () => this.saveManual(),
    clear: () => this.clear(),
  };

  constructor(document: Document, dependencies: SessionDependencies) {
    this.document = document;
    this.dependencies = dependencies;
    this.recorder = createDiagnosticRecorder({ ...dependencies, pageId: dependencies.nextId() });
  }

  start(): void {
    this.document.defaultView!.addEventListener("pagehide", this.pagehide);
    this.document.defaultView!.addEventListener("pageshow", this.pageshow);
    this.resume();
  }

  private resume(): void {
    if (this.active) return;
    this.active = true;
    this.lifecycle = new AbortController();
    this.record({ kind: "lifecycle", reason: "pageshow" });
    this.observer = observeDiagnosticDom(this.document, {
      record: (event) => this.record(event),
      candidate: () => this.capture(),
      nodeId: (element) => this.nodeId(element),
      schedule: (callback) => this.dependencies.schedule(callback, 200),
    });
    void this.request({ channel: DIAGNOSTIC_CHANNEL, operation: "prune" });
  }

  private readonly pageshow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.resume();
  };

  private readonly pagehide = (event: PageTransitionEvent): void => {
    this.record({ kind: "lifecycle", reason: "pagehide" });
    if (this.pendingIncident) this.finishCapture();
    this.active = false;
    this.observer?.stop();
    this.observer = null;
    this.cancelCapture?.();
    this.cancelCapture = null;
    this.lifecycle.abort();
    if (!event.persisted) {
      this.document.defaultView!.removeEventListener("pagehide", this.pagehide);
      this.document.defaultView!.removeEventListener("pageshow", this.pageshow);
    }
  };

  private nodeId(element: Element): number {
    if (!this.nodes.has(element)) this.nodes.set(element, ++this.nextNode);
    return this.nodes.get(element)!;
  }

  record(event: DiagnosticInput): void {
    if (!this.active) return;
    try {
      this.recorder.record(event);
    } catch {
      /* No diagnostic failure enters business callbacks. */
    }
  }

  submission(event: SubmissionObservation<HTMLElement, HTMLButtonElement>): void {
    if (event.phase === "start") {
      const operation = ++this.nextOperation;
      this.operations.set(event.signal, { id: operation, startedAt: this.dependencies.now() });
      const target = event.task.target;
      this.record({
        kind: "submit",
        operation,
        node: this.nodeId(target.card),
        authorName: target.authorNameAtClick.slice(0, 200),
        ...(target.profileUserIdAtClick ? { userId: target.profileUserIdAtClick } : {}),
        ...(target.memberHashIdAtClick ? { memberHashId: target.memberHashIdAtClick } : {}),
      });
      return;
    }
    const operation = this.operations.get(event.signal);
    const drawer = this.document.querySelector(".cocoon-tag-drawer");
    this.record({
      kind: "pending-end",
      ...(operation ? { operation: operation.id } : {}),
      reason: event.reason,
      durationMs: operation ? Math.max(0, this.dependencies.now() - operation.startedAt) : 0,
      ...(drawer ? geometry(drawer) : {}),
    });
    this.observer?.refresh();
  }

  operation(signal: AbortSignal, event: DiagnosticInput): void {
    const operation = this.operations.get(signal)?.id;
    this.record({ ...event, ...(operation === undefined ? {} : { operation }) });
    if (event.kind === "visibility-end") this.observer?.refresh();
  }

  private capture(): void {
    if (!this.active || this.pendingIncident) return;
    this.pendingIncident = this.recorder.incident("suspected-hover");
    void this.persist(this.pendingIncident);
    this.cancelCapture = this.dependencies.schedule(() => this.finishCapture(), 5_000);
  }

  private finishCapture(): void {
    this.cancelCapture?.();
    this.cancelCapture = null;
    const pending = this.pendingIncident;
    this.pendingIncident = null;
    if (!pending) return;
    const latest = this.recorder.incident("suspected-hover");
    void this.persist({ ...latest, id: pending.id });
  }

  private async persist(incident: DiagnosticIncident): Promise<boolean> {
    const result = await this.request({ channel: DIAGNOSTIC_CHANNEL, operation: "save", incident });
    this.lastSave = result;
    return result;
  }

  private async saveManual(): Promise<boolean> {
    if (!this.active) return false;
    return this.persist(this.recorder.incident("manual"));
  }

  private async clear(): Promise<boolean> {
    if (!this.active) return false;
    this.cancelCapture?.();
    this.cancelCapture = null;
    this.pendingIncident = null;
    const cleared = await this.request({ channel: DIAGNOSTIC_CHANNEL, operation: "clear" });
    if (cleared) this.recorder.clear();
    return cleared;
  }

  private async request(request: DiagnosticRequest): Promise<boolean> {
    if (!this.active) return false;
    const signal = this.lifecycle.signal;
    let interrupt = () => {};
    let cancelDeadline = () => {};
    const interrupted = new Promise<unknown>((resolve) => {
      interrupt = () => {
        cancelDeadline();
        resolve({ ok: false });
      };
    });
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      cancelDeadline = this.dependencies.schedule(interrupt, 2_000);
      const response = await Promise.race([this.dependencies.send(request), interrupted]);
      return (
        typeof response === "object" &&
        response !== null &&
        "ok" in response &&
        response.ok === true
      );
    } catch {
      return false;
    } finally {
      cancelDeadline();
      signal.removeEventListener("abort", interrupt);
    }
  }
}

function defaultDependencies(document: Document): SessionDependencies {
  const window = document.defaultView!;
  return {
    now: Date.now,
    nextId: () => crypto.randomUUID(),
    send: async (request) => chrome.runtime.sendMessage(request) as Promise<unknown>,
    schedule(callback, milliseconds) {
      const timer = window.setTimeout(callback, milliseconds);
      return () => window.clearTimeout(timer);
    },
  };
}

export function installDevDiagnostics(
  document: Document,
  dependencies = defaultDependencies(document),
) {
  try {
    const existing = sessions.get(document);
    if (existing) return existing.handle;
    const session = new DiagnosticSession(document, dependencies);
    sessions.set(document, session);
    // Content scripts run in the isolated world: no DOM/event bridge to page JavaScript.
    Reflect.set(document.defaultView!, HANDLE, session.handle);
    session.start();
    return session.handle;
  } catch {
    return null;
  }
}

export function recordDrawerObservation(
  document: Document,
  event: SubmissionObservation<HTMLElement, HTMLButtonElement>,
): void {
  try {
    sessions.get(document)?.submission(event);
  } catch {
    /* Best-effort observation only. */
  }
}

export function recordOperation(
  document: Document,
  signal: AbortSignal,
  event: DiagnosticInput,
): void {
  try {
    sessions.get(document)?.operation(signal, event);
  } catch {
    /* Best-effort observation only. */
  }
}

export function recordCommitReceipt(
  document: Document,
  signal: AbortSignal,
  result: CommitResult,
): void {
  recordOperation(document, signal, {
    kind: "receipt",
    reason: result.status,
    ...(result.status === "failed"
      ? {}
      : {
          userId: result.author.userId,
          authorName: result.author.authorNameAtCapture.slice(0, 200),
          ...(result.author.memberHashId ? { memberHashId: result.author.memberHashId } : {}),
        }),
  });
}

export function recordVisibility(
  document: Document,
  signal: AbortSignal,
  event: VisibilityObservation,
): void {
  const { phase, ...details } = event;
  recordOperation(document, signal, {
    kind: phase === "start" ? "visibility-start" : "visibility-end",
    ...details,
  });
}
