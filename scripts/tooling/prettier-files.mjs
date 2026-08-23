import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { format, resolveConfig } from "prettier";

import { hashContent } from "./format-baseline.mjs";
import { isMaintainedFormatPath, normalizeProjectPath } from "./project-scope.mjs";

async function collectFiles(directory, projectRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const projectPath = normalizeProjectPath(relative(projectRoot, absolutePath));
    if (entry.isDirectory()) {
      if (isMaintainedFormatPath(`${projectPath}/placeholder.ts`)) {
        files.push(...(await collectFiles(absolutePath, projectRoot)));
      }
    } else if (entry.isFile() && isMaintainedFormatPath(projectPath)) {
      files.push(absolutePath);
    }
  }

  return files;
}

export async function collectFormatTargets(projectRoot) {
  return (await collectFiles(projectRoot, projectRoot)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export async function inspectFormatFiles(projectRoot, absolutePaths) {
  const config = await resolveConfig(resolve(projectRoot, "package.json"));
  return Promise.all(
    absolutePaths.map(async (absolutePath) => {
      const source = await readFile(absolutePath, "utf8");
      const formatted = await format(source, { ...config, filepath: absolutePath });
      return {
        absolutePath,
        path: normalizeProjectPath(relative(projectRoot, absolutePath)),
        source,
        formatted,
        hash: hashContent(source),
        unformatted: source !== formatted,
      };
    }),
  );
}
