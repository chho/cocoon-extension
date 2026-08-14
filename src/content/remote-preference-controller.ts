import {
  type RemotePreferenceKey,
  type RemotePreferences,
} from "./remote-preferences.ts";

export interface RemotePreferenceControllerDependencies {
  readonly initialPreferences: RemotePreferences;
  readonly save: (
    key: RemotePreferenceKey,
    value: boolean,
  ) => Promise<RemotePreferences>;
  readonly render: (preferences: RemotePreferences) => void;
  readonly reportFailure: (error: unknown) => void;
}

export interface RemotePreferenceController {
  replacePersisted(preferences: RemotePreferences): void;
  setPreference(key: RemotePreferenceKey, value: boolean): Promise<void>;
  getVisiblePreferences(): RemotePreferences;
}

export function createRemotePreferenceController(
  dependencies: RemotePreferenceControllerDependencies,
): RemotePreferenceController {
  let persisted = dependencies.initialPreferences;
  const pending: Partial<Record<RemotePreferenceKey, boolean>> = {};
  const revisions: Record<RemotePreferenceKey, number> = {
    blockAuthorOnZhihu: 0,
    blockContentVoters: 0,
  };

  function visiblePreferences(): RemotePreferences {
    return {
      ...persisted,
      blockAuthorOnZhihu:
        pending.blockAuthorOnZhihu ?? persisted.blockAuthorOnZhihu,
      blockContentVoters:
        pending.blockContentVoters ?? persisted.blockContentVoters,
    };
  }

  function render(): void {
    dependencies.render(visiblePreferences());
  }

  render();

  return {
    replacePersisted(preferences) {
      persisted = preferences;
      render();
    },

    async setPreference(key, value) {
      revisions[key] += 1;
      const revision = revisions[key];
      pending[key] = value;
      render();

      try {
        persisted = await dependencies.save(key, value);
      } catch (error) {
        dependencies.reportFailure(error);
      } finally {
        if (revisions[key] === revision) {
          delete pending[key];
          render();
        }
      }
    },

    getVisiblePreferences() {
      return visiblePreferences();
    },
  };
}

export async function runAfterRemotePreferencesReady<T>(
  ready: Promise<void>,
  operation: () => T | Promise<T>,
): Promise<T> {
  await ready;
  return operation();
}
