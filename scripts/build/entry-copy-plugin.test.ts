import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { entryCopyNamespace, rewriteEntryCopyImports } from "./entry-copy-plugin.ts";

test("entry copies propagate only exact build-time namespaces", () => {
  strictEqual(entryCopyNamespace("/src/core/contract.ts?background-copy"), "background-copy");
  strictEqual(entryCopyNamespace("/src/core/contract.ts?content-copy"), "content-copy");
  strictEqual(entryCopyNamespace("/src/core/contract.ts"), null);
  strictEqual(entryCopyNamespace("/src/core/contract.ts?background-copy-extra"), null);
  strictEqual(entryCopyNamespace("/src/core/contract.ts?raw&background-copy"), null);
});

test("entry copies replace another entry namespace without changing asset queries", () => {
  const source = [
    'import source from "./source-post.ts?content-copy";',
    'export { parse } from "./parser.ts?background-copy";',
    'import raw from "./source.ts?raw";',
  ].join("\n");
  strictEqual(
    rewriteEntryCopyImports(source, "background-copy"),
    [
      'import source from "./source-post.ts?background-copy";',
      'export { parse } from "./parser.ts?background-copy";',
      'import raw from "./source.ts?raw";',
    ].join("\n"),
  );
});

test("entry copies recursively namespace relative static imports", () => {
  const source = [
    'import value from "./value.ts";',
    'import type { Shape } from "../shape.ts";',
    'export { helper } from "./helper.ts";',
    'import external from "package";',
    'import raw from "./raw.ts?raw";',
    "const example = 'from \"./not-an-import.ts\"';",
    '// import "./comment.ts";',
  ].join("\n");
  strictEqual(
    rewriteEntryCopyImports(source, "background-copy"),
    [
      'import value from "./value.ts?background-copy";',
      'import type { Shape } from "../shape.ts?background-copy";',
      'export { helper } from "./helper.ts?background-copy";',
      'import external from "package";',
      'import raw from "./raw.ts?raw";',
      "const example = 'from \"./not-an-import.ts\"';",
      '// import "./comment.ts";',
    ].join("\n"),
  );
});
