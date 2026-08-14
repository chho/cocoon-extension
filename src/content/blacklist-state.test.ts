import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAG_ID,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  STORAGE_SCHEMA_VERSION,
  createBlacklistTimestamp,
  createInitialState,
  isValidBlacklistTimestamp,
  parseBlacklistState,
  planAuthorCommit,
  planTagDeletion,
  planUpvoterCommit,
  resolveInitializedState,
  runtimeStateAfterPersistence,
  tagLabelKey,
  utf8ByteLength,
  validateNewTagLabel,
  type BlacklistState,
  type CardImage,
  type CommitInput,
} from "./blacklist-state.ts";

const TIMESTAMP = "2026-08-13T12:34:56.789Z";

function imageWithBytes(targetBytes: number): CardImage {
  const prefix = "data:image/webp;base64,";
  return {
    dataUrl: prefix + "a".repeat(targetBytes - utf8ByteLength(prefix)),
    width: 100,
    height: 80,
  };
}

function commitInput(
  state: BlacklistState,
  overrides: Partial<CommitInput> = {},
): CommitInput {
  return {
    userId: "stable-user",
    authorNameAtCapture: "Name",
    tag: state.tags[0],
    isNewTag: false,
    blacklistedAt: TIMESTAMP,
    ...overrides,
  };
}

test("initializes schema v3 with exactly one built-in default tag", () => {
  const state = createInitialState();
  strictEqual(state.schemaVersion, STORAGE_SCHEMA_VERSION);
  deepStrictEqual(state.tags, [{ tagId: DEFAULT_TAG_ID, name: "default" }]);
  deepStrictEqual(state.authors, []);
  strictEqual(parseBlacklistState(undefined).status, "missing");
});

test("uses a valid re-read to preserve state created during initialization", () => {
  const initialRead = parseBlacklistState(undefined);
  const concurrentState: BlacklistState = {
    ...createInitialState(),
    authors: [
      {
        userId: "stable-user",
        authorNameAtCapture: "Name",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  const concurrentRead = parseBlacklistState(concurrentState);
  strictEqual(
    resolveInitializedState(initialRead, concurrentRead),
    concurrentRead.state,
  );
});

test("normalizes tag labels and enforces case-insensitive uniqueness", () => {
  const tags = createInitialState().tags;
  deepStrictEqual(validateNewTagLabel("  Reading  ", tags), {
    normalized: "Reading",
    error: null,
  });
  strictEqual(validateNewTagLabel(" DEFAULT ", tags).error, "duplicate");
  strictEqual(tagLabelKey("  DeFaUlT "), "default");
  strictEqual(validateNewTagLabel("   ", tags).error, "empty");
});

test("counts the 30-character limit by Unicode code points", () => {
  strictEqual(validateNewTagLabel("😀".repeat(30), []).error, null);
  strictEqual(validateNewTagLabel("😀".repeat(31), []).error, "too-long");
});

test("accepts only exact Date.toISOString UTC timestamps", () => {
  strictEqual(isValidBlacklistTimestamp(TIMESTAMP), true);
  strictEqual(isValidBlacklistTimestamp("2026-08-13T12:34:56Z"), false);
  strictEqual(isValidBlacklistTimestamp("2026-08-13T12:34:56.789+00:00"), false);
  strictEqual(isValidBlacklistTimestamp("2026-02-30T12:34:56.789Z"), false);
  strictEqual(isValidBlacklistTimestamp("not-a-date"), false);
  strictEqual(isValidBlacklistTimestamp(null), false);
});

test("creates one timestamp from the injected clock and rejects an invalid clock", () => {
  let clockCalls = 0;
  const timestamp = createBlacklistTimestamp(() => {
    clockCalls += 1;
    return new Date(TIMESTAMP);
  });
  strictEqual(timestamp, TIMESTAMP);
  strictEqual(clockCalls, 1);
  throws(() => createBlacklistTimestamp(() => new Date(Number.NaN)), /Invalid time value/);
});

test("validates v2 state with only exact timestamps or migrated null values", () => {
  const valid: BlacklistState = {
    ...createInitialState(),
    authors: [
      {
        userId: "stable-user",
        authorNameAtCapture: "Display name",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  strictEqual(parseBlacklistState(valid).status, "valid");
  strictEqual(
    parseBlacklistState({
      ...valid,
      authors: [{ ...valid.authors[0], blacklistedAt: null }],
    }).status,
    "valid",
  );
  for (const blacklistedAt of [
    undefined,
    0,
    "2026-08-13",
    "2026-08-13T12:34:56.789+00:00",
    "2026-02-30T12:34:56.789Z",
  ]) {
    strictEqual(
      parseBlacklistState({
        ...valid,
        authors: [{ ...valid.authors[0], blacklistedAt }],
      }).status,
      "malformed",
    );
  }

  const duplicate = {
    ...valid,
    authors: [...valid.authors, { ...valid.authors[0] }],
  };
  const parsed = parseBlacklistState(duplicate);
  strictEqual(parsed.status, "malformed");
  deepStrictEqual(parsed.state.authors, []);
});

test("SOURCE-004 migrates valid schema v1 fields with null times and direct source", () => {
  const image = imageWithBytes(100);
  const legacy = {
    schemaVersion: 1,
    tags: [
      { tagId: DEFAULT_TAG_ID, name: "default" },
      { tagId: "saved", name: "Saved" },
    ],
    authors: [
      {
        userId: "legacy-user",
        authorNameAtCapture: "Legacy name",
        tagId: "saved",
        cardImage: image,
      },
    ],
  };
  const parsed = parseBlacklistState(legacy);
  strictEqual(parsed.status, "migrated");
  deepStrictEqual(parsed.state, {
    schemaVersion: 3,
    tags: legacy.tags,
    authors: [
      { ...legacy.authors[0], blacklistedAt: null, blockSource: "direct" },
    ],
  });
});

test("SOURCE-004 migrates schema v2 losslessly and requires blockSource in v3", () => {
  const v2 = {
    schemaVersion: 2,
    tags: createInitialState().tags,
    authors: [
      {
        userId: "v2-user",
        authorNameAtCapture: "V2 name",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
        cardImage: imageWithBytes(100),
      },
    ],
  };
  const migrated = parseBlacklistState(v2);
  strictEqual(migrated.status, "migrated");
  deepStrictEqual(migrated.state.authors, [
    { ...v2.authors[0], blockSource: "direct" },
  ]);

  strictEqual(
    parseBlacklistState({
      ...createInitialState(),
      authors: [{ ...v2.authors[0] }],
    }).status,
    "malformed",
  );
});

test("SOURCE-003 rejects a v3 upvoter record without a success timestamp", () => {
  strictEqual(
    parseBlacklistState({
      ...createInitialState(),
      authors: [
        {
          userId: "voter-user",
          authorNameAtCapture: "Voter",
          tagId: DEFAULT_TAG_ID,
          blacklistedAt: null,
          blockSource: "upvoter",
        },
      ],
    }).status,
    "malformed",
  );
});

test("rejects invalid schemas, unknown tags, and non-WebP images safely", () => {
  strictEqual(parseBlacklistState({ schemaVersion: 999 }).status, "malformed");
  strictEqual(
    parseBlacklistState({
      ...createInitialState(),
      authors: [
        {
          userId: "stable-user",
          authorNameAtCapture: "Name",
          tagId: "missing",
          blacklistedAt: TIMESTAMP,
        },
      ],
    }).status,
    "malformed",
  );
  strictEqual(
    parseBlacklistState({
      ...createInitialState(),
      authors: [
        {
          userId: "stable-user",
          authorNameAtCapture: "Name",
          tagId: DEFAULT_TAG_ID,
          blacklistedAt: TIMESTAMP,
          cardImage: { dataUrl: "data:image/png;base64,x", width: 1, height: 1 },
        },
      ],
    }).status,
    "malformed",
  );
});

test("plans one record per stable user and preserves its first timestamp", () => {
  const initial = createInitialState();
  const first = planAuthorCommit(initial, commitInput(initial));
  strictEqual(first.status, "ready");
  if (first.status !== "ready") return;
  strictEqual(first.withImage.authors[0]?.blacklistedAt, TIMESTAMP);

  const duplicate = planAuthorCommit(
    first.withImage,
    commitInput(first.withImage, {
      authorNameAtCapture: "Changed name",
      blacklistedAt: "2027-01-01T00:00:00.000Z",
      cardImage: imageWithBytes(100),
    }),
  );
  strictEqual(duplicate.status, "duplicate");
  if (duplicate.status !== "duplicate") return;
  strictEqual(duplicate.state, first.withImage);
  strictEqual(duplicate.state.authors[0]?.blacklistedAt, TIMESTAMP);
});

test("does not deduplicate different stable IDs that share a display name", () => {
  const initial = createInitialState();
  const first = planAuthorCommit(
    initial,
    commitInput(initial, { userId: "stable-a", authorNameAtCapture: "Same" }),
  );
  if (first.status !== "ready") throw new Error("Expected ready plan.");
  const second = planAuthorCommit(
    first.withImage,
    commitInput(first.withImage, {
      userId: "stable-b",
      authorNameAtCapture: "Same",
    }),
  );
  strictEqual(second.status, "ready");
  if (second.status !== "ready") return;
  strictEqual(second.withImage.authors.length, 2);
});

test("adds a valid new tag and its author in the same commit plan", () => {
  const initial = createInitialState();
  const plan = planAuthorCommit(
    initial,
    commitInput(initial, {
      tag: { tagId: "tag-local", name: "Reading" },
      isNewTag: true,
    }),
  );
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  strictEqual(plan.withoutImage.tags.length, 2);
  strictEqual(plan.withoutImage.authors[0]?.tagId, "tag-local");
});

test("rejects malformed new-author timestamps", () => {
  const initial = createInitialState();
  strictEqual(
    planAuthorCommit(initial, commitInput(initial, { blacklistedAt: "bad" })).status,
    "invalid",
  );
});

test("omits images over the per-image limit", () => {
  const initial = createInitialState();
  const plan = planAuthorCommit(
    initial,
    commitInput(initial, { cardImage: imageWithBytes(MAX_IMAGE_BYTES + 1) }),
  );
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  strictEqual(plan.imageIncluded, false);
  strictEqual(plan.withImage.authors[0]?.cardImage, undefined);
});

test("keeps old images and omits a new image when the total budget is exhausted", () => {
  const image = imageWithBytes(MAX_IMAGE_BYTES);
  const fullImages = Math.floor(MAX_TOTAL_IMAGE_BYTES / MAX_IMAGE_BYTES);
  const authors = Array.from({ length: fullImages }, (_, index) => ({
    userId: `stable-${index}`,
    authorNameAtCapture: "Name",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct" as const,
    cardImage: image,
  }));
  authors.push({
    userId: "stable-remainder",
    authorNameAtCapture: "Name",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "direct",
    cardImage: imageWithBytes(
      MAX_TOTAL_IMAGE_BYTES - fullImages * MAX_IMAGE_BYTES,
    ),
  });
  const fullState: BlacklistState = { ...createInitialState(), authors };
  const plan = planAuthorCommit(
    fullState,
    commitInput(fullState, {
      userId: "new-stable-user",
      cardImage: imageWithBytes(100),
    }),
  );
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  strictEqual(plan.imageIncluded, false);
  strictEqual(plan.withoutImage.authors.slice(0, -1)[0]?.cardImage, image);
});

test("deleting a tag atomically migrates authors and preserves every other field", () => {
  const image = imageWithBytes(100);
  const state: BlacklistState = {
    ...createInitialState(),
    tags: [
      ...createInitialState().tags,
      { tagId: "remove", name: "Remove" },
      { tagId: "keep", name: "Keep" },
    ],
    authors: [
      {
        userId: "move",
        authorNameAtCapture: "Move",
        tagId: "remove",
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
        cardImage: image,
      },
      {
        userId: "keep",
        authorNameAtCapture: "Keep",
        tagId: "keep",
        blacklistedAt: null,
        blockSource: "direct",
      },
    ],
  };
  const plan = planTagDeletion(state, "remove");
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  deepStrictEqual(plan.state.tags.map((tag) => tag.tagId), ["default", "keep"]);
  deepStrictEqual(plan.state.authors, [
    { ...state.authors[0], tagId: DEFAULT_TAG_ID },
    state.authors[1],
  ]);
});

test("SOURCE-001/002 plans minimal upvoter records with strict source and no image", () => {
  const state = createInitialState();
  const plan = planUpvoterCommit(state, {
    userId: "voter-user",
    authorNameAtCapture: "Voter name",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
  });
  strictEqual(plan.status, "ready");
  if (plan.status !== "ready") return;
  deepStrictEqual(plan.withoutImage.authors[0], {
    userId: "voter-user",
    authorNameAtCapture: "Voter name",
    tagId: DEFAULT_TAG_ID,
    blacklistedAt: TIMESTAMP,
    blockSource: "upvoter",
  });
  strictEqual(plan.imageIncluded, false);
  strictEqual(
    planUpvoterCommit(plan.withoutImage, {
      userId: "voter-user",
      authorNameAtCapture: "Changed",
      tagId: DEFAULT_TAG_ID,
      blacklistedAt: "2027-01-01T00:00:00.000Z",
    }).status,
    "duplicate",
  );
});

test("default deletion is protected in storage logic", () => {
  const state = createInitialState();
  const plan = planTagDeletion(state, DEFAULT_TAG_ID);
  strictEqual(plan.status, "protected");
  strictEqual(plan.state, state);
});

test("only advances runtime state after persistence succeeds", () => {
  const previous = createInitialState();
  const candidate: BlacklistState = {
    ...previous,
    authors: [
      {
        userId: "stable-user",
        authorNameAtCapture: "Name",
        tagId: DEFAULT_TAG_ID,
        blacklistedAt: TIMESTAMP,
        blockSource: "direct",
      },
    ],
  };
  strictEqual(runtimeStateAfterPersistence(previous, candidate, false), previous);
  strictEqual(runtimeStateAfterPersistence(previous, candidate, true), candidate);
});
