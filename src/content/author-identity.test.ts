import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { resolveProvenAuthorIdentity } from "./author-identity.ts";

const HASH = "abcdef0123456789".repeat(2);
const MIXED_HASH = HASH.toUpperCase();

test("BUG-008 card profile token plus metadata hash saves both without a GET", async () => {
  let requests = 0;
  const identity = await resolveProvenAuthorIdentity(
    { profileUserId: "Profile-Token", memberHashId: MIXED_HASH },
    async () => {
      requests += 1;
      return "unexpected";
    },
  );
  deepStrictEqual(identity, { userId: "Profile-Token", memberHashId: HASH });
  strictEqual(requests, 0);
});

test("BUG-008 metadata-only card canonicalizes commit evidence before resolving and storing", async () => {
  const identity = await resolveProvenAuthorIdentity(
    { profileUserId: null, memberHashId: MIXED_HASH },
    async (memberHashId) => memberHashId === HASH ? "Canonical-Token" : null,
  );
  deepStrictEqual(identity, { userId: "Canonical-Token", memberHashId: HASH });
});

test("BUG-008 profile-only card stores a null hash without changing ordinary token case", async () => {
  const identity = await resolveProvenAuthorIdentity(
    { profileUserId: "Profile-Token", memberHashId: null },
    async () => {
      throw new Error("Profile-only evidence must not request a member.");
    },
  );
  deepStrictEqual(identity, { userId: "Profile-Token", memberHashId: null });
});

test("BUG-008 canonicalizes a 32-hex profile segment only after a different token is proven", async () => {
  const identity = await resolveProvenAuthorIdentity(
    { profileUserId: MIXED_HASH, memberHashId: null },
    async (memberHashId) => memberHashId === HASH ? "canonical-token" : null,
  );
  deepStrictEqual(identity, { userId: "canonical-token", memberHashId: HASH });
});

test("BUG-008 hash-shaped profile evidence fails closed without a distinct canonical token", async () => {
  for (const resolved of [null, MIXED_HASH]) {
    const identity = await resolveProvenAuthorIdentity(
      { profileUserId: MIXED_HASH, memberHashId: null },
      async () => resolved,
    );
    strictEqual(identity, null);
  }
});
