const STRUCTURAL_CLASS_NAMES = new Set([
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

const SAFE_TAG_NAMES = new Set(["a", "article", "div", "section", "span"]);

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function allowlistedClasses(value) {
  return value.filter(
    (className) =>
      STRUCTURAL_CLASS_NAMES.has(className) && !className.startsWith("cocoon-"),
  );
}

function allowlistedTagName(value) {
  const tagName = value.toLowerCase();
  return SAFE_TAG_NAMES.has(tagName) ? tagName : "div";
}

function serializeStructure(node, context) {
  const tagName = allowlistedTagName(node.tagName);
  const classes = allowlistedClasses(node.classes);
  const attributes = [];

  if (classes.length > 0) {
    attributes.push(`class="${escapeHtml(classes.join(" "))}"`);
  }

  if (node.markers.content) {
    attributes.push(`data-zop="${escapeHtml(JSON.stringify(context.dataZop))}"`);
    attributes.push(
      `data-za-extra-module="${escapeHtml(JSON.stringify(context.extraModule))}"`,
    );
  }

  if (node.markers.profileLink && context.profileUrlToken) {
    attributes.push(
      `href="/people/${escapeHtml(encodeURIComponent(context.profileUrlToken))}"`,
    );
  }

  const children = node.children
    .map((child) => serializeStructure(child, context))
    .join("");
  const text = node.markers.author ? escapeHtml(context.authorName ?? "") : "";
  const separator = attributes.length > 0 ? " " : "";

  return `<${tagName}${separator}${attributes.join(" ")}>${text}${children}</${tagName}>`;
}

function buildLocalRawSample(sample) {
  const authorName = optionalString(sample.authorName);
  const memberHash = optionalString(sample.authorMemberHashId);
  const profileUrlToken = optionalString(sample.profileUserId);
  const memberUrlToken = optionalString(sample.memberResponse?.urlToken);
  const dataZop = {
    ...(sample.fieldEvidence.dataZopAuthorName && authorName
      ? { authorName }
      : {}),
    ...(sample.fieldEvidence.dataZopType ? { type: sample.contentType } : {}),
  };
  const extraContent = {
    ...(sample.fieldEvidence.extraMemberHash && memberHash
      ? { author_member_hash_id: memberHash }
      : {}),
    ...(sample.fieldEvidence.extraType ? { type: sample.contentType } : {}),
  };
  const html = serializeStructure(sample.structure, {
    authorName,
    dataZop,
    extraModule: { card: { content: extraContent } },
    profileUrlToken: profileUrlToken ?? memberUrlToken,
  });

  let memberApi = null;
  if (memberHash && sample.memberResponse) {
    memberApi = {
      endpoint: `/api/v4/members/${encodeURIComponent(memberHash)}`,
      ok: sample.memberResponse.ok,
      status: sample.memberResponse.status,
      response:
        sample.memberResponse.ok && memberUrlToken
          ? { url_token: memberUrlToken }
          : null,
    };
  }

  return {
    contentType: sample.contentType,
    authorIdentity: {
      authorName,
      author_member_hash_id: memberHash,
      url_token: profileUrlToken,
    },
    fieldEvidence: { ...sample.fieldEvidence },
    html,
    memberApi,
  };
}

export function buildLocalRawSamples(samples) {
  return samples.map(buildLocalRawSample);
}
