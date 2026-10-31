export const DIAGNOSTIC_CHANNEL = "cocoon-dev-diagnostics";
export const DIAGNOSTIC_STORAGE_KEY = "cocoonDevDiagnostics";
export const MAX_EVENTS = 1_000;
export const MAX_AGE_MS = 300_000;
export const MAX_INCIDENT_BYTES = 131_072;
export const MAX_INCIDENTS = 3;
export const RETENTION_MS = 604_800_000;

const KINDS = [
  "submit",
  "receipt",
  "visibility-start",
  "visibility-end",
  "pending-end",
  "hover-added",
  "hover-state",
  "hover-removed",
  "pointer",
  "hidden",
  "lifecycle",
] as const;
const REASONS = [
  "completed",
  "failed",
  "incomplete",
  "timeout",
  "superseded",
  "pagehide",
  "pageshow",
  "persisted",
  "duplicate",
  "aborted",
  "error",
  "mouseover",
  "mouseout",
  "click",
  "initial",
] as const;
const COUNTS = [
  "operation",
  "node",
  "relatedNode",
  "total",
  "hidden",
  "detached",
  "changed",
  "pending",
  "count",
  "dropped",
] as const;
const COORDINATES = ["x", "y", "pointX", "pointY"] as const;
const DIMENSIONS = ["width", "height", "durationMs"] as const;

type NumericField =
  (typeof COUNTS)[number] | (typeof COORDINATES)[number] | (typeof DIMENSIONS)[number];
export type DiagnosticEvent = {
  at: number;
  kind: (typeof KINDS)[number];
  reason?: (typeof REASONS)[number];
  userId?: string;
  memberHashId?: string;
  authorName?: string;
  profileUrl?: string;
} & Partial<Record<NumericField, number>>;

export interface DiagnosticIncident {
  schemaVersion: 1;
  pageId: string;
  id: string;
  savedAt: number;
  reason: "suspected-hover" | "manual";
  truncated: number;
  events: DiagnosticEvent[];
}

export type DiagnosticRequest =
  | { channel: typeof DIAGNOSTIC_CHANNEL; operation: "save"; incident: DiagnosticIncident }
  | { channel: typeof DIAGNOSTIC_CHANNEL; operation: "clear" | "prune" };

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function nonnegativeNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input) && input >= 0;
}

function count(input: unknown): boolean {
  return nonnegativeNumber(input) && Number.isSafeInteger(input);
}

function boundedString(input: unknown, max: number): input is string {
  return typeof input === "string" && input.length <= max;
}

function validEventField(key: string, value: unknown): boolean {
  if (key === "at") return nonnegativeNumber(value);
  if (key === "kind") return KINDS.some((kind) => kind === value);
  if (key === "reason") return REASONS.some((reason) => reason === value);
  if (COUNTS.some((field) => field === key)) return count(value);
  if (COORDINATES.some((field) => field === key)) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
  }
  if (DIMENSIONS.some((field) => field === key)) return nonnegativeNumber(value);
  return validIdentityField(key, value);
}

function validIdentityField(key: string, value: unknown): boolean {
  if (key === "userId" || key === "memberHashId") return boundedString(value, 256);
  if (key === "authorName") return boundedString(value, 200);
  if (key === "profileUrl") {
    return (
      boundedString(value, 1_024) &&
      /^https:\/\/www\.zhihu\.com\/people\/[A-Za-z0-9_-]+$/.test(value)
    );
  }
  return false;
}

export function parseDiagnosticEvent(input: unknown): DiagnosticEvent | null {
  if (!isRecord(input) || !Object.hasOwn(input, "at") || !Object.hasOwn(input, "kind")) return null;
  if (!Object.entries(input).every(([key, value]) => validEventField(key, value))) return null;
  return { ...input } as DiagnosticEvent;
}

export function jsonBytes(input: unknown): number {
  const json = JSON.stringify(input);
  if (json === undefined) throw new TypeError("Not JSON data");
  return new TextEncoder().encode(json).byteLength;
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
  );
}

function incidentId(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(input);
}

function validIncidentMetadata(
  input: Record<string, unknown>,
): input is Record<string, unknown> & Omit<DiagnosticIncident, "events"> {
  if (input.schemaVersion !== 1 || !incidentId(input.pageId) || !incidentId(input.id)) return false;
  if (!nonnegativeNumber(input.savedAt) || !count(input.truncated)) return false;
  return input.reason === "suspected-hover" || input.reason === "manual";
}

export function parseDiagnosticIncident(input: unknown): DiagnosticIncident | null {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["schemaVersion", "pageId", "id", "savedAt", "reason", "truncated", "events"])
  )
    return null;
  if (!validIncidentMetadata(input)) return null;
  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) return null;
  const events: DiagnosticEvent[] = [];
  for (const value of input.events) {
    const event = parseDiagnosticEvent(value);
    if (!event) return null;
    events.push(event);
  }
  const incident: DiagnosticIncident = {
    schemaVersion: 1,
    pageId: input.pageId,
    id: input.id,
    savedAt: input.savedAt,
    reason: input.reason,
    truncated: input.truncated,
    events,
  };
  return jsonBytes(incident) <= MAX_INCIDENT_BYTES ? incident : null;
}

export function parseDiagnosticRequest(input: unknown): DiagnosticRequest | null {
  if (!isRecord(input) || input.channel !== DIAGNOSTIC_CHANNEL) return null;
  if (input.operation === "save" && exactKeys(input, ["channel", "operation", "incident"])) {
    const incident = parseDiagnosticIncident(input.incident);
    return incident ? { channel: DIAGNOSTIC_CHANNEL, operation: "save", incident } : null;
  }
  if (
    (input.operation === "clear" || input.operation === "prune") &&
    exactKeys(input, ["channel", "operation"])
  ) {
    return { channel: DIAGNOSTIC_CHANNEL, operation: input.operation };
  }
  return null;
}
