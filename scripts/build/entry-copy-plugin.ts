import ts from "typescript";
import type { Plugin } from "vite";

const COPY_NAMESPACES = ["background-copy", "content-copy"] as const;

type CopyNamespace = (typeof COPY_NAMESPACES)[number];

export function entryCopyNamespace(importer: string): CopyNamespace | null {
  const queryIndex = importer.lastIndexOf("?");
  if (queryIndex < 0) return null;
  const query = importer.slice(queryIndex + 1);
  return COPY_NAMESPACES.find((namespace) => query === namespace) ?? null;
}

export function rewriteEntryCopyImports(code: string, namespace: CopyNamespace): string {
  const imports = ts
    .preProcessFile(code, true, true)
    .importedFiles.filter(({ fileName }) => fileName.startsWith(".") && !fileName.includes("?"));
  let rewritten = code;
  for (const imported of imports.reverse()) {
    const insertAt = imported.end + 1;
    rewritten = `${rewritten.slice(0, insertAt)}?${namespace}${rewritten.slice(insertAt)}`;
  }
  return rewritten;
}

export function createEntryCopyPlugin(): Plugin {
  return {
    name: "cocoon-entry-copy",
    enforce: "pre",
    transform(code, id) {
      const namespace = entryCopyNamespace(id);
      if (!namespace) return null;
      return { code: rewriteEntryCopyImports(code, namespace), map: null };
    },
  };
}
