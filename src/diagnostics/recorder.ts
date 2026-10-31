import {
  MAX_AGE_MS,
  MAX_EVENTS,
  MAX_INCIDENT_BYTES,
  jsonBytes,
  parseDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticIncident,
} from "./contract.ts";

export type DiagnosticInput = Omit<DiagnosticEvent, "at">;

export interface RecorderDependencies {
  readonly now: () => number;
  readonly pageId: string;
  readonly nextId: () => string;
}

function boundIncident(incident: DiagnosticIncident): DiagnosticIncident {
  // Keep the newest evidence; binary search avoids repeatedly encoding 1,000-event logs.
  let low = 0;
  let high = incident.events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...incident,
      truncated: incident.truncated + middle,
      events: incident.events.slice(middle),
    };
    if (jsonBytes(candidate) <= MAX_INCIDENT_BYTES) high = middle;
    else low = middle + 1;
  }
  return { ...incident, truncated: incident.truncated + low, events: incident.events.slice(low) };
}

export function createDiagnosticRecorder(dependencies: RecorderDependencies) {
  let events: DiagnosticEvent[] = [];
  let truncated = 0;
  function prune(): void {
    const cutoff = dependencies.now() - MAX_AGE_MS;
    const retained = events.filter((event) => event.at >= cutoff).slice(-MAX_EVENTS);
    truncated += events.length - retained.length;
    events = retained;
  }
  function snapshot() {
    prune();
    return {
      pageId: dependencies.pageId,
      truncated,
      events: events.map((event) => ({ ...event })),
    };
  }
  return {
    record(input: DiagnosticInput): void {
      const event = parseDiagnosticEvent({ ...input, at: dependencies.now() });
      if (event) events.push(event);
      else truncated++;
      prune();
    },
    snapshot,
    clear(): void {
      events = [];
      truncated = 0;
    },
    incident(reason: DiagnosticIncident["reason"]): DiagnosticIncident {
      const captured = snapshot();
      const incident: DiagnosticIncident = {
        schemaVersion: 1,
        ...captured,
        id: dependencies.nextId(),
        savedAt: dependencies.now(),
        reason,
      };
      return boundIncident(incident);
    },
  };
}

export type DiagnosticRecorder = ReturnType<typeof createDiagnosticRecorder>;
