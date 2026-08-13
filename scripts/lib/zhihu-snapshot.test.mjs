import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { buildLocalRawSamples } from "./zhihu-snapshot.mjs";
import { rawSample } from "./zhihu-test-fixtures.mjs";

test("preserves only the allowed real author and member contract", () => {
  const [sample] = buildLocalRawSamples([rawSample()]);

  strictEqual(sample.contentType, "answer");
  deepStrictEqual(sample.authorIdentity, {
    authorName: "Actual Author",
    author_member_hash_id: "real-member-hash",
    url_token: "real-user-token",
  });
  deepStrictEqual(sample.memberApi, {
    endpoint: "/api/v4/members/real-member-hash",
    ok: true,
    status: 200,
    response: { url_token: "real-user-token" },
  });
  match(sample.html, /class="TopstoryItem"/u);
  match(sample.html, /class="ContentItem AnswerItem"/u);
  match(
    sample.html,
    /data-zop="\{&quot;authorName&quot;:&quot;Actual Author&quot;,&quot;type&quot;:&quot;answer&quot;\}"/u,
  );
  match(
    sample.html,
    /data-za-extra-module="\{&quot;card&quot;:\{&quot;content&quot;:\{&quot;author_member_hash_id&quot;:&quot;real-member-hash&quot;,&quot;type&quot;:&quot;answer&quot;\}\}\}"/u,
  );
  match(sample.html, /href="\/people\/real-user-token"/u);
});

test("excludes unrelated tags, classes, attributes, and data fields", () => {
  const [sample] = buildLocalRawSamples([
    rawSample({
      authorName: "Allowed Real Author",
      structure: {
        tagName: "script",
        classes: ["TopstoryItem", "tracking-class", "cocoon-control"],
        markers: { content: true, author: true, profileLink: false },
        children: [],
      },
    }),
  ]);

  strictEqual(sample.html.startsWith('<div class="TopstoryItem"'), true);
  strictEqual(sample.html.includes("<script"), false);
  strictEqual(sample.html.includes("tracking-class"), false);
  strictEqual(sample.html.includes("cocoon-"), false);
  strictEqual(sample.html.includes("data-secret"), false);
  strictEqual(sample.html.includes("title"), false);
  strictEqual(sample.html.includes("contentId"), false);
  strictEqual(sample.html.includes("questionId"), false);
});

test("omits unavailable identity values and failed member response bodies", () => {
  const [sample] = buildLocalRawSamples([
    rawSample({
      authorName: null,
      profileUserId: null,
      memberResponse: { ok: false, status: 404, urlToken: null },
    }),
  ]);

  deepStrictEqual(sample.authorIdentity, {
    authorName: null,
    author_member_hash_id: "real-member-hash",
    url_token: null,
  });
  deepStrictEqual(sample.memberApi, {
    endpoint: "/api/v4/members/real-member-hash",
    ok: false,
    status: 404,
    response: null,
  });
  strictEqual(sample.html.includes("href="), false);
});
