interface ZhihuExtraModuleData {
  card: {
    content: {
      author_member_hash_id: string;
    };
  };
}

interface ZhihuMemberResponse {
  url_token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isZhihuExtraModuleData(
  value: unknown,
): value is ZhihuExtraModuleData {
  if (!isRecord(value) || !isRecord(value.card)) {
    return false;
  }

  const { content } = value.card;
  return (
    isRecord(content) && typeof content.author_member_hash_id === "string"
  );
}

function isZhihuMemberResponse(value: unknown): value is ZhihuMemberResponse {
  return isRecord(value) && typeof value.url_token === "string";
}

export function parseAuthorMemberHashId(metadata: string): string | null {
  try {
    const value: unknown = JSON.parse(metadata);
    if (!isZhihuExtraModuleData(value)) {
      return null;
    }

    return value.card.content.author_member_hash_id.trim() || null;
  } catch {
    return null;
  }
}

export function parseMemberUrlToken(value: unknown): string | null {
  if (!isZhihuMemberResponse(value)) {
    return null;
  }

  return value.url_token.trim() || null;
}
