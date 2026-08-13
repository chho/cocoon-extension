import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  createMemberUserIdResolver,
  type MemberFetch,
  type MemberFetchResponse,
} from "./resolve-member-user-id.ts";

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

test("requests the encoded member endpoint and returns a valid trimmed ID", async () => {
  const calls: Array<{
    input: string;
    init: { credentials: "same-origin" };
  }> = [];
  const fetchMember: MemberFetch = async (input, init) => {
    calls.push({ input, init });
    return response(true, { url_token: "  example-user  " });
  };
  const resolveMemberUserId = createMemberUserIdResolver(fetchMember);

  strictEqual(await resolveMemberUserId("hash/with spaces"), "example-user");
  deepStrictEqual(calls, [
    {
      input: "/api/v4/members/hash%2Fwith%20spaces",
      init: { credentials: "same-origin" },
    },
  ]);
});

test("returns null for a non-OK response", async () => {
  const resolveMemberUserId = createMemberUserIdResolver(async () =>
    response(false, { url_token: "ignored" }),
  );

  strictEqual(await resolveMemberUserId("member-hash"), null);
});

test("returns null when the fetch rejects", async () => {
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    throw new Error("network unavailable");
  });

  strictEqual(await resolveMemberUserId("member-hash"), null);
});

test("returns null for invalid JSON or response schema", async () => {
  const invalidJsonResolver = createMemberUserIdResolver(async () => ({
    ok: true,
    async json(): Promise<unknown> {
      throw new SyntaxError("invalid JSON");
    },
  }));
  const invalidSchemaResolver = createMemberUserIdResolver(async () =>
    response(true, { url_token: 42 }),
  );

  strictEqual(await invalidJsonResolver("invalid-json"), null);
  strictEqual(await invalidSchemaResolver("invalid-schema"), null);
});

test("caches a successful member ID", async () => {
  let fetchCount = 0;
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    fetchCount += 1;
    return response(true, { url_token: "cached-user" });
  });

  strictEqual(await resolveMemberUserId("member-hash"), "cached-user");
  strictEqual(await resolveMemberUserId("member-hash"), "cached-user");
  strictEqual(fetchCount, 1);
});

test("deduplicates concurrent requests for the same member hash", async () => {
  let fetchCount = 0;
  let releaseResponse: ((value: MemberFetchResponse) => void) | undefined;
  const pendingResponse = new Promise<MemberFetchResponse>((resolve) => {
    releaseResponse = resolve;
  });
  const resolveMemberUserId = createMemberUserIdResolver(async () => {
    fetchCount += 1;
    return pendingResponse;
  });

  const firstRequest = resolveMemberUserId("member-hash");
  const secondRequest = resolveMemberUserId("member-hash");
  strictEqual(fetchCount, 1);

  releaseResponse?.(response(true, { url_token: "shared-user" }));
  deepStrictEqual(
    await Promise.all([firstRequest, secondRequest]),
    ["shared-user", "shared-user"],
  );
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

  strictEqual(await resolveMemberUserId("member-hash"), null);
  strictEqual(await resolveMemberUserId("member-hash"), "recovered-user");
  strictEqual(fetchCount, 2);
});
