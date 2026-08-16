import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createMemberUserIdResolver,
  type MemberFetch,
  type MemberFetchResponse,
} from "./resolve-member-user-id.ts";

const MEMBER_HASH = "abcdef0123456789".repeat(2);
const UPPERCASE_MEMBER_HASH = MEMBER_HASH.toUpperCase();

function response(
  ok: boolean,
  value: unknown,
): MemberFetchResponse {
  return {
    ok,
    async json(): Promise<unknown> {
      return value;
    },
  };
}

test("BUG-008 canonicalizes a mixed-case member hash in the GET path", async () => {
  const calls: Array<{
    input: string;
    init: { credentials: "same-origin" };
  }> = [];
  const fetchMember: MemberFetch = async (input, init) => {
    calls.push({ input, init });
    return response(true, { url_token: "  Example-User  " });
  };
  const resolveMemberUserId = createMemberUserIdResolver(fetchMember);

  strictEqual(
    await resolveMemberUserId(UPPERCASE_MEMBER_HASH),
    "Example-User",
  );
  deepStrictEqual(calls, [
    {
      input: `/api/v4/members/${MEMBER_HASH}`,
      init: { credentials: "same-origin" },
    },
  ]);
});

test("rejects invalid member hashes without a request", async () => {
  let fetchCount = 0;
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    fetchCount += 1;
    return response(true, { url_token: "unexpected" });
  });

  strictEqual(await resolveMemberUserId("not-a-member-hash"), null);
  strictEqual(fetchCount, 0);
});

test("returns null for a non-OK response", async () => {
  const resolveMemberUserId = createMemberUserIdResolver(async () =>
    response(false, { url_token: "ignored" })
  );

  strictEqual(await resolveMemberUserId(MEMBER_HASH), null);
});

test("returns null when the fetch rejects", async () => {
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    throw new Error("network unavailable");
  });

  strictEqual(await resolveMemberUserId(MEMBER_HASH), null);
});

test("returns null for invalid JSON or response schema", async () => {
  const invalidJsonResolver = createMemberUserIdResolver(async () => ({
    ok: true,
    async json(): Promise<unknown> {
      throw new SyntaxError("invalid JSON");
    },
  }));
  const invalidSchemaResolver = createMemberUserIdResolver(async () =>
    response(true, { url_token: 42 })
  );

  strictEqual(await invalidJsonResolver(MEMBER_HASH), null);
  strictEqual(await invalidSchemaResolver(MEMBER_HASH), null);
});

test("BUG-008 case variants share one resolver request and success cache key", async () => {
  let fetchCount = 0;
  let releaseResponse: ((value: MemberFetchResponse) => void) | undefined;
  const pendingResponse = new Promise<MemberFetchResponse>((resolve) => {
    releaseResponse = resolve;
  });
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    fetchCount += 1;
    return pendingResponse;
  });

  const firstRequest = resolveMemberUserId(UPPERCASE_MEMBER_HASH);
  const secondRequest = resolveMemberUserId(MEMBER_HASH);
  strictEqual(fetchCount, 1);

  releaseResponse?.(response(true, { url_token: "CaseSensitive-Token" }));
  deepStrictEqual(
    await Promise.all([firstRequest, secondRequest]),
    ["CaseSensitive-Token", "CaseSensitive-Token"],
  );
  strictEqual(
    await resolveMemberUserId(UPPERCASE_MEMBER_HASH),
    "CaseSensitive-Token",
  );
  strictEqual(fetchCount, 1);
});

test("removes a failed in-flight request so a later call retries", async () => {
  let fetchCount = 0;
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      throw new Error("temporary failure");
    }

    return response(true, { url_token: "recovered-user" });
  });

  strictEqual(await resolveMemberUserId(UPPERCASE_MEMBER_HASH), null);
  strictEqual(await resolveMemberUserId(MEMBER_HASH), "recovered-user");
  strictEqual(fetchCount, 2);
});
