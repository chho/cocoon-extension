import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialState,
  planAuthorCommit,
  type BlacklistState,
} from "./blacklist-state.ts";
import { persistPlannedCommit } from "./persist-blacklist-state.ts";

function planWithImage() {
  const initial = createInitialState();
  const plan = planAuthorCommit(initial, {
    userId: "stable-user",
    authorNameAtCapture: "Name",
    tag: initial.tags[0],
    isNewTag: false,
    blacklistedAt: "2026-08-13T12:34:56.789Z",
    cardImage: {
      dataUrl: "data:image/webp;base64,AA==",
      width: 2,
      height: 2,
    },
  });
  if (plan.status !== "ready") {
    throw new Error("Expected a ready commit plan.");
  }
  return plan;
}

test("persists the complete record on the first successful write", async () => {
  const plan = planWithImage();
  const writes: BlacklistState[] = [];
  const result = await persistPlannedCommit(plan, async (state) => {
    writes.push(state);
  });
  deepStrictEqual(writes, [plan.withImage]);
  strictEqual(result.state, plan.withImage);
  strictEqual(result.omittedImageAfterWriteFailure, false);
});

test("retries once with a minimal record when the image write fails", async () => {
  const plan = planWithImage();
  const writes: BlacklistState[] = [];
  const result = await persistPlannedCommit(plan, async (state) => {
    writes.push(state);
    if (writes.length === 1) {
      throw new Error("quota");
    }
  });
  deepStrictEqual(writes, [plan.withImage, plan.withoutImage]);
  strictEqual(result.state, plan.withoutImage);
  strictEqual(result.omittedImageAfterWriteFailure, true);
});

test("rejects when the minimal record cannot be persisted", async () => {
  const plan = planWithImage();
  let writes = 0;
  await rejects(
    persistPlannedCommit(plan, async () => {
      writes += 1;
      throw new Error("storage unavailable");
    }),
    /storage unavailable/,
  );
  strictEqual(writes, 2);
});
