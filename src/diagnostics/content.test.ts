import { strictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  installDevDiagnostics,
  recordCommitReceipt,
  recordDrawerObservation,
  startVoterDiagnostics,
} from "./content.ts";
import { parseVoterSummary } from "./voter-summary.ts";
import type { DiagnosticRequest } from "./contract.ts";

test("Dev diagnostic session is idempotent, saves actual identities and resumes after BFCache without DOM bridges", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://www.zhihu.com/" });
  try {
    let now = 1_000,
      nextId = 0;
    const messages: DiagnosticRequest[] = [];
    const timers = new Set<() => void>();
    const dependencies = {
      now: () => now,
      nextId: () => `test-${++nextId}`,
      send: async (request: DiagnosticRequest) => {
        messages.push(request);
        return { ok: true };
      },
      schedule: (callback: () => void) => {
        timers.add(callback);
        return () => {
          timers.delete(callback);
        };
      },
    };
    const document = dom.window.document;
    const handle = installDevDiagnostics(document, dependencies)!;
    strictEqual(installDevDiagnostics(document, dependencies), handle);
    strictEqual(document.querySelectorAll("script").length, 0);
    const signal = new AbortController().signal;
    recordDrawerObservation(document, {
      phase: "start",
      signal,
      task: {
        target: {
          targetId: "a",
          card: document.body,
          button: document.createElement("button"),
          authorNameAtClick: "Synthetic Author",
          profileUserIdAtClick: "synthetic-author",
          memberHashIdAtClick: null,
          anchorBounds: null,
          voterSource: null,
        },
        selection: { tag: { tagId: "default", name: "private tag excluded" }, isNewTag: false },
        remoteAuthorization: { blockAuthorOnZhihu: false, blockContentVoters: false },
      },
    });
    recordCommitReceipt(document, signal, {
      status: "failed",
      error: new Error("private-error-excluded"),
      focusRestorationRequested: true,
    });
    strictEqual(handle.snapshot().events.at(-1)?.reason, "failed");
    strictEqual(JSON.stringify(handle.snapshot()).includes("private-error-excluded"), false);
    now += 25;
    recordDrawerObservation(document, { phase: "end", signal, reason: "completed" });
    strictEqual(
      handle.snapshot().events.some((e) => e.userId === "synthetic-author"),
      true,
    );
    strictEqual(JSON.stringify(handle.snapshot()).includes("private tag excluded"), false);
    strictEqual(handle.snapshot().events.at(-1)?.durationMs, 25);
    strictEqual(await handle.save(), true);
    strictEqual(
      messages.some((m) => m.operation === "save"),
      true,
    );
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide", { persisted: true }));
    strictEqual(handle.snapshot().active, false);
    strictEqual(timers.size, 0);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow", { persisted: true }));
    strictEqual(handle.snapshot().active, true);
    strictEqual(await handle.clear(), true);
    strictEqual(handle.snapshot().events.length, 0);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
    strictEqual(timers.size, 0);
  } finally {
    dom.window.close();
  }
});

test("DIAG-004 voter diagnostics outlive drawer completion but pause with the document", () => {
  const dom = new JSDOM("<body></body>", { url: "https://www.zhihu.com/" });
  const timers = new Set<() => void>();
  let id = 0;
  const document = dom.window.document;
  const handle = installDevDiagnostics(document, {
    now: () => 1_000,
    nextId: () => `test-${++id}`,
    send: async () => ({ ok: true }),
    schedule(callback) {
      timers.add(callback);
      return () => timers.delete(callback);
    },
  })!;
  const signal = new AbortController().signal;
  const task = {
    target: {
      targetId: "card",
      card: document.body,
      button: document.createElement("button"),
      authorNameAtClick: "Private synthetic author",
      profileUserIdAtClick: "private-synthetic-id",
      memberHashIdAtClick: null,
      anchorBounds: null,
      voterSource: null,
    },
    selection: { tag: { tagId: "default", name: "default" }, isNewTag: false },
    remoteAuthorization: { blockAuthorOnZhihu: false, blockContentVoters: true },
  };
  recordDrawerObservation(document, { phase: "start", signal, task });
  const observe = startVoterDiagnostics(document, task)!;
  recordDrawerObservation(document, { phase: "end", signal, reason: "completed" });
  observe({ kind: "dispatch" });
  const batch = handle.batches().batches[0]!.incident;
  const summary = parseVoterSummary(batch.events.at(-1)?.voter);
  ok(summary);
  strictEqual(summary.operation, 1);
  strictEqual(summary.dispatched, 1);
  strictEqual(summary.outcome, "running");
  strictEqual(JSON.stringify(batch).includes("private-synthetic-id"), false);
  strictEqual(JSON.stringify(batch).includes("Private synthetic author"), false);
  strictEqual((handle.analyzeBatch(batch)?.length ?? 0) > 0, true);
  dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
  strictEqual(timers.size, 0);
  strictEqual(
    parseVoterSummary(handle.batches().batches[0]!.incident.events.at(-1)?.voter)?.outcome,
    "pagehide",
  );
  dom.window.close();
});

test("Dev diagnostic transport failure and deadline settle without leaking timers", async () => {
  const dom = new JSDOM("<body></body>", { url: "https://www.zhihu.com/" });
  try {
    const callbacks = new Set<() => void>();
    const handle = installDevDiagnostics(dom.window.document, {
      now: () => 1_000,
      nextId: () => "test-id",
      send: () => new Promise(() => {}),
      schedule: (callback) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    })!;
    const saving = handle.save();
    for (const callback of [...callbacks]) callback();
    strictEqual(await saving, false);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
    strictEqual(callbacks.size, 0);
  } finally {
    dom.window.close();
  }
});
