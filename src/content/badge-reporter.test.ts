import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BadgeMessage } from "../core/badge-message-contract.ts";
import { startSitePluginWithBadgeReset } from "./badge-bootstrap.ts";
import { createBadgeReporter } from "./badge-reporter.ts";

const GENERATION = "document_generation_123";

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

test("BADGE-006 reset completes before plugin filtering mounts", async () => {
  let releaseReset: (() => void) | undefined;
  const resetGate = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  let mounts = 0;
  const reporter = createBadgeReporter({
    generation: GENERATION,
    async sendMessage() {
      await resetGate;
      return { ok: true };
    },
    schedule(callback) {
      queueMicrotask(callback);
    },
  });
  const bootstrap = {
    async start() {
      mounts += 1;
      return { status: "mounted", pluginId: "fixture" } as const;
    },
  };

  const started = startSitePluginWithBadgeReset(
    bootstrap,
    new URL("https://www.zhihu.com/"),
    reporter,
  );
  await settle();
  strictEqual(mounts, 0);

  releaseReset?.();
  deepStrictEqual(await started, { status: "mounted", pluginId: "fixture" });
  strictEqual(mounts, 1);
});

test("BADGE-006 reset failure is reported but never prevents plugin filtering from mounting", async () => {
  let mounts = 0;
  let failures = 0;
  const reporter = createBadgeReporter({
    generation: GENERATION,
    async sendMessage() {
      throw new Error("background unavailable");
    },
    schedule(callback) {
      queueMicrotask(callback);
    },
    reportFailure() {
      failures += 1;
    },
  });
  const bootstrap = {
    async start() {
      mounts += 1;
      return { status: "mounted", pluginId: "fixture" } as const;
    },
  };

  deepStrictEqual(
    await startSitePluginWithBadgeReset(
      bootstrap,
      new URL("https://www.zhihu.com/"),
      reporter,
    ),
    { status: "mounted", pluginId: "fixture" },
  );
  strictEqual(failures, 1);
  strictEqual(mounts, 1);
});

test("BADGE-001/006 synchronous first-hide reports batch into one generation-bound increment", async () => {
  const scheduled: Array<() => void> = [];
  const messages: BadgeMessage[] = [];
  const reporter = createBadgeReporter({
    generation: GENERATION,
    async sendMessage(message) {
      messages.push(message);
      return { ok: true };
    },
    schedule(callback) {
      scheduled.push(callback);
    },
  });

  await reporter.reset();
  reporter.recordFirstHidden();
  reporter.recordFirstHidden();
  reporter.recordFirstHidden();
  strictEqual(scheduled.length, 1);
  scheduled.shift()?.();
  await settle();

  deepStrictEqual(messages, [
    {
      version: 1,
      type: "cocoon.badge.reset",
      generation: GENERATION,
    },
    {
      version: 1,
      type: "cocoon.badge.increment",
      generation: GENERATION,
      delta: 3,
    },
  ]);
});

test("BADGE-006 a new batch can flush while the previous send remains in flight", async () => {
  const scheduled: Array<() => void> = [];
  const messages: BadgeMessage[] = [];
  let releaseFirstIncrement: (() => void) | undefined;
  const firstIncrementGate = new Promise<void>((resolve) => {
    releaseFirstIncrement = resolve;
  });
  let increments = 0;
  const reporter = createBadgeReporter({
    generation: GENERATION,
    async sendMessage(message) {
      messages.push(message);
      if (message.type === "cocoon.badge.increment") {
        increments += 1;
        if (increments === 1) {
          await firstIncrementGate;
        }
      }
      return { ok: true };
    },
    schedule(callback) {
      scheduled.push(callback);
    },
  });

  await reporter.reset();
  reporter.recordFirstHidden();
  reporter.recordFirstHidden();
  scheduled.shift()?.();
  await settle();

  reporter.recordFirstHidden();
  reporter.recordFirstHidden();
  reporter.recordFirstHidden();
  strictEqual(scheduled.length, 1);
  scheduled.shift()?.();
  await settle();

  deepStrictEqual(messages.slice(1), [
    {
      version: 1,
      type: "cocoon.badge.increment",
      generation: GENERATION,
      delta: 2,
    },
    {
      version: 1,
      type: "cocoon.badge.increment",
      generation: GENERATION,
      delta: 3,
    },
  ]);
  releaseFirstIncrement?.();
  await settle();
  strictEqual(messages.length, 3);
});

test("BADGE-006 rejected, invalid, and ambiguous message outcomes are swallowed without retries", async () => {
  for (const scenario of ["reject", "invalid"] as const) {
    const scheduled: Array<() => void> = [];
    let sends = 0;
    let failures = 0;
    const reporter = createBadgeReporter({
      generation: GENERATION,
      async sendMessage() {
        sends += 1;
        if (scenario === "reject") {
          throw new Error("ambiguous send failure");
        }
        return { ok: true, unexpected: true };
      },
      schedule(callback) {
        scheduled.push(callback);
      },
      reportFailure() {
        failures += 1;
      },
    });

    await reporter.reset();
    reporter.recordFirstHidden();
    scheduled.shift()?.();
    await settle();
    strictEqual(sends, 2, scenario);
    strictEqual(failures, 2, scenario);
    strictEqual(scheduled.length, 0, scenario);
  }
});

test("BADGE-006 scheduler failure remains exception-contained", () => {
  let failures = 0;
  const reporter = createBadgeReporter({
    generation: GENERATION,
    async sendMessage() {
      throw new Error("must not send");
    },
    schedule() {
      throw new Error("scheduler unavailable");
    },
    reportFailure() {
      failures += 1;
    },
  });

  reporter.recordFirstHidden();
  strictEqual(failures, 1);
});
