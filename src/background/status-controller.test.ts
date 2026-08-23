import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeStatusStateRead } from "./badge-controller.ts";
import { createStatusController } from "./status-controller.ts";

const GENERATION = "status_generation_123";

function createHarness(
  read: BadgeStatusStateRead,
  pong: unknown = {
    version: 1,
    type: "cocoon.content.pong",
    generation: GENERATION,
  },
) {
  const queryCalls: unknown[] = [];
  const sendCalls: Array<{ readonly tabId: number; readonly message: unknown }> = [];
  const tab = { id: 17 };
  const controller = createStatusController(
    {
      async query(queryInfo) {
        queryCalls.push(queryInfo);
        return [tab];
      },
      async sendMessage(tabId, message) {
        sendCalls.push({ tabId, message });
        if (pong instanceof Error) throw pong;
        return pong;
      },
    },
    {
      async getStatusState(tabId) {
        strictEqual(tabId, 17);
        return read;
      },
    },
  );
  return { controller, queryCalls, sendCalls };
}

test("POPUP-001/002 running requires exact session state and a matching content pong", async () => {
  const harness = createHarness({
    status: "valid",
    state: { generation: GENERATION, count: 12_345 },
  });
  deepStrictEqual(await harness.controller.query(), {
    status: "running",
    count: 12_345,
  });
  deepStrictEqual(harness.queryCalls, [{ active: true, currentWindow: true }]);
  deepStrictEqual(harness.sendCalls, [{
    tabId: 17,
    message: {
      version: 1,
      type: "cocoon.content.ping",
      generation: GENERATION,
    },
  }]);
});

test("POPUP-001 missing state is unsupported and never pings content", async () => {
  const harness = createHarness({ status: "missing" });
  deepStrictEqual(await harness.controller.query(), {
    status: "unsupported",
    count: 0,
  });
  deepStrictEqual(harness.sendCalls, []);
});

test("POPUP-001 malformed session state is a connection error, not unsupported", async () => {
  const harness = createHarness({ status: "invalid" });
  deepStrictEqual(await harness.controller.query(), {
    status: "connection-error",
    count: 0,
  });
  deepStrictEqual(harness.sendCalls, []);
});

test("POPUP-001 rejects missing, invalid, extra, stale, and failed pongs", async () => {
  for (const pong of [
    null,
    {},
    { version: 1, type: "cocoon.content.pong", generation: "stale_generation_123" },
    { version: 1, type: "cocoon.content.pong", generation: GENERATION, extra: true },
    new Error("no receiving end"),
  ]) {
    const harness = createHarness({
      status: "valid",
      state: { generation: GENERATION, count: 1_001 },
    }, pong);
    deepStrictEqual(await harness.controller.query(), {
      status: "connection-error",
      count: 1_001,
    });
  }
});

test("POPUP-001 no active tab ID is unsupported without status or content access", async () => {
  let statusReads = 0;
  const controller = createStatusController(
    {
      async query() {
        return [{}, { id: 22 }];
      },
      async sendMessage() {
        throw new Error("must not ping");
      },
    },
    {
      async getStatusState() {
        statusReads += 1;
        return { status: "missing" };
      },
    },
  );
  deepStrictEqual(await controller.query(), { status: "unsupported", count: 0 });
  strictEqual(statusReads, 0);
});
