import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createBlacklistRevisionSignal,
  parseBlacklistRevisionChange,
  parseBlacklistRevisionSignal,
} from "./blacklist-revision-contract.ts";

test("AC-095 revision signals contain only a strict version and non-negative revision", () => {
  deepStrictEqual(createBlacklistRevisionSignal(7), { version: 1, revision: 7 });
  deepStrictEqual(parseBlacklistRevisionSignal({ version: 1, revision: 7 }), {
    version: 1,
    revision: 7,
  });
  for (const value of [
    null,
    { version: 1, revision: -1 },
    { version: 1, revision: 1.5 },
    { version: 2, revision: 1 },
    { version: 1, revision: 1, authors: [] },
    { version: 1 },
  ]) {
    strictEqual(parseBlacklistRevisionSignal(value), null);
  }
});

test("AC-095 accepts only a valid local revision change hint", () => {
  const signal = { version: 1, revision: 8 };
  deepStrictEqual(
    parseBlacklistRevisionChange(
      { cocoonBlacklistRevision: { oldValue: null, newValue: signal } },
      "local",
    ),
    signal,
  );
  strictEqual(
    parseBlacklistRevisionChange({ cocoonBlacklistState: { newValue: signal } }, "local"),
    null,
  );
  strictEqual(
    parseBlacklistRevisionChange({ cocoonBlacklistRevision: { newValue: signal } }, "sync"),
    null,
  );
  strictEqual(
    parseBlacklistRevisionChange(
      { cocoonBlacklistRevision: { newValue: { ...signal, authors: [] } } },
      "local",
    ),
    null,
  );
});
