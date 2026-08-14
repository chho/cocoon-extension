export const REMOTE_PREFERENCES_STORAGE_KEY = "cocoonRemotePreferences";
export const REMOTE_PREFERENCES_SCHEMA_VERSION = 1;

export interface RemotePreferences {
  readonly schemaVersion: typeof REMOTE_PREFERENCES_SCHEMA_VERSION;
  readonly blockAuthorOnZhihu: boolean;
  readonly blockContentVoters: boolean;
}

export type RemotePreferenceKey = Exclude<keyof RemotePreferences, "schemaVersion">;

export type ParsedRemotePreferences =
  | { readonly status: "valid"; readonly preferences: RemotePreferences }
  | { readonly status: "missing"; readonly preferences: RemotePreferences }
  | { readonly status: "malformed"; readonly preferences: RemotePreferences };

export interface RemotePreferencesDependencies {
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly read: () => Promise<ParsedRemotePreferences>;
  readonly write: (preferences: RemotePreferences) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createDefaultRemotePreferences(): RemotePreferences {
  return {
    schemaVersion: REMOTE_PREFERENCES_SCHEMA_VERSION,
    blockAuthorOnZhihu: false,
    blockContentVoters: false,
  };
}

export function parseRemotePreferences(value: unknown): ParsedRemotePreferences {
  const fallback = createDefaultRemotePreferences();
  if (value === undefined) {
    return { status: "missing", preferences: fallback };
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== REMOTE_PREFERENCES_SCHEMA_VERSION ||
    typeof value.blockAuthorOnZhihu !== "boolean" ||
    typeof value.blockContentVoters !== "boolean"
  ) {
    return { status: "malformed", preferences: fallback };
  }

  return {
    status: "valid",
    preferences: {
      schemaVersion: REMOTE_PREFERENCES_SCHEMA_VERSION,
      blockAuthorOnZhihu: value.blockAuthorOnZhihu,
      blockContentVoters: value.blockContentVoters,
    },
  };
}

export async function initializeRemotePreferences(
  dependencies: RemotePreferencesDependencies,
): Promise<ParsedRemotePreferences> {
  const initial = await dependencies.read();
  if (initial.status !== "missing") {
    return initial;
  }

  return dependencies.withExclusiveLock(async () => {
    const latest = await dependencies.read();
    if (latest.status !== "missing") {
      return latest;
    }
    await dependencies.write(latest.preferences);
    return dependencies.read();
  });
}

export async function updateRemotePreference(
  dependencies: RemotePreferencesDependencies,
  key: RemotePreferenceKey,
  value: boolean,
): Promise<RemotePreferences> {
  return dependencies.withExclusiveLock(async () => {
    const latest = await dependencies.read();
    const next: RemotePreferences = {
      ...latest.preferences,
      [key]: value,
    };
    await dependencies.write(next);
    return next;
  });
}
