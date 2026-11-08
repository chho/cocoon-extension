import type * as Contract from "./contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundContract from "./contract.ts?background-copy";

const {
  DIAGNOSTIC_STORAGE_KEY,
  MAX_INCIDENTS,
  RETENTION_MS,
  parseDiagnosticIncident,
  parseDiagnosticRequest,
} = backgroundContract as typeof Contract;

export interface DiagnosticStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DiagnosticLocks {
  request<T>(
    name: string,
    options: { mode: "exclusive"; signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface DiagnosticStore {
  handle(request: Contract.DiagnosticRequest, signal?: AbortSignal): Promise<boolean>;
}

interface StoreDependencies {
  storage: DiagnosticStorage;
  locks: DiagnosticLocks;
  now: () => number;
}

function fresh(incident: Contract.DiagnosticIncident, now: number): boolean {
  return incident.savedAt <= now && incident.savedAt > now - RETENTION_MS;
}

function retained(input: unknown, now: number): Contract.DiagnosticIncident[] {
  if (!Array.isArray(input)) return [];
  const incidents = input
    .map((value: unknown) => parseDiagnosticIncident(value))
    .filter((value): value is Contract.DiagnosticIncident => value !== null && fresh(value, now))
    .sort((a, b) => b.savedAt - a.savedAt);
  const unique = new Map<string, Contract.DiagnosticIncident>();
  for (const incident of incidents) {
    const key = `${incident.pageId}:${incident.id}`;
    const previous = unique.get(key);
    const newerBatch =
      previous?.reason === "voter-batch" &&
      incident.reason === "voter-batch" &&
      incident.sequence! > previous.sequence!;
    if (!previous || newerBatch) unique.set(key, incident);
  }
  return [...unique.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_INCIDENTS);
}

export function createDiagnosticStore(dependencies: StoreDependencies): DiagnosticStore {
  return {
    async handle(input, signal) {
      try {
        const request = parseDiagnosticRequest(input);
        if (!request) return false;
        return await dependencies.locks.request(
          DIAGNOSTIC_STORAGE_KEY,
          { mode: "exclusive", signal },
          async () => {
            signal?.throwIfAborted();
            const values = await dependencies.storage.get(DIAGNOSTIC_STORAGE_KEY);
            signal?.throwIfAborted();
            const now = dependencies.now();
            if (!Number.isFinite(now) || now < 0) return false;
            if (request.operation === "clear") {
              await dependencies.storage.remove(DIAGNOSTIC_STORAGE_KEY);
              return true;
            }
            const current = retained(values[DIAGNOSTIC_STORAGE_KEY], now);
            const valid = request.operation !== "save" || fresh(request.incident, now);
            const next =
              request.operation === "save" && valid
                ? retained([...current, request.incident], now)
                : current;
            await dependencies.storage.set({ [DIAGNOSTIC_STORAGE_KEY]: next });
            return valid;
          },
        );
      } catch {
        return false;
      }
    },
  };
}
