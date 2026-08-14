import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState } from "./blacklist-state.ts";
import {
  createDrawerController,
  type CommitTask,
  type DrawerTarget,
} from "./drawer-controller.ts";
import { runAuthorizedRemoteOperations } from "./remote-operation-orchestrator.ts";
import { createRemotePreferenceController } from "./remote-preference-controller.ts";
import { createDefaultRemotePreferences } from "./remote-preferences.ts";

const source = { kind: "answer", questionId: "1", contentId: "2" } as const;

test("AC-037 both disabled options issue no voter-list GET or remote POST", () => {
  let voterListGets = 0;
  let posts = 0;
  const dispatched = runAuthorizedRemoteOperations(
    {
      blockAuthorOnZhihu: false,
      blockContentVoters: false,
    },
    source,
    {
      blockAuthor() {
        posts += 1;
      },
      blockVoters() {
        voterListGets += 1;
        posts += 1;
      },
    },
  );

  deepStrictEqual(dispatched, {
    authorStarted: false,
    votersStarted: false,
  });
  strictEqual(voterListGets, 0);
  strictEqual(posts, 0);
});

test("PREF-003/AC-044/045 saved preselection survives cancel and runs only on tag submit", async () => {
  let persisted = createDefaultRemotePreferences();
  const preferences = createRemotePreferenceController({
    initialPreferences: persisted,
    async save(key, value) {
      persisted = { ...persisted, [key]: value };
      return persisted;
    },
    render() {},
    reportFailure(error) {
      throw error;
    },
  });
  await preferences.setPreference("blockAuthorOnZhihu", true);
  await preferences.setPreference("blockContentVoters", true);

  let voterListGets = 0;
  let posts = 0;
  const commits: CommitTask<string, string>[] = [];
  const drawer = createDrawerController<string, string>({
    show() {},
    hide() {},
    clearDraft() {},
    focusInput() {},
    restoreFocus() {},
    getRemoteAuthorization() {
      const visible = preferences.getVisiblePreferences();
      return {
        blockAuthorOnZhihu: visible.blockAuthorOnZhihu,
        blockContentVoters: visible.blockContentVoters,
      };
    },
    commit(task) {
      commits.push(task);
      runAuthorizedRemoteOperations(
        task.remoteAuthorization,
        task.target.voterSource,
        {
          blockAuthor() {
            posts += 1;
          },
          blockVoters() {
            voterListGets += 1;
            posts += 1;
          },
        },
      );
    },
  });
  const target: DrawerTarget<string, string> = {
    targetId: "card",
    card: "card",
    button: "button",
    authorNameAtClick: "Author",
    voterSource: source,
  };

  drawer.open(target);
  strictEqual(voterListGets, 0);
  strictEqual(posts, 0);
  drawer.cancel();
  strictEqual(voterListGets, 0);
  strictEqual(posts, 0);
  deepStrictEqual(preferences.getVisiblePreferences(), {
    schemaVersion: 1,
    blockAuthorOnZhihu: true,
    blockContentVoters: true,
  });

  drawer.open(target);
  strictEqual(voterListGets, 0);
  strictEqual(posts, 0);
  drawer.submit({
    tag: createInitialState().tags[0],
    isNewTag: false,
  });

  strictEqual(commits.length, 1);
  strictEqual(voterListGets, 1);
  strictEqual(posts, 2);
});
