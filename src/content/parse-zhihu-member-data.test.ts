import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  parseAuthorMemberHashId,
  parseMemberUrlToken,
} from "./parse-zhihu-member-data.ts";

test("parses the author member hash from verified card metadata", () => {
  strictEqual(
    parseAuthorMemberHashId(
      JSON.stringify({
        card: {
          content: {
            author_member_hash_id: "8dbd2b230c49f1cd101d305b8bd521ec",
          },
        },
      }),
    ),
    "8dbd2b230c49f1cd101d305b8bd521ec",
  );
});

test("trims a non-empty author member hash", () => {
  strictEqual(
    parseAuthorMemberHashId(
      '{"card":{"content":{"author_member_hash_id":"  member-hash  "}}}',
    ),
    "member-hash",
  );
});

test("rejects malformed or incomplete card metadata", () => {
  strictEqual(parseAuthorMemberHashId("not JSON"), null);
  strictEqual(parseAuthorMemberHashId("{}"), null);
  strictEqual(
    parseAuthorMemberHashId(
      '{"card":{"content":{"author_member_hash_id":"   "}}}',
    ),
    null,
  );
  strictEqual(
    parseAuthorMemberHashId(
      '{"card":{"content":{"author_member_hash_id":123}}}',
    ),
    null,
  );
});

test("parses and trims a member API url_token", () => {
  strictEqual(parseMemberUrlToken({ url_token: "  rev-87  " }), "rev-87");
});

test("rejects invalid member API response schemas", () => {
  strictEqual(parseMemberUrlToken(null), null);
  strictEqual(parseMemberUrlToken({}), null);
  strictEqual(parseMemberUrlToken({ url_token: "   " }), null);
  strictEqual(parseMemberUrlToken({ url_token: 87 }), null);
});
