import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createRemotePreferenceController,
  runAfterRemotePreferencesReady,
} from "./remote-preference-controller.ts";
import {
  createDefaultRemotePreferences,
  type RemotePreferences,
} from "./remote-preferences.ts";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test("PREF-001 initialization gate delays a rapid open until the latest preferences are ready", async () => {
  const ready = deferred<void>();
  let latest = createDefaultRemotePreferences();
  const openedWith: RemotePreferences[] = [];

  const opening = runAfterRemotePreferencesReady(ready.promise, () => {
    openedWith.push(latest);
  });
  await Promise.resolve();
  strictEqual(openedWith.length, 0);

  latest = {
    ...latest,
    blockAuthorOnZhihu: true,
    blockContentVoters: true,
  };
  ready.resolve(undefined);
  await opening;

  deepStrictEqual(openedWith, [latest]);
});

test("PREF-003 failed writes visibly roll back to the latest persisted authorization", async () => {
  const persisted: RemotePreferences = {
    ...createDefaultRemotePreferences(),
    blockContentVoters: true,
  };
  const rendered: RemotePreferences[] = [];
  const pendingSave = deferred<RemotePreferences>();
  let failures = 0;
  const controller = createRemotePreferenceController({
    initialPreferences: persisted,
    save() {
      return pendingSave.promise;
    },
    render(preferences) {
      rendered.push(preferences);
    },
    reportFailure() {
      failures += 1;
    },
  });

  const saving = controller.setPreference("blockAuthorOnZhihu", true);
  deepStrictEqual(controller.getVisiblePreferences(), {
    ...persisted,
    blockAuthorOnZhihu: true,
  });
  strictEqual(rendered.at(-1)?.blockAuthorOnZhihu, true);

  pendingSave.reject(new Error("storage unavailable"));
  await saving;

  deepStrictEqual(controller.getVisiblePreferences(), persisted);
  deepStrictEqual(rendered.at(-1), persisted);
  strictEqual(failures, 1);
});
