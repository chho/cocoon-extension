import {
  deepStrictEqual,
  match,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import {
  createSnapshot,
  DEFAULT_CHROME_DEVTOOLS_PORT,
  getBrowserWebSocketUrlFromPort,
  parseActivePort,
  parseChromeDevToolsPort,
  parseSnapshotLimit,
  runCaptureWithClient,
  selectExactZhihuTarget,
  writeSnapshot,
} from "./zhihu-capture-runtime.mjs";
import { validateCaptureResult } from "./zhihu-capture-schema.mjs";
import { EXACT_ZHIHU_URL } from "./zhihu-page-capture.mjs";
import { buildLocalRawSamples } from "./zhihu-snapshot.mjs";
import { validCapture } from "./zhihu-test-fixtures.mjs";

const exactTarget = {
  targetId: "target-1",
  type: "page",
  url: EXACT_ZHIHU_URL,
};

class FakeClient {
  constructor({ capture = validCapture(), detachError = null } = {}) {
    this.capture = capture;
    this.detachError = detachError;
    this.commands = [];
    this.closed = 0;
  }

  async command(method, params = {}, sessionId) {
    this.commands.push({ method, params, sessionId });
    switch (method) {
      case "Browser.getVersion":
        return { product: "Chrome/140" };
      case "Target.getTargets":
        return { targetInfos: [exactTarget] };
      case "Target.attachToTarget":
        return { sessionId: "session-1" };
      case "Page.getFrameTree":
        return {
          frameTree: { frame: { id: "frame-1", url: EXACT_ZHIHU_URL } },
        };
      case "Page.createIsolatedWorld":
        return { executionContextId: 42 };
      case "Runtime.evaluate":
        return { result: { value: this.capture } };
      case "Target.detachFromTarget":
        if (this.detachError) throw this.detachError;
        return {};
      default:
        throw new Error(`Unexpected command: ${method}`);
    }
  }

  async close() {
    this.closed += 1;
  }
}

function makeSnapshot(capturedAt = "2026-01-02T03:04:05.000Z") {
  const capture = validateCaptureResult(validCapture());
  return createSnapshot(
    capturedAt,
    "Chrome/140",
    capture,
    buildLocalRawSamples(capture.samples),
  );
}

test("parses only complete decimal ActivePort values", () => {
  deepStrictEqual(parseActivePort("9222\n/devtools/browser/abc-123\n"), {
    port: 9222,
    browserPath: "/devtools/browser/abc-123",
  });

  for (const contents of [
    "9222junk\n/devtools/browser/abc",
    " 9222\n/devtools/browser/abc",
    "0\n/devtools/browser/abc",
    "65536\n/devtools/browser/abc",
    "9222\n/devtools/page/abc",
    "9222\n/devtools/browser/abc\nextra",
  ]) {
    throws(() => parseActivePort(contents), /decimal|malformed|through/u);
  }
});

test("parses only complete decimal snapshot limits", () => {
  strictEqual(parseSnapshotLimit("3"), 3);
  for (const source of ["3junk", "3.0", " 3", "0", "11", "-1", ""]) {
    throws(() => parseSnapshotLimit(source), /COCOON_ZHIHU_SNAPSHOT_LIMIT/u);
  }
});

test("uses 9223 as the default Chrome DevTools port", () => {
  strictEqual(DEFAULT_CHROME_DEVTOOLS_PORT, 9223);
  strictEqual(parseChromeDevToolsPort(), 9223);
  strictEqual(parseChromeDevToolsPort("9224"), 9224);
  for (const source of ["9223junk", " 9223", "0", "65536", "-1", ""]) {
    throws(() => parseChromeDevToolsPort(source), /COCOON_CHROME_DEVTOOLS_PORT/u);
  }
});

test("discovers only the requested local Browser WebSocket", async () => {
  const requests = [];
  const webSocketUrl = await getBrowserWebSocketUrlFromPort(
    9223,
    async (url, options) => {
      requests.push({ url, hasSignal: options.signal instanceof AbortSignal });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            webSocketDebuggerUrl:
              "ws://127.0.0.1:9223/devtools/browser/abc-123",
          };
        },
      };
    },
  );

  strictEqual(
    webSocketUrl,
    "ws://127.0.0.1:9223/devtools/browser/abc-123",
  );
  deepStrictEqual(requests, [
    {
      url: "http://127.0.0.1:9223/json/version",
      hasSignal: true,
    },
  ]);

  strictEqual(
    await getBrowserWebSocketUrlFromPort(80, async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          webSocketDebuggerUrl: "ws://127.0.0.1:80/devtools/browser/abc",
        };
      },
    })),
    "ws://127.0.0.1/devtools/browser/abc",
  );

  for (const invalidUrl of [
    "ws://127.0.0.1:9222/devtools/browser/abc",
    "ws://localhost:9223/devtools/browser/abc",
    "ws://127.0.0.1:9223/devtools/page/abc",
    "wss://127.0.0.1:9223/devtools/browser/abc",
  ]) {
    await rejects(
      getBrowserWebSocketUrlFromPort(9223, async () => ({
        ok: true,
        status: 200,
        async json() {
          return { webSocketDebuggerUrl: invalidUrl };
        },
      })),
      /outside/u,
    );
  }
});

test("reports Chrome DevTools discovery failures without launching a browser", async () => {
  await rejects(
    getBrowserWebSocketUrlFromPort(9223, async () => {
      throw new Error("connection refused");
    }),
    /127\.0\.0\.1:9223.*No browser was launched/u,
  );
  await rejects(
    getBrowserWebSocketUrlFromPort(9223, async () => ({
      ok: false,
      status: 503,
    })),
    /HTTP 503.*No browser was launched/u,
  );
});

test("requires exactly one exact Zhihu page target", () => {
  strictEqual(selectExactZhihuTarget([exactTarget]), exactTarget);
  throws(() => selectExactZhihuTarget([]), /No already-open page/u);
  throws(
    () => selectExactZhihuTarget([exactTarget, { ...exactTarget, targetId: "2" }]),
    /Found 2/u,
  );
  throws(
    () =>
      selectExactZhihuTarget([
        { ...exactTarget, url: "https://www.zhihu.com/question/1" },
      ]),
    /No already-open page/u,
  );
});

test("orchestration captures in an isolated main-frame context", async () => {
  const client = new FakeClient();
  const result = await runCaptureWithClient(client, {
    sampleLimit: 3,
    outputRoot: "/unused",
    capturedAt: "2026-01-02T03:04:05.000Z",
    async writeSnapshotImpl() {
      return "/private/snapshot";
    },
  });

  strictEqual(result.outputDirectory, "/private/snapshot");
  strictEqual(client.closed, 1);
  const isolated = client.commands.find(
    (command) => command.method === "Page.createIsolatedWorld",
  );
  deepStrictEqual(isolated.params, {
    frameId: "frame-1",
    worldName: "CocoonZhihuSnapshot",
  });
  const evaluation = client.commands.find(
    (command) => command.method === "Runtime.evaluate",
  );
  strictEqual(evaluation.params.contextId, 42);
  strictEqual(evaluation.params.returnByValue, true);
  strictEqual(evaluation.params.awaitPromise, true);
  strictEqual(
    client.commands.at(-1).method,
    "Target.detachFromTarget",
  );
});

test("orchestration rejects malformed browser results before writing", async () => {
  const malformedCapture = validCapture();
  malformedCapture.samples[0].unexpected = "browser data";
  const client = new FakeClient({ capture: malformedCapture });
  let writes = 0;

  await rejects(
    runCaptureWithClient(client, {
      sampleLimit: 3,
      outputRoot: "/unused",
      async writeSnapshotImpl() {
        writes += 1;
        return "/private/snapshot";
      },
    }),
    /expected exactly keys/u,
  );
  strictEqual(writes, 0);
  strictEqual(client.closed, 1);
  strictEqual(
    client.commands.some(
      (command) => command.method === "Target.detachFromTarget",
    ),
    true,
  );
});

test("orchestration detaches and closes when writing fails", async () => {
  const client = new FakeClient();
  await rejects(
    runCaptureWithClient(client, {
      sampleLimit: 3,
      outputRoot: "/unused",
      async writeSnapshotImpl() {
        throw new Error("injected write failure");
      },
    }),
    /injected write failure/u,
  );

  strictEqual(
    client.commands.some(
      (command) => command.method === "Target.detachFromTarget",
    ),
    true,
  );
  strictEqual(client.closed, 1);
});

test("orchestration still closes when detach fails", async () => {
  const client = new FakeClient({ detachError: new Error("detach failed") });
  const warnings = [];
  await runCaptureWithClient(client, {
    sampleLimit: 3,
    outputRoot: "/unused",
    async writeSnapshotImpl() {
      return "/private/snapshot";
    },
    onWarning(message) {
      warnings.push(message);
    },
  });

  strictEqual(client.closed, 1);
  strictEqual(warnings.length, 1);
  match(warnings[0], /detach failed/u);
});

test("atomic writer creates private directories and files", async (t) => {
  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "cocoon-snapshot-test-"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const outputRoot = join(temporaryRoot, "cache", "zhihu");
  const snapshot = makeSnapshot();

  const finalDirectory = await writeSnapshot(snapshot, { outputRoot });
  const latestPath = join(outputRoot, "latest.json");
  const snapshotPath = join(finalDirectory, "snapshot.json");
  strictEqual((await fs.stat(outputRoot)).mode & 0o777, 0o700);
  strictEqual((await fs.stat(finalDirectory)).mode & 0o777, 0o700);
  strictEqual((await fs.stat(latestPath)).mode & 0o777, 0o600);
  strictEqual((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
  deepStrictEqual(
    (await fs.readdir(outputRoot)).sort(),
    [basename(finalDirectory), "latest.json"].sort(),
  );
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
  const writtenSnapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  deepStrictEqual(
    {
      schemaVersion: latest.schemaVersion,
      localRaw: latest.localRaw,
      containsPersonalData: latest.containsPersonalData,
      sanitized: latest.sanitized,
    },
    {
      schemaVersion: 3,
      localRaw: true,
      containsPersonalData: true,
      sanitized: undefined,
    },
  );
  strictEqual(writtenSnapshot.localRaw, true);
  strictEqual(writtenSnapshot.containsPersonalData, true);
  strictEqual(Object.hasOwn(writtenSnapshot, "sanitized"), false);
});

test("atomic write failure removes randomized temporary and final paths", async (t) => {
  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "cocoon-snapshot-test-"));
  t.after(async () => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const outputRoot = join(temporaryRoot, "cache");
  const snapshot = makeSnapshot();
  let observedLatestTemporaryDirectory = "";
  const failingFileSystem = {
    ...fs,
    async rename(source, destination) {
      if (basename(source) === "latest.json") {
        observedLatestTemporaryDirectory = basename(dirname(source));
        throw new Error("injected latest rename failure");
      }
      return fs.rename(source, destination);
    },
  };

  await rejects(
    writeSnapshot(snapshot, {
      outputRoot,
      fileSystem: failingFileSystem,
    }),
    /injected latest rename failure/u,
  );
  match(observedLatestTemporaryDirectory, /^\.latest-[A-Za-z0-9]+/u);
  deepStrictEqual(await fs.readdir(outputRoot), []);
});
