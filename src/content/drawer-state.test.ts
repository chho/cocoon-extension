import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  CLOSED_DRAWER_STATE,
  reduceDrawerState,
} from "./drawer-state.ts";

test("opening and switching targets always clears the draft", () => {
  const first = reduceDrawerState(CLOSED_DRAWER_STATE, {
    type: "open",
    targetId: "card-a",
  });
  const drafted = reduceDrawerState(first, {
    type: "draft",
    value: "unfinished",
  });
  deepStrictEqual(
    reduceDrawerState(drafted, { type: "open", targetId: "card-b" }),
    { status: "open", targetId: "card-b", draft: "" },
  );
});

test("closing discards draft and ignores later draft changes", () => {
  const open = reduceDrawerState(CLOSED_DRAWER_STATE, {
    type: "open",
    targetId: "card-a",
  });
  const closed = reduceDrawerState(open, { type: "close" });
  deepStrictEqual(closed, CLOSED_DRAWER_STATE);
  deepStrictEqual(
    reduceDrawerState(closed, { type: "draft", value: "ignored" }),
    CLOSED_DRAWER_STATE,
  );
});
