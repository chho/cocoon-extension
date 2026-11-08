import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { SubmissionPoint, TagSelection } from "../../content/drawer-controller.ts";
import { createDrawerSubmitter } from "./drawer-submission.ts";

test("BUG-022 only pointer clicks carry exposure coordinates, after preferences are ready", async () => {
  const dom = new JSDOM();
  const selection: TagSelection = { tag: { tagId: "default", name: "default" }, isNewTag: false };
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const points: Array<SubmissionPoint | undefined> = [];
  const controller = {
    submit(value: TagSelection, point?: SubmissionPoint) {
      strictEqual(value, selection);
      points.push(point);
    },
  };
  const submit = createDrawerSubmitter(ready, () => controller);
  try {
    const pending = submit(
      selection,
      new dom.window.MouseEvent("click", { detail: 1, clientX: 380, clientY: 500 }),
    );
    strictEqual(points.length, 0);
    release();
    await pending;
    await submit(
      selection,
      new dom.window.MouseEvent("click", { detail: 0, clientX: 380, clientY: 500 }),
    );
    await submit(selection);
    deepStrictEqual(points, [{ x: 380, y: 500 }, undefined, undefined]);
  } finally {
    dom.window.close();
  }
});
