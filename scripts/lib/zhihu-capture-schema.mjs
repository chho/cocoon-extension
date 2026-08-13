import { EXACT_ZHIHU_URL } from "./zhihu-page-capture.mjs";

const MAX_CAPTURE_SAMPLES = 20;
const MAX_SELECTOR_COUNT = 1_000_000;
const MAX_TEXT_LENGTH = 512;
const MAX_CLASS_COUNT = 24;
const MAX_STRUCTURE_DEPTH = 12;
const MAX_STRUCTURE_NODES = 160;
const ALLOWED_TAG_NAMES = new Set(["a", "article", "div", "section", "span"]);
const ALLOWED_CLASS_NAMES = new Set([
  "TopstoryItem",
  "ContentItem",
  "AnswerItem",
  "ArticleItem",
  "Card",
  "AuthorInfo",
  "AuthorInfo-content",
  "AuthorInfo-head",
  "AuthorInfo-avatar",
  "AuthorInfo-name",
  "UserLink",
  "UserLink-link",
]);

function fail(path, reason) {
  throw new TypeError(`Invalid Zhihu capture result at ${path}: ${reason}.`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail(path, "expected an object");
}

function assertExactKeys(value, expectedKeys, path) {
  assertRecord(value, path);
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(path, `expected exactly keys ${sortedExpected.join(", ")}`);
  }
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
}

function assertBoundedInteger(value, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(path, `expected a non-negative integer no greater than ${maximum}`);
  }
}

function assertOptionalString(value, path, maximum = MAX_TEXT_LENGTH) {
  if (value === null) return;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail(path, `expected null or a string from 1 through ${maximum} characters`);
  }
}

function validateMarkers(markers, path) {
  assertExactKeys(markers, ["author", "content", "profileLink"], path);
  assertBoolean(markers.author, `${path}.author`);
  assertBoolean(markers.content, `${path}.content`);
  assertBoolean(markers.profileLink, `${path}.profileLink`);
}

function validateStructure(node, path, depth, state) {
  if (depth > MAX_STRUCTURE_DEPTH) {
    fail(path, `structure exceeds depth ${MAX_STRUCTURE_DEPTH}`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_STRUCTURE_NODES) {
    fail(path, `structure exceeds ${MAX_STRUCTURE_NODES} nodes`);
  }

  assertExactKeys(node, ["children", "classes", "markers", "tagName"], path);
  if (typeof node.tagName !== "string" || !ALLOWED_TAG_NAMES.has(node.tagName)) {
    fail(`${path}.tagName`, "expected an allowlisted structural tag name");
  }
  if (!Array.isArray(node.classes) || node.classes.length > MAX_CLASS_COUNT) {
    fail(`${path}.classes`, `expected an array of at most ${MAX_CLASS_COUNT} classes`);
  }
  node.classes.forEach((className, index) => {
    if (typeof className !== "string" || !ALLOWED_CLASS_NAMES.has(className)) {
      fail(
        `${path}.classes[${index}]`,
        "expected an allowlisted structural class name",
      );
    }
  });
  validateMarkers(node.markers, `${path}.markers`);
  if (!Array.isArray(node.children) || node.children.length > MAX_STRUCTURE_NODES) {
    fail(`${path}.children`, "expected a bounded array");
  }
  node.children.forEach((child, index) => {
    validateStructure(child, `${path}.children[${index}]`, depth + 1, state);
  });
}

function validateFieldEvidence(evidence, path) {
  assertExactKeys(
    evidence,
    ["dataZopAuthorName", "dataZopType", "extraMemberHash", "extraType"],
    path,
  );
  for (const key of Object.keys(evidence)) {
    assertBoolean(evidence[key], `${path}.${key}`);
  }
}

function validateMemberResponse(response, path) {
  if (response === null) return;
  assertExactKeys(response, ["ok", "status", "urlToken"], path);
  assertBoolean(response.ok, `${path}.ok`);
  assertBoundedInteger(response.status, `${path}.status`, 599);
  assertOptionalString(response.urlToken, `${path}.urlToken`);
}

function validateSample(sample, path) {
  assertExactKeys(
    sample,
    [
      "authorMemberHashId",
      "authorName",
      "contentType",
      "fieldEvidence",
      "memberResponse",
      "profileUserId",
      "structure",
    ],
    path,
  );
  if (sample.contentType !== "answer" && sample.contentType !== "article") {
    fail(`${path}.contentType`, "expected answer or article");
  }
  assertOptionalString(sample.authorName, `${path}.authorName`);
  assertOptionalString(sample.authorMemberHashId, `${path}.authorMemberHashId`);
  assertOptionalString(sample.profileUserId, `${path}.profileUserId`);
  validateFieldEvidence(sample.fieldEvidence, `${path}.fieldEvidence`);
  validateMemberResponse(sample.memberResponse, `${path}.memberResponse`);
  validateStructure(sample.structure, `${path}.structure`, 0, { nodes: 0 });
}

export function validateCaptureResult(value) {
  assertExactKeys(value, ["samples", "selectorCounts", "sourceUrl"], "capture");
  if (value.sourceUrl !== EXACT_ZHIHU_URL) {
    fail("capture.sourceUrl", `expected ${EXACT_ZHIHU_URL}`);
  }

  assertExactKeys(
    value.selectorCounts,
    ["author", "card", "content", "profileLink"],
    "capture.selectorCounts",
  );
  for (const key of Object.keys(value.selectorCounts)) {
    assertBoundedInteger(
      value.selectorCounts[key],
      `capture.selectorCounts.${key}`,
      MAX_SELECTOR_COUNT,
    );
  }

  if (!Array.isArray(value.samples) || value.samples.length > MAX_CAPTURE_SAMPLES) {
    fail(
      "capture.samples",
      `expected an array of at most ${MAX_CAPTURE_SAMPLES} samples`,
    );
  }
  value.samples.forEach((sample, index) => {
    validateSample(sample, `capture.samples[${index}]`);
  });

  return value;
}
