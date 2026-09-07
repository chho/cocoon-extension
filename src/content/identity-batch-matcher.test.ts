import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import type { BlacklistIdentityQueryDto } from "../core/blacklist-query-rpc-contract.ts";
import { createIdentityBatchMatcher } from "./identity-batch-matcher.ts";

function identity(identifier: string): BlacklistIdentityQueryDto {
  return { platformId: "zhihu", identifier };
}

function createFrames() {
  const frames: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    schedule(callback: () => void) {
      const frame = { callback, cancelled: false };
      frames.push(frame);
      return () => {
        frame.cancelled = true;
      };
    },
    flushNext() {
      const frame = frames.shift();
      if (!frame) throw new Error("Expected a queued frame.");
      if (!frame.cancelled) frame.callback();
    },
    flush() {
      while (frames.length > 0) this.flushNext();
    },
    get size() {
      return frames.length;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("BUG-016 100,000 stored authors still query only 524 visible unique identities in bounded RAF batches", async () => {
  const frames = createFrames();
  const requests: Array<readonly BlacklistIdentityQueryDto[]> = [];
  const matcher = createIdentityBatchMatcher({
    schedule: frames.schedule,
    async query({ revision, identities }) {
      strictEqual(revision, 17);
      requests.push(identities);
      return { revision: 17, matches: identities.filter((_, index) => index % 2 === 0) };
    },
  });
  matcher.setRevision(17);

  const visible = Array.from({ length: 524 }, (_, index) => identity(`visible-${index}`));
  const outcomes = visible.map((value) => matcher.match([value]));
  while (frames.size > 0) {
    frames.flushNext();
    await settle();
  }
  await Promise.all(outcomes);

  deepStrictEqual(
    requests.map((batch) => batch.length),
    [200, 200, 124],
  );
  strictEqual(requests.flat().length, 524);
  strictEqual(Math.max(...requests.map((batch) => batch.length)) <= 200, true);
});

test("BUG-016 concurrent duplicate identities share a request and positive/negative LRU entries are finite", async () => {
  const frames = createFrames();
  const requests: string[][] = [];
  const matcher = createIdentityBatchMatcher({
    schedule: frames.schedule,
    positiveCacheLimit: 2,
    negativeCacheLimit: 2,
    async query({ identities }) {
      requests.push(identities.map(({ identifier }) => identifier));
      return {
        revision: 3,
        matches: identities.filter(({ identifier }) => identifier.startsWith("blocked")),
      };
    },
  });
  matcher.setRevision(3);

  const duplicate = [
    matcher.match([identity("blocked-a")]),
    matcher.match([identity("blocked-a")]),
  ];
  frames.flushNext();
  await settle();
  deepStrictEqual(await Promise.all(duplicate), ["matched", "matched"]);
  deepStrictEqual(requests, [["blocked-a"]]);

  for (const identifier of ["blocked-b", "blocked-c", "visible-a", "visible-b", "visible-c"]) {
    const result = matcher.match([identity(identifier)]);
    frames.flushNext();
    await settle();
    await result;
  }
  const evictedPositive = matcher.match([identity("blocked-a")]);
  const evictedNegative = matcher.match([identity("visible-a")]);
  frames.flushNext();
  await settle();
  deepStrictEqual(await Promise.all([evictedPositive, evictedNegative]), ["matched", "unmatched"]);
  deepStrictEqual(requests.at(-1), ["blocked-a", "visible-a"]);
});

test("BUG-016 revision growth drops an old response, requeries, and invalidates both positive and negative cache", async () => {
  const frames = createFrames();
  const first = deferred<{
    readonly revision: number;
    readonly matches: readonly BlacklistIdentityQueryDto[];
  }>();
  const revisions: number[] = [];
  let queryCount = 0;
  const matcher = createIdentityBatchMatcher({
    schedule: frames.schedule,
    async query({ revision, identities }) {
      revisions.push(revision);
      queryCount += 1;
      if (queryCount === 1) return first.promise;
      return {
        revision,
        matches: revision === 8 ? identities.filter(({ identifier }) => identifier === "new") : [],
      };
    },
  });
  matcher.setRevision(7);

  const stale = matcher.match([identity("new")]);
  frames.flushNext();
  matcher.setRevision(8);
  first.resolve({ revision: 7, matches: [] });
  await settle();
  frames.flushNext();
  await settle();
  strictEqual(await stale, "matched");
  deepStrictEqual(revisions, [7, 8]);

  const removed = matcher.match([identity("new")]);
  strictEqual(await removed, "matched");
  matcher.setRevision(9);
  const reproved = matcher.match([identity("new")]);
  frames.flushNext();
  await settle();
  strictEqual(await reproved, "unmatched");
});

test("BUG-016 failures stay fail-open and retry on a later real evaluation", async () => {
  const frames = createFrames();
  let attempts = 0;
  const matcher = createIdentityBatchMatcher({
    schedule: frames.schedule,
    async query({ revision }) {
      attempts += 1;
      if (attempts === 1) throw new Error("worker unavailable");
      return { revision, matches: [] };
    },
  });
  matcher.setRevision(4);

  const failed = matcher.match([identity("retryable")]);
  frames.flushNext();
  await settle();
  strictEqual(await failed, "unavailable");
  const retried = matcher.match([identity("retryable")]);
  frames.flushNext();
  await settle();
  strictEqual(await retried, "unmatched");
  strictEqual(attempts, 2);
});

test("BUG-016 destroy cancels queued work and contains late in-flight responses", async () => {
  const queuedFrames = createFrames();
  let queuedQueries = 0;
  const queuedMatcher = createIdentityBatchMatcher({
    schedule: queuedFrames.schedule,
    async query({ revision }) {
      queuedQueries += 1;
      return { revision, matches: [] };
    },
  });
  queuedMatcher.setRevision(1);
  const queued = queuedMatcher.match([identity("queued")]);
  queuedMatcher.destroy();
  queuedFrames.flush();
  strictEqual(await queued, "unavailable");
  strictEqual(queuedQueries, 0);

  const inFlightFrames = createFrames();
  const response = deferred<{
    readonly revision: number;
    readonly matches: readonly BlacklistIdentityQueryDto[];
  }>();
  const inFlightMatcher = createIdentityBatchMatcher({
    schedule: inFlightFrames.schedule,
    async query() {
      return response.promise;
    },
  });
  inFlightMatcher.setRevision(2);
  const inFlight = inFlightMatcher.match([identity("late")]);
  inFlightFrames.flushNext();
  inFlightMatcher.destroy();
  response.resolve({ revision: 2, matches: [identity("late")] });
  await settle();
  strictEqual(await inFlight, "unavailable");
});
