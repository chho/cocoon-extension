import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { CoordinatedBlockResult } from "./remote-block-coordinator.ts";
import {
  createVoterBatchController,
  type VoterBatchControllerDependencies,
  type VoterBatchProgress,
} from "./voter-batch-controller.ts";
import type { VoterObservation, VoterObserver } from "./voter-observation.ts";
import type { VoterFetchResult } from "./zhihu-remote-api.ts";

const request = {
  source: { kind: "answer", questionId: "1", contentId: "2" } as const,
  tagId: "default",
  directAuthorUserId: "direct-author",
  sourcePostId: "zhihu:answer:2",
  isStopped: () => false,
};

function voters(ids: readonly string[]): VoterFetchResult {
  return {
    users: ids.map((userId) => ({ userId, authorName: `Synthetic ${userId}` })),
    fetched: ids.length,
    invalid: 0,
    duplicates: 0,
    complete: true,
    requestFailures: 0,
    fatalReason: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const success: CoordinatedBlockResult = { status: "success", persistedUpvoter: true };

function harness(
  result: VoterFetchResult,
  overrides: Partial<VoterBatchControllerDependencies> = {},
) {
  const events: VoterObservation[] = [];
  const progress: VoterBatchProgress[] = [];
  const calls: string[] = [];
  const dependencies = {
    fetchCurrentUser: async () => ({ status: "success" as const, userId: "self" }),
    async fetchVoters(_source, _stopped, onProgress) {
      onProgress({
        fetched: result.fetched,
        unique: result.users.length,
        complete: result.complete,
      });
      return result;
    },
    coordinator: {
      async block(input) {
        calls.push(input.userId);
        return success;
      },
    },
    reportProgress: (value) => progress.push(value),
    observer: (event: VoterObservation) => events.push(event),
    ...overrides,
  } satisfies VoterBatchControllerDependencies;
  return { controller: createVoterBatchController(dependencies), events, progress, calls };
}

function count(events: readonly VoterObservation[], kind: VoterObservation["kind"]) {
  return events.filter((event) => event.kind === kind).length;
}

function largeBatch(observer?: VoterObserver | null) {
  const ids = [
    "self",
    "direct-author",
    ...Array.from({ length: 102 }, (_, index) => `voter-${index}`),
  ];
  const result = { ...voters(ids), fetched: 114, invalid: 3, duplicates: 7 };
  return harness(result, {
    ...(observer !== undefined ? { observer: observer ?? undefined } : {}),
    coordinator: {
      async block(input) {
        const index = Number(input.userId.slice("voter-".length));
        if (index < 20) return success;
        if (index < 95) return { status: "skipped", reason: "existing" };
        if (index < 99) return { status: "skipped", reason: "concurrent" };
        return { status: "failed", reason: "storage" };
      },
    },
  });
}

test("DIAG-004 explains 104 unique voters with exactly 20 new records and no identity payload", async () => {
  const batch = largeBatch();
  const result = await batch.controller.run(request);
  deepStrictEqual(result, {
    phase: "complete",
    fetched: 104,
    success: 20,
    failed: 3,
    skipped: 91,
    unprocessed: 0,
    dataComplete: true,
  });
  deepStrictEqual(batch.events.slice(0, 4), [
    { kind: "batch-start" },
    { kind: "preparation", status: "success" },
    {
      kind: "fetch",
      fetched: 114,
      unique: 104,
      invalid: 3,
      duplicates: 7,
      complete: true,
      requestFailures: 0,
      fatalReason: null,
    },
    { kind: "queue", eligible: 102, self: 1, direct: 1 },
  ]);
  strictEqual(count(batch.events, "dispatch"), 102);
  const results = batch.events.filter((event) => event.kind === "result");
  deepStrictEqual(
    results.reduce<Record<string, number>>((ledger, event) => {
      const key = event.reason ?? event.status;
      ledger[key] = (ledger[key] ?? 0) + 1;
      return ledger;
    }, {}),
    { success: 20, existing: 75, concurrent: 4, storage: 3 },
  );
  strictEqual(results.length, 102);
  for (const event of results) {
    deepStrictEqual(
      Object.keys(event).sort(),
      event.reason ? ["kind", "reason", "status"] : ["kind", "status"],
    );
  }
  strictEqual(JSON.stringify(batch.events).includes("voter-"), false);
  strictEqual(JSON.stringify(batch.events).includes("Synthetic"), false);
  deepStrictEqual(batch.events.at(-1), { kind: "finish", phase: "complete", dataComplete: true });
});

test("DIAG-004 a throwing observer preserves business results and every progress callback", async () => {
  let observations = 0;
  const observed = largeBatch(() => {
    observations += 1;
    throw new Error("diagnostic failure");
  });
  const plain = largeBatch(null);
  const expected = await plain.controller.run(request);
  deepStrictEqual(await observed.controller.run(request), expected);
  deepStrictEqual(observed.progress, plain.progress);
  strictEqual(plain.events.length, 0);
  strictEqual(observations, 209);
});

test("DIAG-004 global failure stops dispatch while in-flight successes and stops remain accounted", async () => {
  const gates = Array.from({ length: 3 }, () => deferred<CoordinatedBlockResult>());
  const started = deferred<void>();
  let calls = 0;
  const batch = harness(voters(["a", "b", "c", "d", "e", "f"]), {
    coordinator: {
      block() {
        const gate = gates[calls++];
        if (calls === 3) started.resolve();
        return gate.promise;
      },
    },
  });
  const running = batch.controller.run(request);
  await started.promise;
  strictEqual(count(batch.events, "dispatch"), 3);
  strictEqual(count(batch.events, "result"), 0);
  gates[0].resolve({ status: "failed", reason: "storage-global" });
  gates[1].resolve(success);
  gates[2].resolve({ status: "stopped" });
  const result = await running;
  deepStrictEqual(result, {
    phase: "failed",
    fetched: 6,
    success: 1,
    failed: 1,
    skipped: 0,
    unprocessed: 4,
    dataComplete: true,
  });
  strictEqual(calls, 3);
  strictEqual(count(batch.events, "result"), 3);
  deepStrictEqual(batch.events.at(-1), { kind: "finish", phase: "failed", dataComplete: true });
});

test("DIAG-004 worker rejection has no false finish and later workers remain observable", async () => {
  const gates = Array.from({ length: 3 }, () => deferred<CoordinatedBlockResult>());
  const started = deferred<void>();
  const drained = deferred<void>();
  const events: VoterObservation[] = [];
  let calls = 0;
  const error = new Error("private unexpected storage detail");
  const batch = harness(voters(["a", "b", "c", "d", "e", "f"]), {
    coordinator: {
      async block() {
        const index = calls++;
        if (calls === 3) started.resolve();
        return index < 3 ? gates[index].promise : success;
      },
    },
    observer(event) {
      events.push(event);
      if (count(events, "result") === 5) drained.resolve();
    },
  });
  const running = batch.controller.run(request);
  const rejection = rejects(running, (caught) => caught === error);
  await started.promise;
  gates[0].reject(error);
  await rejection;
  deepStrictEqual(events.at(-1), { kind: "exception", stage: "persisting" });
  strictEqual(count(events, "finish"), 0);
  strictEqual(count(events, "result"), 0);
  gates[1].resolve(success);
  gates[2].resolve(success);
  await drained.promise;
  strictEqual(count(events, "dispatch"), 6);
  strictEqual(count(events, "result"), 5);
  strictEqual(count(events, "finish"), 0);
  strictEqual(JSON.stringify(events).includes(error.message), false);
});

for (const reason of [
  "authentication",
  "rate-limit",
  "network",
  "http",
  "invalid-response",
] as const) {
  test(`DIAG-004 preparation failure observes ${reason} without fetching or dispatching`, async () => {
    const batch = harness(voters(["a"]), {
      fetchCurrentUser: async () => ({ status: "failed", reason }),
      fetchVoters: async () => {
        throw new Error("must not fetch");
      },
    });
    strictEqual((await batch.controller.run(request)).phase, "failed");
    deepStrictEqual(batch.events, [
      { kind: "batch-start" },
      { kind: "preparation", status: "failed", reason },
      { kind: "finish", phase: "failed", dataComplete: false },
    ]);
  });
}

for (const stage of ["preparing", "fetching"] as const) {
  test(`DIAG-004 unexpected ${stage} exception is observed and rethrown unchanged`, async () => {
    const error = new Error("private response detail");
    const fail = async (): Promise<never> => {
      throw error;
    };
    const batch = harness(
      voters(["a"]),
      stage === "preparing" ? { fetchCurrentUser: fail } : { fetchVoters: fail },
    );
    await rejects(batch.controller.run(request), (caught) => caught === error);
    deepStrictEqual(batch.events.at(-1), { kind: "exception", stage });
    strictEqual(count(batch.events, "finish"), 0);
    strictEqual(count(batch.events, "dispatch"), 0);
  });
}

test("DIAG-004 partial fetch completion stays partial and overlapping self/direct counts only once", async () => {
  const batch = harness({ ...voters(["self", "a"]), complete: false, requestFailures: 1 });
  const result = await batch.controller.run({ ...request, directAuthorUserId: "self" });
  strictEqual(result.dataComplete, false);
  deepStrictEqual(
    batch.events.find((event) => event.kind === "queue"),
    {
      kind: "queue",
      eligible: 1,
      self: 1,
      direct: 0,
    },
  );
  deepStrictEqual(batch.events.at(-1), { kind: "finish", phase: "complete", dataComplete: false });
});

for (const stopped of [true, false]) {
  test(`DIAG-004 ${stopped ? "stopped" : "fatal"} fetch never dispatches its partial users`, async () => {
    let stop = false;
    const result = { ...voters(["a", "b"]), complete: false, fatalReason: "rate-limit" as const };
    const batch = harness(result, {
      fetchVoters: async () => {
        stop = stopped;
        return result;
      },
    });
    const progress = await batch.controller.run({ ...request, isStopped: () => stop });
    strictEqual(progress.unprocessed, 2);
    strictEqual(count(batch.events, "dispatch"), 0);
    deepStrictEqual(batch.events.at(-1), {
      kind: "finish",
      phase: stopped ? "stopped" : "failed",
      dataComplete: false,
    });
  });
}
