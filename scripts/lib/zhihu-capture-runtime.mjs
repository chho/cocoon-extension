import * as fsPromises from "node:fs/promises";
import { join } from "node:path";

import { validateCaptureResult } from "./zhihu-capture-schema.mjs";
import {
  createPageCaptureExpression,
  EXACT_ZHIHU_URL,
} from "./zhihu-page-capture.mjs";
import { buildLocalRawSamples } from "./zhihu-snapshot.mjs";

export const SCHEMA_VERSION = 3;
export const COMMAND_TIMEOUT_MS = 15_000;

export function parseFullDecimal(source, label, minimum, maximum) {
  if (typeof source !== "string" || !/^[0-9]+$/u.test(source)) {
    throw new Error(`${label} must be a complete decimal integer.`);
  }
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function parseSnapshotLimit(source = "3") {
  return parseFullDecimal(
    source,
    "COCOON_ZHIHU_SNAPSHOT_LIMIT",
    1,
    10,
  );
}

export function parseActivePort(contents, activePortPath = "DevToolsActivePort") {
  if (typeof contents !== "string") {
    throw new Error(`Chrome DevToolsActivePort at ${activePortPath} is malformed.`);
  }
  const normalizedContents = contents.replace(/\r?\n$/u, "");
  const lines = normalizedContents.split(/\r?\n/u);
  if (
    lines.length !== 2 ||
    !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(lines[1])
  ) {
    throw new Error(
      `Chrome DevToolsActivePort at ${activePortPath} is malformed; expected a port and /devtools/browser/... path.`,
    );
  }
  const port = parseFullDecimal(lines[0], "Chrome DevTools active port", 1, 65_535);
  return { port, browserPath: lines[1] };
}

export async function getBrowserWebSocketUrl(activePortPath, fileSystem = fsPromises) {
  let contents;
  try {
    contents = await fileSystem.readFile(activePortPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read Chrome DevToolsActivePort at ${activePortPath}. Ensure the user's existing Chrome is running with remote debugging enabled, or set COCOON_CHROME_DEVTOOLS_ACTIVE_PORT to its existing DevToolsActivePort file. No browser was launched. (${reason})`,
    );
  }
  const { port, browserPath } = parseActivePort(contents, activePortPath);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

export function selectExactZhihuTarget(targetInfos) {
  const targets = Array.isArray(targetInfos)
    ? targetInfos.filter(
        (target) =>
          target !== null &&
          typeof target === "object" &&
          target.type === "page" &&
          target.url === EXACT_ZHIHU_URL &&
          typeof target.targetId === "string" &&
          target.targetId.length > 0,
      )
    : [];
  if (targets.length === 0) {
    throw new Error(
      `No already-open page has the exact URL ${EXACT_ZHIHU_URL}. Open it in the existing Chrome and retry; this script will not navigate or refresh a tab.`,
    );
  }
  if (targets.length > 1) {
    throw new Error(
      `Found ${targets.length} already-open pages with the exact URL ${EXACT_ZHIHU_URL}. Leave exactly one open and retry; this script will not close a tab.`,
    );
  }
  return targets[0];
}

export function getEvaluationValue(evaluation) {
  if (evaluation?.exceptionDetails) {
    throw new Error("Snapshot extraction failed in the existing Zhihu page.");
  }
  if (!evaluation?.result || !Object.hasOwn(evaluation.result, "value")) {
    throw new Error("Chrome did not return the snapshot extraction result by value.");
  }
  return evaluation.result.value;
}

function countPresent(samples, selectValue) {
  return samples.reduce(
    (count, sample) => count + (selectValue(sample) ? 1 : 0),
    0,
  );
}

export function createSnapshot(capturedAt, chromeVersion, capture, localRawSamples) {
  const requestedMembers = countPresent(
    capture.samples,
    (sample) => sample.authorMemberHashId,
  );
  const successfulMembers = localRawSamples.filter(
    (sample) => sample.memberApi?.ok && sample.memberApi.response?.url_token,
  ).length;

  return {
    schemaVersion: SCHEMA_VERSION,
    localRaw: true,
    containsPersonalData: true,
    capturedAt,
    sourceUrl: EXACT_ZHIHU_URL,
    chromeVersion,
    sampleCounts: {
      answer: localRawSamples.filter((sample) => sample.contentType === "answer")
        .length,
      article: localRawSamples.filter(
        (sample) => sample.contentType === "article",
      ).length,
      total: localRawSamples.length,
    },
    verified: {
      selectors: {
        ".TopstoryItem": capture.selectorCounts.card,
        ".ContentItem[data-zop]": capture.selectorCounts.content,
        ".AuthorInfo-name, .UserLink-link": capture.selectorCounts.author,
        "author profile link": capture.selectorCounts.profileLink,
      },
      sampledFields: {
        "data-zop.authorName": countPresent(
          capture.samples,
          (sample) => sample.fieldEvidence.dataZopAuthorName,
        ),
        "data-zop.type": countPresent(
          capture.samples,
          (sample) => sample.fieldEvidence.dataZopType,
        ),
        "data-za-extra-module.card.content.author_member_hash_id":
          requestedMembers,
        "member response url_token": successfulMembers,
      },
      endpoint: {
        template: "/api/v4/members/<author_member_hash_id>",
        requested: requestedMembers,
        successful: successfulMembers,
      },
    },
    samples: localRawSamples,
  };
}

export async function writeSnapshot(
  snapshot,
  { outputRoot, fileSystem = fsPromises } = {},
) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0) {
    throw new TypeError("A snapshot output root is required.");
  }
  const timestampName = snapshot.capturedAt.replaceAll(":", "-");
  const finalDirectory = join(outputRoot, timestampName);
  const snapshotJson = `${JSON.stringify(snapshot, null, 2)}\n`;
  let temporaryDirectory;
  let latestTemporaryDirectory;
  let finalCreated = false;

  await fileSystem.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(outputRoot, 0o700);
  try {
    temporaryDirectory = await fileSystem.mkdtemp(join(outputRoot, ".snapshot-"));
    await fileSystem.chmod(temporaryDirectory, 0o700);
    const temporarySnapshotPath = join(temporaryDirectory, "snapshot.json");
    await fileSystem.writeFile(temporarySnapshotPath, snapshotJson, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fileSystem.chmod(temporarySnapshotPath, 0o600);
    await fileSystem.rename(temporaryDirectory, finalDirectory);
    temporaryDirectory = undefined;
    finalCreated = true;
    await fileSystem.chmod(finalDirectory, 0o700);

    latestTemporaryDirectory = await fileSystem.mkdtemp(
      join(outputRoot, ".latest-"),
    );
    await fileSystem.chmod(latestTemporaryDirectory, 0o700);
    const latestTemporaryPath = join(latestTemporaryDirectory, "latest.json");
    const latest = {
      schemaVersion: SCHEMA_VERSION,
      localRaw: true,
      containsPersonalData: true,
      capturedAt: snapshot.capturedAt,
      snapshot: `${timestampName}/snapshot.json`,
    };
    await fileSystem.writeFile(
      latestTemporaryPath,
      `${JSON.stringify(latest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await fileSystem.chmod(latestTemporaryPath, 0o600);
    await fileSystem.rename(latestTemporaryPath, join(outputRoot, "latest.json"));
    finalCreated = false;
    try {
      await fileSystem.rm(latestTemporaryDirectory, {
        recursive: true,
        force: true,
      });
    } catch {
      // The committed files are valid; an empty randomized directory is harmless.
    }
    latestTemporaryDirectory = undefined;
  } catch (error) {
    await Promise.all([
      temporaryDirectory
        ? fileSystem.rm(temporaryDirectory, { recursive: true, force: true })
        : undefined,
      latestTemporaryDirectory
        ? fileSystem.rm(latestTemporaryDirectory, {
            recursive: true,
            force: true,
          })
        : undefined,
      finalCreated
        ? fileSystem.rm(finalDirectory, { recursive: true, force: true })
        : undefined,
    ]);
    throw error;
  }

  return finalDirectory;
}

export async function runCaptureWithClient(
  client,
  {
    sampleLimit,
    outputRoot,
    capturedAt = new Date().toISOString(),
    writeSnapshotImpl = writeSnapshot,
    onWarning = (message) => console.error(message),
  },
) {
  let sessionId;
  try {
    const version = await client.command("Browser.getVersion");
    const targetsResult = await client.command("Target.getTargets");
    const target = selectExactZhihuTarget(targetsResult?.targetInfos);

    const attached = await client.command("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    if (typeof attached?.sessionId !== "string" || !attached.sessionId) {
      throw new Error("Chrome did not return a CDP target session ID.");
    }
    sessionId = attached.sessionId;

    const frameTreeResult = await client.command("Page.getFrameTree", {}, sessionId);
    const mainFrame = frameTreeResult?.frameTree?.frame;
    if (
      typeof mainFrame?.id !== "string" ||
      !mainFrame.id ||
      mainFrame.url !== EXACT_ZHIHU_URL
    ) {
      throw new Error("The selected page changed before isolated capture.");
    }
    const isolatedWorld = await client.command(
      "Page.createIsolatedWorld",
      { frameId: mainFrame.id, worldName: "CocoonZhihuSnapshot" },
      sessionId,
    );
    if (!Number.isSafeInteger(isolatedWorld?.executionContextId)) {
      throw new Error("Chrome did not create an isolated execution context.");
    }

    const evaluation = await client.command(
      "Runtime.evaluate",
      {
        expression: createPageCaptureExpression(sampleLimit),
        contextId: isolatedWorld.executionContextId,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    const captureResult = validateCaptureResult(getEvaluationValue(evaluation));
    if (captureResult.samples.length === 0) {
      throw new Error(
        "The exact Zhihu page is open, but no supported answer or article cards were found; no snapshot was written.",
      );
    }

    const localRawSamples = buildLocalRawSamples(captureResult.samples);
    const chromeVersion =
      typeof version?.product === "string" && version.product.length <= 128
        ? version.product
        : "unknown";
    const snapshot = createSnapshot(
      capturedAt,
      chromeVersion,
      captureResult,
      localRawSamples,
    );
    const outputDirectory = await writeSnapshotImpl(snapshot, { outputRoot });
    return { outputDirectory, snapshot };
  } finally {
    if (sessionId) {
      try {
        await client.command("Target.detachFromTarget", { sessionId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        onWarning(`Warning: could not detach the CDP target cleanly: ${reason}`);
      }
    }
    await client.close();
  }
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      this.rejectPending(new Error("Chrome closed the CDP connection."));
    });
    socket.addEventListener("error", () => {
      this.rejectPending(new Error("The CDP WebSocket connection failed."));
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    try {
      await new Promise((resolveConnection, rejectConnection) => {
        const timer = setTimeout(() => {
          rejectConnection(new Error("Timed out connecting to Chrome CDP."));
        }, COMMAND_TIMEOUT_MS);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolveConnection();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            rejectConnection(new Error("Could not connect to Chrome CDP."));
          },
          { once: true },
        );
      });
    } catch (error) {
      try {
        socket.close();
      } catch {
        // The socket may still be in its initial handshake.
      }
      throw error;
    }
    return new CdpClient(socket);
  }

  async command(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolveResponse, rejectResponse, timer });
    });

    this.socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
    return response;
  }

  handleMessage(data) {
    if (typeof data !== "string") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Number.isInteger(message.id)) return;

    const pendingCommand = this.pending.get(message.id);
    if (!pendingCommand) return;
    this.pending.delete(message.id);
    clearTimeout(pendingCommand.timer);
    if (message.error) {
      pendingCommand.rejectResponse(
        new Error(
          `CDP command ${pendingCommand.method} failed (${message.error.code}): ${message.error.message}`,
        ),
      );
      return;
    }
    pendingCommand.resolveResponse(message.result);
  }

  rejectPending(error) {
    for (const pendingCommand of this.pending.values()) {
      clearTimeout(pendingCommand.timer);
      pendingCommand.rejectResponse(error);
    }
    this.pending.clear();
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolveClose) => {
      const timer = setTimeout(resolveClose, 1_000);
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolveClose();
        },
        { once: true },
      );
      this.socket.close(1000, "Snapshot capture complete");
    });
  }
}
