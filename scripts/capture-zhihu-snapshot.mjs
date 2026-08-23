#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  DEFAULT_CHROME_DEVTOOLS_PORT,
  getBrowserWebSocketUrl,
  getBrowserWebSocketUrlFromPort,
  parseChromeDevToolsPort,
  parseSnapshotLimit,
  runCaptureWithClient,
} from "./lib/zhihu-capture-runtime.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(projectRoot, ".pi/browser-snapshots-local/zhihu");

async function main() {
  const sampleLimit = parseSnapshotLimit(
    process.env.COCOON_ZHIHU_SNAPSHOT_LIMIT ?? "3",
  );
  const activePortPath = process.env.COCOON_CHROME_DEVTOOLS_ACTIVE_PORT;
  const webSocketUrl = activePortPath
    ? await getBrowserWebSocketUrl(activePortPath)
    : await getBrowserWebSocketUrlFromPort(
        parseChromeDevToolsPort(
          process.env.COCOON_CHROME_DEVTOOLS_PORT ??
            String(DEFAULT_CHROME_DEVTOOLS_PORT),
        ),
      );
  const client = await CdpClient.connect(webSocketUrl);
  const { outputDirectory, snapshot } = await runCaptureWithClient(client, {
    sampleLimit,
    outputRoot,
  });

  console.log(
    `Wrote local raw Zhihu snapshot containing personal data: ${outputDirectory}\nCaptured ${snapshot.sampleCounts.answer} answer and ${snapshot.sampleCounts.article} article sample(s).`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Zhihu snapshot capture failed: ${message}`);
  process.exitCode = 1;
}
