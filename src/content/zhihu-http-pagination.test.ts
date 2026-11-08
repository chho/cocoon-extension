import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { fetchZhihuVoters, validateAndNormalizeNextUrl } from "./zhihu-remote-api.ts";

const path = "/api/v4/articles/42/likers";

test("BUG-025 upgrades the exact article HTTP next while preserving the server offset", () => {
  strictEqual(
    validateAndNormalizeNextUrl(
      `http://www.zhihu.com${path}?order=default&offset=20&limit=20`,
      path,
      "default",
    ),
    `https://www.zhihu.com${path}?order=default&offset=20&limit=50`,
  );
});

test("BUG-025 refuses HTTP upgrades outside the verified article contract", () => {
  const cases: [string, string, "default" | null][] = [
    [`http://example.com${path}?order=default`, path, "default"],
    [`http://www.zhihu.com:8080${path}?order=default`, path, "default"],
    [`http://name:secret@www.zhihu.com${path}?order=default`, path, "default"],
    [`http://www.zhihu.com${path}?order=default#fragment`, path, "default"],
    ["http://www.zhihu.com/api/v4/articles/43/likers?order=default", path, "default"],
    [`http://www.zhihu.com${path}?offset=20`, path, "default"],
    [`http://www.zhihu.com${path}?order=newest`, path, "default"],
    [`http://www.zhihu.com${path}?order=default&order=newest`, path, "default"],
    [`http://www.zhihu.com${path}?order=default`, path, null],
    [
      "http://www.zhihu.com/api/v4/answers/42/upvoters?order=default",
      "/api/v4/answers/42/upvoters",
      "default",
    ],
    [
      "http://www.zhihu.com/api/v3/settings/blocked_users?offset=20",
      "/api/v3/settings/blocked_users",
      null,
    ],
  ];
  for (const [next, expectedPath, order] of cases) {
    strictEqual(validateAndNormalizeNextUrl(next, expectedPath, order), null);
  }
});

test("BUG-025 both article sorts continue past HTTP next without sending HTTP or skipping offsets", async () => {
  const offsets: Record<string, number[]> = { default: [], newest: [] };
  const result = await fetchZhihuVoters(
    async (input) => {
      const url = new URL(String(input));
      strictEqual(url.origin, "https://www.zhihu.com");
      strictEqual(url.pathname, path);
      strictEqual(url.searchParams.get("limit"), "50");
      const order = url.searchParams.get("order")!;
      const offset = Number(url.searchParams.get("offset"));
      offsets[order]!.push(offset);
      const size = offset < 40 ? 20 : 1;
      return Response.json({
        data: Array.from({ length: size }, (_, i) => ({
          url_token: `synthetic-${offset + i}`,
          name: "Synthetic",
        })),
        paging: {
          is_end: offset === 40,
          next:
            offset === 40
              ? null
              : `http://www.zhihu.com${path}?order=${order}&limit=20&offset=${offset + 20}`,
        },
      });
    },
    { kind: "article", contentId: "42" },
  );
  strictEqual(result.complete, true);
  strictEqual(result.requestFailures, 0);
  strictEqual(result.fetched, 82);
  strictEqual(result.duplicates, 41);
  deepStrictEqual(
    result.users.map((user) => user.userId).sort(),
    Array.from({ length: 41 }, (_, i) => `synthetic-${i}`).sort(),
  );
  deepStrictEqual(offsets, { default: [0, 20, 40], newest: [0, 20, 40] });
});
