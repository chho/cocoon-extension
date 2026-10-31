import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGNOSTIC_CHANNEL,
  MAX_EVENTS,
  MAX_INCIDENT_BYTES,
  jsonBytes,
  parseDiagnosticEvent,
  parseDiagnosticIncident,
  parseDiagnosticRequest,
} from "./contract.ts";

const event = { at: 100, kind: "submit", userId: "synthetic-user", authorName: "Synthetic" };
const incident = {
  schemaVersion: 1,
  pageId: "page-1",
  id: "incident-1",
  savedAt: 200,
  reason: "manual",
  truncated: 0,
  events: [event],
};

test("events preserve allowed identity and finite geometry, rejecting extra or invalid fields", () => {
  const value = {
    ...event,
    profileUrl: "https://www.zhihu.com/people/synthetic-user",
    x: -10.5,
    count: 0,
  };
  assert.deepEqual(parseDiagnosticEvent(value), value);
  for (const invalid of [
    { cookie: "secret" },
    { at: NaN },
    { at: -1 },
    { count: 0.5 },
    { node: -1 },
    { x: Infinity },
    { x: 10_000_001 },
    { width: -1 },
    { durationMs: -1 },
    { reason: "raw error" },
    { kind: "network" },
    { userId: "x".repeat(257) },
    { authorName: "x".repeat(201) },
    { hidden: Number.MAX_SAFE_INTEGER + 1 },
    { profileUrl: "https://www.zhihu.com/people/synthetic-user?secret=1" },
    { profileUrl: "https://user@www.zhihu.com/people/synthetic-user" },
    { profileUrl: "https://www.zhihu.com/people/../secret" },
    { profileUrl: "https://www.zhihu.com/people/synthetic-user#hash" },
  ])
    assert.equal(parseDiagnosticEvent({ ...event, ...invalid }), null);
  assert.equal(parseDiagnosticEvent({ kind: "submit" }), null);
  assert.equal(parseDiagnosticEvent({ at: 1 }), null);
});

test("incidents require exact schema, bounded safe identifiers, event count and UTF-8 bytes", () => {
  assert.deepEqual(parseDiagnosticIncident(incident), incident);
  assert.ok(parseDiagnosticIncident({ ...incident, pageId: "-" }));
  for (const invalid of [
    { schemaVersion: 2 },
    { pageId: "bad/path" },
    { id: "x".repeat(81) },
    { savedAt: Infinity },
    { truncated: -1 },
    { reason: "error" },
    { extra: 1 },
    { events: Array.from({ length: MAX_EVENTS + 1 }, () => event) },
    { events: [{ ...event, html: "no" }] },
  ])
    assert.equal(parseDiagnosticIncident({ ...incident, ...invalid }), null);
  const oversized = {
    ...incident,
    events: Array.from({ length: MAX_EVENTS }, () => ({ ...event, authorName: "界".repeat(200) })),
  };
  assert.ok(jsonBytes(oversized) > MAX_INCIDENT_BYTES);
  assert.equal(parseDiagnosticIncident(oversized), null);
  assert.equal(jsonBytes("界"), 5);
});

test("only exact save, clear and prune requests are accepted", () => {
  for (const operation of ["clear", "prune"]) {
    assert.deepEqual(parseDiagnosticRequest({ channel: DIAGNOSTIC_CHANNEL, operation }), {
      channel: DIAGNOSTIC_CHANNEL,
      operation,
    });
    assert.equal(
      parseDiagnosticRequest({ channel: DIAGNOSTIC_CHANNEL, operation, incident }),
      null,
    );
  }
  const save = { channel: DIAGNOSTIC_CHANNEL, operation: "save", incident };
  assert.deepEqual(parseDiagnosticRequest(save), save);
  assert.equal(parseDiagnosticRequest({ ...save, extra: true }), null);
  assert.equal(parseDiagnosticRequest({ channel: DIAGNOSTIC_CHANNEL, operation: "read" }), null);
  assert.equal(parseDiagnosticRequest({ ...save, channel: "other" }), null);
});
