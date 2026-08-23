import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  downloadJsonBlob,
  readFileText,
  type ObjectUrlApi,
} from "./transfer-file.ts";

const JSON_CONTENT = JSON.stringify({
  product: "cocoon-blacklist",
  formatVersion: 1,
});
const FILENAME = "cocoon-blacklist-2026-08-22.json";

function fixture(): JSDOM {
  return new JSDOM("<!doctype html><body></body>", {
    url: "chrome-extension://runtime/options/options.html",
  });
}

test("MANAGE-004/AC-089 real Blob download uses exact JSON metadata and a temporary clicked anchor", async () => {
  const dom = fixture();
  const createdBlobs: Blob[] = [];
  const revokedUrls: string[] = [];
  const cleanupCallbacks: Array<() => void> = [];
  const objectUrls: ObjectUrlApi = {
    createObjectURL(blob) {
      createdBlobs.push(blob);
      return "blob:cocoon-transfer";
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  const clickedLinks: HTMLAnchorElement[] = [];
  dom.window.HTMLAnchorElement.prototype.click = function(
    this: HTMLAnchorElement,
  ): void {
    clickedLinks.push(this);
    strictEqual(dom.window.document.body.contains(this), true);
  };

  downloadJsonBlob(
    dom.window.document,
    objectUrls,
    JSON_CONTENT,
    FILENAME,
    (callback) => cleanupCallbacks.push(callback),
  );

  strictEqual(createdBlobs.length, 1);
  strictEqual(createdBlobs[0]?.type, "application/json;charset=utf-8");
  strictEqual(await createdBlobs[0]?.text(), JSON_CONTENT);
  const clickedLink = clickedLinks[0];
  if (!clickedLink) throw new Error("download anchor was not clicked");
  strictEqual(clickedLink.download, FILENAME);
  strictEqual(clickedLink.href, "blob:cocoon-transfer");
  strictEqual(clickedLink.hidden, true);
  strictEqual(clickedLink.rel, "noopener");
  strictEqual(dom.window.document.body.contains(clickedLink), false);
  strictEqual(dom.window.document.querySelector("a"), null);
  deepStrictEqual(revokedUrls, []);
  strictEqual(cleanupCallbacks.length, 1);

  cleanupCallbacks[0]?.();
  cleanupCallbacks[0]?.();
  deepStrictEqual(revokedUrls, ["blob:cocoon-transfer"]);
});

test("MANAGE-004/AC-089 Blob URL cleanup survives click and cleanup-scheduler failures", () => {
  const clickDom = fixture();
  const clickError = new Error("click failed");
  const failedLinks: HTMLAnchorElement[] = [];
  const deferredCleanups: Array<() => void> = [];
  const clickRevocations: string[] = [];
  clickDom.window.HTMLAnchorElement.prototype.click = function(
    this: HTMLAnchorElement,
  ): void {
    failedLinks.push(this);
    throw clickError;
  };

  throws(() => downloadJsonBlob(
    clickDom.window.document,
    {
      createObjectURL: () => "blob:click-failure",
      revokeObjectURL: (url) => clickRevocations.push(url),
    },
    JSON_CONTENT,
    FILENAME,
    (callback) => deferredCleanups.push(callback),
  ), clickError);
  strictEqual(clickDom.window.document.body.contains(failedLinks[0] ?? null), false);
  deepStrictEqual(clickRevocations, []);
  deferredCleanups[0]?.();
  deepStrictEqual(clickRevocations, ["blob:click-failure"]);

  const schedulerDom = fixture();
  schedulerDom.window.HTMLAnchorElement.prototype.click = () => {};
  const schedulerError = new Error("cleanup scheduling failed");
  const schedulerRevocations: string[] = [];
  throws(() => downloadJsonBlob(
    schedulerDom.window.document,
    {
      createObjectURL: () => "blob:scheduler-failure",
      revokeObjectURL: (url) => schedulerRevocations.push(url),
    },
    JSON_CONTENT,
    FILENAME,
    () => { throw schedulerError; },
  ), schedulerError);
  deepStrictEqual(schedulerRevocations, ["blob:scheduler-failure"]);
  strictEqual(schedulerDom.window.document.querySelector("a"), null);
});

test("MANAGE-004/AC-089 production file reader returns text and propagates read failures", async () => {
  let reads = 0;
  const readable = {
    async text() {
      reads += 1;
      return JSON_CONTENT;
    },
  } as File;
  strictEqual(await readFileText(readable), JSON_CONTENT);
  strictEqual(reads, 1);

  const failure = new Error("file unreadable");
  const unreadable = {
    async text(): Promise<string> {
      throw failure;
    },
  } as File;
  await rejects(readFileText(unreadable), failure);
});
