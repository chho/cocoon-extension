import type { VoterObserver } from "../content/voter-observation.ts";
import {
  MAX_EVENTS,
  MAX_INCIDENTS,
  parseDiagnosticIncident,
  type DiagnosticIncident,
  type DiagnosticRequest,
} from "./contract.ts";
import { boundIncident, createDiagnosticRecorder, type DiagnosticRecorder } from "./recorder.ts";
import {
  createVoterSummary,
  updateVoterSummary,
  interruptVoterSummary,
  analyzeVoterSummary,
  type VoterSummary,
} from "./voter-summary.ts";

interface Dependencies {
  pageId: string;
  now(): number;
  nextId(): string;
  schedule(callback: () => void, milliseconds: number): () => void;
  // The owning diagnostic session supplies its bounded, lifecycle-aware request channel.
  request(request: DiagnosticRequest): Promise<boolean>;
}
interface Batch {
  id: string;
  summary: VoterSummary;
  recorder: DiagnosticRecorder;
  sequence: number;
  listening: boolean;
  pending: boolean;
  saving: boolean;
  lastSave: boolean | null;
  cancelCheckpoint: (() => void) | null;
}

class VoterDiagnostics {
  private readonly dependencies: Dependencies;
  private batches: Batch[] = [];
  private dropped = 0;
  private active = true;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  start(operation: number | null): VoterObserver {
    if (!this.active) return () => {};
    const batch: Batch = {
      id: this.dependencies.nextId(),
      summary: createVoterSummary(this.dependencies.now(), operation),
      recorder: createDiagnosticRecorder(this.dependencies),
      sequence: 1,
      listening: true,
      pending: false,
      saving: false,
      lastSave: null,
      cancelCheckpoint: null,
    };
    this.batches.push(batch);
    if (this.batches.length > MAX_INCIDENTS) {
      this.retire(this.batches.shift()!);
      this.dropped++;
    }
    this.save(batch);
    return (event) => {
      if (!this.active || !batch.listening) return;
      try {
        batch.summary = updateVoterSummary(batch.summary, event, this.dependencies.now());
        batch.sequence++;
        if (event.kind === "page") batch.recorder.record({ kind: "voter-page", voter: event });
        if (event.kind === "finish" || event.kind === "exception") {
          batch.cancelCheckpoint?.();
          batch.cancelCheckpoint = null;
          this.save(batch);
        } else if (!batch.cancelCheckpoint) {
          batch.cancelCheckpoint = this.dependencies.schedule(() => {
            batch.cancelCheckpoint = null;
            this.save(batch);
          }, 5_000);
        }
      } catch {
        /* Observation errors cannot own a voter operation. */
      }
    };
  }

  private incident(batch: Batch): DiagnosticIncident {
    const captured = batch.recorder.snapshot();
    const pages = captured.events.slice(-(MAX_EVENTS - 1));
    return boundIncident({
      schemaVersion: 1,
      pageId: this.dependencies.pageId,
      id: batch.id,
      savedAt: this.dependencies.now(),
      reason: "voter-batch",
      sequence: batch.sequence,
      truncated: captured.truncated + captured.events.length - pages.length,
      events: [
        ...pages,
        { at: batch.summary.updatedAt, kind: "voter-summary", voter: batch.summary },
      ],
    });
  }

  private async persist(batch: Batch): Promise<void> {
    try {
      batch.lastSave = await this.dependencies.request({
        channel: "cocoon-dev-diagnostics",
        operation: "save",
        incident: this.incident(batch),
      });
    } catch {
      batch.lastSave = false;
    }
  }

  private save(batch: Batch): void {
    batch.pending = true;
    if (batch.saving) return;
    batch.saving = true;
    void this.drain(batch);
  }

  private async drain(batch: Batch): Promise<void> {
    try {
      while (batch.pending && this.active && batch.listening) {
        batch.pending = false;
        await this.persist(batch);
      }
    } finally {
      batch.saving = false;
    }
  }

  private retire(batch: Batch): void {
    batch.listening = false;
    batch.pending = false;
    batch.cancelCheckpoint?.();
    batch.cancelCheckpoint = null;
  }

  snapshot() {
    return {
      dropped: this.dropped,
      batches: this.batches.map((batch) => ({
        incident: this.incident(batch),
        analysis: analyzeVoterSummary(batch.summary),
        lastSave: batch.lastSave,
      })),
    };
  }

  pause(): void {
    if (!this.active) return;
    for (const batch of this.batches) {
      const needsSave =
        batch.summary.outcome === "running" || batch.cancelCheckpoint !== null || batch.pending;
      if (batch.summary.outcome === "running") {
        batch.summary = interruptVoterSummary(batch.summary, this.dependencies.now());
        batch.sequence++;
      }
      // The page may disappear immediately: this is best effort, never a flush guarantee.
      if (needsSave) void this.persist(batch);
      this.retire(batch);
    }
    this.active = false;
  }

  resume(): void {
    this.active = true;
  }

  clear(): void {
    for (const batch of this.batches) this.retire(batch);
    this.batches = [];
    this.dropped = 0;
  }
}

export function analyzeSavedVoterBatch(input: unknown): readonly string[] | null {
  const incident = parseDiagnosticIncident(input);
  if (incident?.reason !== "voter-batch") return null;
  const summary = incident.events.at(-1)?.voter;
  return summary && "outcome" in summary ? analyzeVoterSummary(summary) : null;
}

export function createVoterDiagnostics(dependencies: Dependencies) {
  return new VoterDiagnostics(dependencies);
}
