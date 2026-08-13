import { strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";

import { validateCaptureResult } from "./zhihu-capture-schema.mjs";
import { rawSample, validCapture } from "./zhihu-test-fixtures.mjs";

function rejectsCapture(mutator, pattern = /Invalid Zhihu capture result/u) {
  const capture = structuredClone(validCapture());
  mutator(capture);
  throws(() => validateCaptureResult(capture), pattern);
}

test("accepts a complete valid capture result", () => {
  const capture = validCapture();
  strictEqual(validateCaptureResult(capture), capture);
});

test("rejects malformed selector counts", () => {
  for (const count of [-1, 1.5, "3", Number.NaN, 1_000_001]) {
    rejectsCapture((capture) => {
      capture.selectorCounts.card = count;
    }, /selectorCounts\.card/u);
  }
});

test("rejects extra properties at every capture level", () => {
  rejectsCapture((capture) => {
    capture.unexpected = true;
  }, /capture: expected exactly keys/u);
  rejectsCapture((capture) => {
    capture.selectorCounts.unexpected = 1;
  }, /capture\.selectorCounts/u);
  rejectsCapture((capture) => {
    capture.samples[0].unexpected = true;
  }, /capture\.samples\[0\]/u);
  rejectsCapture((capture) => {
    capture.samples[0].memberResponse.unexpected = true;
  }, /memberResponse/u);
  rejectsCapture((capture) => {
    capture.samples[0].structure.markers.unexpected = true;
  }, /markers/u);
});

test("rejects wrong, empty, and unbounded sample values", () => {
  rejectsCapture((capture) => {
    capture.samples[0].contentType = "video";
  }, /contentType/u);
  rejectsCapture((capture) => {
    capture.samples[0].authorName = "";
  }, /authorName/u);
  rejectsCapture((capture) => {
    capture.samples[0].profileUserId = "x".repeat(513);
  }, /profileUserId/u);
  rejectsCapture((capture) => {
    capture.samples[0].fieldEvidence.dataZopType = 1;
  }, /dataZopType/u);
  rejectsCapture((capture) => {
    capture.samples[0].memberResponse.status = 600;
  }, /status/u);
  rejectsCapture((capture) => {
    capture.samples = Array.from({ length: 21 }, () => rawSample());
  }, /at most 20 samples/u);
});

test("rejects malformed, broad, and unbounded structures", () => {
  rejectsCapture((capture) => {
    capture.samples[0].structure.classes = "TopstoryItem";
  }, /classes/u);
  rejectsCapture((capture) => {
    capture.samples[0].structure.classes = ["TopstoryItem", "tracking-class"];
  }, /allowlisted structural class/u);
  rejectsCapture((capture) => {
    capture.samples[0].structure.tagName = "script";
  }, /allowlisted structural tag/u);
  rejectsCapture((capture) => {
    capture.samples[0].structure.children[0].tagName = 1;
  }, /tagName/u);
  rejectsCapture((capture) => {
    capture.samples[0].structure.children = [null];
  }, /children\[0\]/u);

  rejectsCapture((capture) => {
    let node = capture.samples[0].structure;
    for (let index = 0; index < 13; index += 1) {
      const child = {
        tagName: "div",
        classes: [],
        markers: { content: false, author: false, profileLink: false },
        children: [],
      };
      node.children = [child];
      node = child;
    }
  }, /exceeds depth/u);
});

test("rejects malformed roots and sample collections", () => {
  throws(() => validateCaptureResult(null), /capture/u);
  rejectsCapture((capture) => {
    capture.sourceUrl = "https://www.zhihu.com/question/1";
  }, /sourceUrl/u);
  rejectsCapture((capture) => {
    capture.samples = {};
  }, /capture\.samples/u);
  rejectsCapture((capture) => {
    capture.samples = [null];
  }, /capture\.samples\[0\]/u);
});
