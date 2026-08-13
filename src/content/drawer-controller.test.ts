import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { createInitialState } from "./blacklist-state.ts";
import {
  createDrawerController,
  type CommitTask,
  type DrawerTarget,
} from "./drawer-controller.ts";

interface TestCard {
  readonly id: string;
}

interface TestButton {
  readonly id: string;
}

function target(id: string): DrawerTarget<TestCard, TestButton> {
  return {
    targetId: id,
    card: { id },
    button: { id: `button-${id}` },
    authorNameAtClick: `author-${id}`,
  };
}

function createHarness(onCommit?: () => void) {
  const commits: CommitTask<TestCard, TestButton>[] = [];
  const restoredFocus: TestButton[] = [];
  let draftClears = 0;
  let shows = 0;
  let drawerHides = 0;
  let inputFocuses = 0;
  const controller = createDrawerController<TestCard, TestButton>({
    show() {
      shows += 1;
    },
    hide() {
      drawerHides += 1;
    },
    clearDraft() {
      draftClears += 1;
    },
    focusInput() {
      inputFocuses += 1;
    },
    restoreFocus(button) {
      restoredFocus.push(button);
    },
    commit(task) {
      commits.push(task);
      onCommit?.();
    },
  });
  return {
    controller,
    commits,
    restoredFocus,
    counts: () => ({ draftClears, shows, drawerHides, inputFocuses }),
  };
}

const existingSelection = {
  tag: createInitialState().tags[0],
  isNewTag: false,
} as const;

test("TAG-001/AC-001 opening only presents the drawer", () => {
  const forbidden = {
    authorResolutions: 0,
    captures: 0,
    persistenceWrites: 0,
    authorHides: 0,
  };
  const harness = createHarness(() => {
    forbidden.authorResolutions += 1;
    forbidden.captures += 1;
    forbidden.persistenceWrites += 1;
    forbidden.authorHides += 1;
  });

  harness.controller.open(target("a"));

  deepStrictEqual(forbidden, {
    authorResolutions: 0,
    captures: 0,
    persistenceWrites: 0,
    authorHides: 0,
  });
  strictEqual(harness.commits.length, 0);
  deepStrictEqual(harness.controller.getState(), {
    status: "open",
    targetId: "a",
    draft: "",
  });
  deepStrictEqual(harness.counts(), {
    draftClears: 1,
    shows: 1,
    drawerHides: 0,
    inputFocuses: 1,
  });
});

test("TAG-005/AC-021 close, Escape, and outside cancellation never commit and restore focus", () => {
  for (const cancellation of ["close", "Escape", "outside"] as const) {
    const harness = createHarness();
    const activeTarget = target(cancellation);
    let prevented = 0;
    let stopped = 0;
    harness.controller.open(activeTarget);

    if (cancellation === "close") {
      harness.controller.cancel();
    } else {
      harness.controller.cancel({
        preventDefault() {
          prevented += 1;
        },
        stopImmediatePropagation() {
          stopped += 1;
        },
      });
    }

    strictEqual(harness.commits.length, 0);
    deepStrictEqual(harness.restoredFocus, [activeTarget.button]);
    deepStrictEqual(harness.controller.getState(), { status: "closed" });
    if (cancellation === "outside") {
      strictEqual(prevented, 1);
      strictEqual(stopped, 1);
    }
  }
});

test("TAG-007/AC-023 switching targets clears draft and can only commit the current target", () => {
  const harness = createHarness();
  const first = target("first");
  const second = target("second");
  harness.controller.open(first);
  harness.controller.setDraft("unfinished");
  harness.controller.open(second);

  deepStrictEqual(harness.controller.getState(), {
    status: "open",
    targetId: "second",
    draft: "",
  });
  strictEqual(harness.controller.getTarget(), second);
  strictEqual(harness.counts().shows, 2);

  harness.controller.submit(existingSelection);
  strictEqual(harness.commits.length, 1);
  strictEqual(harness.commits[0]?.target, second);
  harness.controller.submit(existingSelection);
  strictEqual(harness.commits.length, 1);
});

test("TAG-006/TAG-004/AC-019/020 existing and Enter-created tags each submit exactly once", () => {
  const existingHarness = createHarness();
  existingHarness.controller.open(target("existing"));
  existingHarness.controller.submit(existingSelection);
  existingHarness.controller.submit(existingSelection);
  strictEqual(existingHarness.commits.length, 1);
  strictEqual(existingHarness.commits[0]?.selection.isNewTag, false);

  const newHarness = createHarness();
  const newSelection = {
    tag: { tagId: "tag-created", name: "Created" },
    isNewTag: true,
  } as const;
  newHarness.controller.open(target("new"));
  newHarness.controller.setDraft("Created");
  newHarness.controller.submit(newSelection);
  newHarness.controller.submit(newSelection);
  strictEqual(newHarness.commits.length, 1);
  strictEqual(newHarness.commits[0]?.selection.isNewTag, true);
  strictEqual(newHarness.commits[0]?.target.targetId, "new");
});
