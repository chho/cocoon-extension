import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  STORAGE_SCHEMA_VERSION,
  createBlacklistTimestamp,
  createInitialState,
  isMemberHashId,
  isValidBlacklistTimestamp,
  normalizeMemberHashId,
  parseBlacklistState,
  planAuthorCommit,
  planMemberHashBackfill,
  planTagDeletion,
  planUpvoterCommit,
  resolveInitializedState,
  runtimeStateAfterPersistence,
  tagLabelKey,
  validateNewTagLabel,
  type BlacklistState,
  type CommitInput,
} from "./blacklist-state.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";
const HASH_A = "a".repeat(32);
const HASH_B = "b".repeat(32);
const MIXED_HASH = "aBcDeF0123456789".repeat(2);
const CANONICAL_MIXED_HASH = MIXED_HASH.toLowerCase();

function commitInput(
  state: BlacklistState,
  overrides: Partial<CommitInput> = {},
): CommitInput {
  return {
    userId: "stable-user",
    memberHashId: null,
    authorNameAtCapture: "Name",
    tag: state.tags[0]!,
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
    ...overrides,
  };
}

function author(
  userId: string,
  memberHashId: string | null = null,
) {
  return {
    userId,
    memberHashId,
    authorNameAtCapture: `Name ${userId}`,
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct" as const,
  };
}

test("CAP-007 initializes strict schema v4 with one built-in tag", () => {
  const state = createInitialState();
  strictEqual(state.schemaVersion, STORAGE_SCHEMA_VERSION);
  strictEqual(STORAGE_SCHEMA_VERSION, 4);
  deepStrictEqual(state.tags, [{ tagId: DEFAULT_TAG_ID, name: "default" }]);
  deepStrictEqual(state.authors, []);
  strictEqual(parseBlacklistState(undefined).status, "missing");
});

test("uses a valid re-read to preserve state created during initialization", () => {
  const initialRead = parseBlacklistState(undefined);
  const concurrentState: BlacklistState = {
    ...createInitialState(),
    authors: [author("stable-user")],
  };
  const concurrentRead = parseBlacklistState(concurrentState);
  strictEqual(resolveInitializedState(initialRead, concurrentRead), concurrentRead.state);
});

test("normalizes tag labels and validates timestamps and member hashes", () => {
  const tags = createInitialState().tags;
  deepStrictEqual(validateNewTagLabel("  Reading  ", tags), {
    normalized: "Reading",
    error: null,
  });
  strictEqual(validateNewTagLabel(" DEFAULT ", tags).error, "duplicate");
  strictEqual(tagLabelKey("  DeFaUlT "), "default");
  strictEqual(validateNewTagLabel("😀".repeat(31), []).error, "too-long");
  strictEqual(isValidBlacklistTimestamp(TIMESTAMP), true);
  strictEqual(isValidBlacklistTimestamp("2026-08-13T12:34:56Z"), false);
  strictEqual(isMemberHashId(HASH_A), true);
  strictEqual(isMemberHashId(MIXED_HASH), true);
  strictEqual(isMemberHashId("not-a-hash"), false);
  strictEqual(normalizeMemberHashId(MIXED_HASH), CANONICAL_MIXED_HASH);
  strictEqual(normalizeMemberHashId("CaseSensitive-Token"), null);
});

test("creates one timestamp from the injected clock", () => {
  let calls = 0;
  strictEqual(createBlacklistTimestamp(() => {
    calls += 1;
    return new Date(TIMESTAMP);
  }), TIMESTAMP);
  strictEqual(calls, 1);
  throws(() => createBlacklistTimestamp(() => new Date(Number.NaN)), /Invalid time value/);
});

test("CAP-007 migrates v1/v2/v3 to v4, discards untrusted legacy image data, and is idempotent", () => {
  const legacyImageKey = `card${"Image"}`;
  for (const schemaVersion of [1, 2, 3] as const) {
    const legacyAuthor: Record<string, unknown> = {
      userId: `legacy-${schemaVersion}`,
      authorNameAtCapture: "Legacy",
      tagId: DEFAULT_TAG_ID,
      [legacyImageKey]: { invalid: true },
    };
    if (schemaVersion >= 2) {
      legacyAuthor.blacklistedAt = TIMESTAMP;
    }
    if (schemaVersion === 3) {
      legacyAuthor.blockSource = "upvoter";
    }
    const parsed = parseBlacklistState({
      schemaVersion,
      tags: createInitialState().tags,
      authors: [legacyAuthor],
    });
    strictEqual(parsed.status, "migrated");
    deepStrictEqual(parsed.state.authors[0], {
      userId: `legacy-${schemaVersion}`,
      memberHashId: null,
      authorNameAtCapture: "Legacy",
      tagId: DEFAULT_TAG_ID,
      blacklistedAt: schemaVersion === 1 ? null : TIMESTAMP,
      blockSource: schemaVersion === 3 ? "upvoter" : "direct",
    });
    strictEqual(legacyImageKey in parsed.state.authors[0]!, false);
    deepStrictEqual(parseBlacklistState(parsed.state), {
      status: "valid",
      state: parsed.state,
    });
  }
});

test("v4 requires exact author fields and valid source/timestamp/hash values", () => {
  const valid = { ...createInitialState(), authors: [author("valid", HASH_A)] };
  strictEqual(parseBlacklistState(valid).status, "valid");
  for (const changedAuthor of [
    { ...author("valid"), memberHashId: undefined },
    { ...author("valid"), memberHashId: "bad" },
    { ...author("valid"), unknown: true },
    { ...author("valid"), blacklistedAt: "bad" },
  ]) {
    strictEqual(parseBlacklistState({ ...valid, authors: [changedAuthor] }).status, "malformed");
  }
});

test("v4 rejects duplicate identifiers and all cross-record identifier collisions", () => {
  for (const authors of [
    [author("same"), author("same")],
    [author("first", HASH_A), author("second", HASH_A)],
    [author("first", MIXED_HASH), author("second", CANONICAL_MIXED_HASH)],
    [author("first", MIXED_HASH), author(CANONICAL_MIXED_HASH, HASH_B)],
    [author("first", HASH_A), author(HASH_A, HASH_B)],
    [author(HASH_A, HASH_A)],
  ]) {
    const parsed = parseBlacklistState({ ...createInitialState(), authors });
    strictEqual(parsed.status, "malformed");
    deepStrictEqual(parsed.state.authors, []);
  }
});

test("BUG-008 v4 normalizes mixed-case hashes for migration while preserving ordinary token case", () => {
  const parsed = parseBlacklistState({
    ...createInitialState(),
    authors: [author("CaseSensitive-Token", MIXED_HASH)],
  });
  strictEqual(parsed.status, "migrated");
  deepStrictEqual(parsed.state.authors[0], {
    ...author("CaseSensitive-Token", CANONICAL_MIXED_HASH),
  });
  deepStrictEqual(parseBlacklistState(parsed.state), {
    status: "valid",
    state: parsed.state,
  });

  const caseSensitiveTokens = parseBlacklistState({
    ...createInitialState(),
    authors: [author("TokenCase"), author("tokencase")],
  });
  strictEqual(caseSensitiveTokens.status, "valid");
  deepStrictEqual(
    caseSensitiveTokens.state.authors.map(({ userId }) => userId),
    ["TokenCase", "tokencase"],
  );
});

test("plans new direct records with hash-or-null and never merges by display name", () => {
  const initial = createInitialState();
  const first = planAuthorCommit(initial, commitInput(initial, {
    userId: "stable-a",
    memberHashId: MIXED_HASH,
    authorNameAtCapture: "Same",
  }));
  strictEqual(first.status, "ready");
  if (first.status !== "ready") return;
  deepStrictEqual(first.state.authors[0], {
    ...author("stable-a", CANONICAL_MIXED_HASH),
    authorNameAtCapture: "Same",
  });

  const second = planAuthorCommit(first.state, commitInput(first.state, {
    userId: "stable-b",
    memberHashId: null,
    authorNameAtCapture: "Same",
  }));
  strictEqual(second.status, "ready");
  if (second.status !== "ready") return;
  strictEqual(second.state.authors.length, 2);
});

test("exact duplicate atomically backfills a nonconflicting hash and preserves every existing field", () => {
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [{ ...author("stable-user"), authorNameAtCapture: "First" }],
  };
  const plan = planAuthorCommit(state, commitInput(state, {
    memberHashId: HASH_A,
    authorNameAtCapture: "Changed",
    blacklistedAt: "2027-01-01T00:00:00.000Z",
  }));
  strictEqual(plan.status, "backfill");
  if (plan.status !== "backfill") return;
  deepStrictEqual(plan.state.authors[0], {
    ...state.authors[0],
    memberHashId: HASH_A,
  });
});

test("duplicate alias conflicts fail safely without changing state", () => {
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [author("stable-user"), author("other-user", HASH_A)],
  };
  for (const memberHashId of [HASH_A, HASH_B]) {
    const source = memberHashId === HASH_B
      ? { ...state, authors: [author("stable-user", HASH_A)] }
      : state;
    const plan = planAuthorCommit(source, commitInput(source, { memberHashId }));
    strictEqual(plan.status, "invalid");
    strictEqual(plan.state, source);
  }
});

test("focused member hash backfill requires exact token ownership and stores a canonical hash", () => {
  const state: BlacklistState = {
    ...createInitialState(),
    authors: [author("token"), author("other", HASH_B)],
  };
  strictEqual(planMemberHashBackfill(state, "missing", HASH_A).status, "invalid");
  strictEqual(planMemberHashBackfill(state, "token", HASH_B).status, "invalid");
  const ready = planMemberHashBackfill(state, "token", MIXED_HASH);
  strictEqual(ready.status, "ready");
  if (ready.status !== "ready") return;
  deepStrictEqual(ready.state.authors[0], {
    ...state.authors[0],
    memberHashId: CANONICAL_MIXED_HASH,
  });
});

test("adds a valid new tag and author in one plan", () => {
  const initial = createInitialState();
  const plan = planAuthorCommit(initial, commitInput(initial, {
    tag: { tagId: "tag-local", name: "Reading" },
    isNewTag: true,
  }));
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  strictEqual(plan.state.tags.length, 2);
  strictEqual(plan.state.authors[0]?.tagId, "tag-local");
});

test("tag deletion preserves member hash and every non-tag author field", () => {
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [...createInitialState().tags, { tagId: "remove", name: "Remove" }],
    authors: [{ ...author("move", HASH_A), tagId: "remove" }],
  };
  const plan = planTagDeletion(state, "remove");
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  deepStrictEqual(plan.state.authors[0], {
    ...state.authors[0],
    tagId: DEFAULT_TAG_ID,
  });
});

test("historical upvoter flow creates a v4-compatible null-hash record", () => {
  const state = createInitialState();
  const plan = planUpvoterCommit(state, {
    userId: "voter-user",
    authorNameAtCapture: "Voter",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
  });
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  deepStrictEqual(plan.state.authors[0], {
    userId: "voter-user",
    memberHashId: null,
    authorNameAtCapture: "Voter",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "upvoter",
  });
});

test("only advances runtime state after persistence succeeds", () => {
  const previous = createInitialState();
  const candidate: BlacklistState = { ...previous, authors: [author("stable-user")] };
  strictEqual(runtimeStateAfterPersistence(previous, candidate, false), previous);
  strictEqual(runtimeStateAfterPersistence(previous, candidate, true), candidate);
});
