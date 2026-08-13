import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createDrawerVisibilityController,
  getDrawerMotionContract,
  type DrawerVisibilityPhase,
} from "./drawer-visibility.ts";

function createHarness() {
  const frames: Array<() => void> = [];
  const exits: Array<{ callback: () => void; cancelled: boolean }> = [];
  const hiddenValues: boolean[] = [];
  const inertValues: boolean[] = [];
  const phases: DrawerVisibilityPhase[] = [];
  const controller = createDrawerVisibilityController({
    setHidden(hidden) {
      hiddenValues.push(hidden);
    },
    setInert(inert) {
      inertValues.push(inert);
    },
    setPhase(phase) {
      phases.push(phase);
    },
    scheduleFrame(callback) {
      frames.push(callback);
    },
    scheduleExit(callback) {
      const exit = { callback, cancelled: false };
      exits.push(exit);
      return () => {
        exit.cancelled = true;
      };
    },
  });

  function runNextFrame(): void {
    frames.shift()?.();
  }

  function finishExit(index = exits.length - 1): void {
    const exit = exits[index];
    if (exit && !exit.cancelled) {
      exit.callback();
    }
  }

  return {
    controller,
    frames,
    exits,
    hiddenValues,
    inertValues,
    phases,
    runNextFrame,
    finishExit,
  };
}

test("TAG-011 keeps the opening offset visible for one painted frame", () => {
  const harness = createHarness();
  harness.controller.open();

  strictEqual(harness.controller.getPhase(), "opening");
  deepStrictEqual(harness.hiddenValues, [false]);
  deepStrictEqual(harness.inertValues, [false]);
  strictEqual(harness.frames.length, 1);

  harness.runNextFrame();
  strictEqual(harness.controller.getPhase(), "opening");
  strictEqual(harness.frames.length, 1);

  harness.runNextFrame();
  strictEqual(harness.controller.getPhase(), "open");
  deepStrictEqual(harness.phases, ["opening", "open"]);
});

test("TAG-011 closes in reverse before becoming hidden and unfocusable", () => {
  const harness = createHarness();
  harness.controller.open();
  harness.runNextFrame();
  harness.runNextFrame();
  harness.controller.close();

  strictEqual(harness.controller.getPhase(), "closing");
  deepStrictEqual(harness.hiddenValues, [false]);
  deepStrictEqual(harness.inertValues, [false, true]);

  harness.finishExit();
  strictEqual(harness.controller.getPhase(), "hidden");
  deepStrictEqual(harness.hiddenValues, [false, true]);
  deepStrictEqual(harness.phases, ["opening", "open", "closing", "hidden"]);
});

test("opening a new target during close cancels the stale hide", () => {
  const harness = createHarness();
  harness.controller.open();
  harness.runNextFrame();
  harness.runNextFrame();
  harness.controller.close();
  strictEqual(harness.exits.length, 1);

  harness.controller.open();
  strictEqual(harness.exits[0]?.cancelled, true);
  harness.exits[0]?.callback();
  strictEqual(harness.controller.getPhase(), "opening");
  deepStrictEqual(harness.hiddenValues, [false, false]);

  harness.runNextFrame();
  harness.runNextFrame();
  strictEqual(harness.controller.getPhase(), "open");
});

test("reduced motion removes displacement while retaining a short opacity transition", () => {
  const regular = getDrawerMotionContract(false);
  const reduced = getDrawerMotionContract(true);

  strictEqual(regular.offsetPixels, 8);
  strictEqual(regular.enterDurationMilliseconds, 120);
  strictEqual(regular.exitDurationMilliseconds, 120);
  strictEqual(reduced.offsetPixels, 0);
  strictEqual(reduced.enterDurationMilliseconds, 80);
  strictEqual(reduced.exitDurationMilliseconds, 80);
  deepStrictEqual(reduced.animatedProperties, ["transform", "opacity"]);
});
