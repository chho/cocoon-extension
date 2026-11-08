export type VoterPageReason =
  | "response"
  | "network"
  | "rate-limit"
  | "authentication"
  | "http"
  | "invalid-response"
  | "invalid-next"
  | "repeated-next"
  | "page-limit"
  | "user-limit"
  | "stopped"
  | "end"
  | "next";

export interface VoterPageObservation {
  readonly kind: "page";
  readonly order: "default" | "newest";
  readonly page: number;
  readonly stage: "start" | "attempt" | "end";
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly status?: number;
  readonly reason?: VoterPageReason;
  readonly rows?: number;
  readonly invalid?: number;
  readonly duplicates?: number;
  readonly added?: number;
  readonly unique?: number;
  readonly isEnd?: boolean;
  readonly hasNext?: boolean;
}

export type VoterBatchObservation =
  | { readonly kind: "batch-start" }
  | {
      readonly kind: "preparation";
      readonly status: "success" | "failed" | "stopped";
      readonly reason?: "authentication" | "rate-limit" | "network" | "http" | "invalid-response";
    }
  | {
      readonly kind: "fetch";
      readonly fetched: number;
      readonly unique: number;
      readonly invalid: number;
      readonly duplicates: number;
      readonly complete: boolean;
      readonly requestFailures: number;
      readonly fatalReason: "authentication" | "rate-limit" | null;
    }
  | {
      readonly kind: "queue";
      readonly eligible: number;
      readonly self: number;
      readonly direct: number;
    }
  | { readonly kind: "dispatch" }
  | {
      readonly kind: "result";
      readonly status: "success" | "skipped" | "stopped" | "failed";
      readonly reason?:
        | "existing"
        | "concurrent"
        | "authentication"
        | "rate-limit"
        | "csrf"
        | "network"
        | "http"
        | "storage"
        | "storage-global";
    }
  | {
      readonly kind: "finish";
      readonly phase: "complete" | "stopped" | "failed";
      readonly dataComplete: boolean;
    }
  | { readonly kind: "exception"; readonly stage: "preparing" | "fetching" | "persisting" };

export type VoterObservation = VoterPageObservation | VoterBatchObservation;
export type VoterObserver = (event: VoterObservation) => void;

export function observeVoters(observer: VoterObserver | undefined, event: VoterObservation): void {
  try {
    observer?.(event);
  } catch {
    /* Optional observation never owns the business operation. */
  }
}
