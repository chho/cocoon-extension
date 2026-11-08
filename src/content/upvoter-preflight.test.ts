import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { indexedDB } from "fake-indexeddb";
import { createBlacklistRepository } from "../background/blacklist-repository.ts";
import { createBlacklistContentController } from "../background/blacklist-content-controller.ts";
import {
  createBlacklistContentRuntimeMessageListener,
  type UiMessageSender,
} from "../background/listeners.ts";
import { createBackgroundBlacklistGateway } from "./background-blacklist-gateway.ts";
import { createBackgroundBlacklistClient } from "./background-blacklist-client.ts";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const TIMESTAMP = "2026-08-25T12:34:56.789Z";
const IDENTITY = { platformId: "zhihu", userId: "synthetic-voter" };
const SENDER = { id: RUNTIME_ID, url: "https://www.zhihu.com/", tab: { id: 7 }, frameId: 0 };

function harness(label: string) {
  const repository = createBlacklistRepository({
    indexedDB,
    databaseName: `voter-preflight-${label}`,
    storage: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
  });
  let sender: UiMessageSender = SENDER;
  const controller = createBlacklistContentController(repository, {
    async runExclusive(operation) {
      return operation();
    },
  });
  const listener = createBlacklistContentRuntimeMessageListener(controller, RUNTIME_ID, () => {});
  const gateway = createBackgroundBlacklistGateway({
    sendMessage(message) {
      return new Promise((resolve, reject) => {
        if (!listener(message, sender, resolve)) reject(new Error("Rejected sender or input"));
      });
    },
  });
  const client = createBackgroundBlacklistClient({
    gateway,
    applyTags() {},
    setRevision() {},
    rememberAuthor() {},
    reportSyncFailure() {},
  });
  return {
    client,
    repository,
    setSender(value: UiMessageSender) {
      sender = value;
    },
  };
}

test("VOTER-015 upvoter preflight traverses client/RPC/repository and rejects deleted or replaced authorization", async () => {
  const { client, repository } = harness("lifecycle");
  const committed = await repository.commitUpvoter({
    ...IDENTITY,
    sourcePostId: null,
    authorNameAtCapture: "Synthetic",
    tagId: "default",
    blacklistedAt: TIMESTAMP,
  });
  strictEqual(committed.status, "persisted");
  if (!committed.author) throw new Error("Expected author");
  const before = await repository.querySummary();
  deepStrictEqual(await client.preflightUpvoter(IDENTITY, TIMESTAMP), { status: "ready" });
  deepStrictEqual(await client.preflightDirect(IDENTITY, TIMESTAMP), { status: "existing" });
  deepStrictEqual(await repository.querySummary(), before);
  await repository.removeAuthor(IDENTITY);
  deepStrictEqual(await client.preflightUpvoter(IDENTITY, TIMESTAMP), { status: "existing" });
  await repository.restoreAuthor({ ...committed.author, blockSource: "direct" });
  deepStrictEqual(await client.preflightUpvoter(IDENTITY, TIMESTAMP), { status: "existing" });
  deepStrictEqual(await client.preflightDirect(IDENTITY, TIMESTAMP), { status: "ready" });
  await repository.removeAuthor(IDENTITY);
  await repository.restoreAuthor({
    ...committed.author,
    blacklistedAt: "2026-08-26T12:34:56.789Z",
  });
  deepStrictEqual(await client.preflightUpvoter(IDENTITY, TIMESTAMP), { status: "existing" });
});

test("VOTER-015 upvoter preflight retains main-frame same-extension sender and canonical input restrictions", async () => {
  const { client, setSender } = harness("authorization");
  deepStrictEqual(await client.preflightUpvoter(IDENTITY, TIMESTAMP), { status: "existing" });
  for (const sender of [
    { ...SENDER, id: "other-extension" },
    { ...SENDER, frameId: 1 },
    { ...SENDER, url: `chrome-extension://${RUNTIME_ID}/options/options.html` },
    { ...SENDER, url: "https://example.com/" },
  ]) {
    setSender(sender);
    await rejects(client.preflightUpvoter(IDENTITY, TIMESTAMP));
  }
  setSender(SENDER);
  await rejects(client.preflightUpvoter({ ...IDENTITY, platformId: "youtube" }, TIMESTAMP));
  await rejects(client.preflightUpvoter({ ...IDENTITY, userId: "A".repeat(32) }, TIMESTAMP));
  await rejects(client.preflightUpvoter(IDENTITY, "invalid"));
});
