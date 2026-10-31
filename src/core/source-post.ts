export interface SourcePost {
  readonly postId: string;
  readonly platformId: "zhihu";
  readonly kind: "answer" | "article";
  readonly contentId: string;
  readonly title: string;
  readonly url: string;
}

const NUMERIC_ID = "[1-9][0-9]{0,63}";
const POST_ID = new RegExp(`^zhihu:(answer|article):${NUMERIC_ID}$`);
const ANSWER_URL = new RegExp(
  `^https://www\\.zhihu\\.com/question/${NUMERIC_ID}/answer/(${NUMERIC_ID})$`,
);
const POST_KEYS = ["postId", "platformId", "kind", "contentId", "title", "url"];

export function isSourcePostId(value: unknown): value is string {
  return typeof value === "string" && POST_ID.test(value);
}

function parsePostIdentity(
  record: Record<string, unknown>,
): Pick<SourcePost, "postId" | "platformId" | "kind" | "contentId"> | null {
  const { postId, platformId, kind, contentId } = record;
  if (
    platformId !== "zhihu" ||
    (kind !== "answer" && kind !== "article") ||
    typeof contentId !== "string" ||
    !isSourcePostId(postId) ||
    postId !== `zhihu:${kind}:${contentId}`
  )
    return null;
  return { postId, platformId, kind, contentId };
}

function isPostTitle(title: unknown): title is string {
  return (
    typeof title === "string" &&
    title.length > 0 &&
    title === title.trim() &&
    Array.from(title).length <= 500
  );
}

function matchesPostUrl(identity: Pick<SourcePost, "kind" | "contentId">, url: string): boolean {
  return identity.kind === "article"
    ? url === `https://zhuanlan.zhihu.com/p/${identity.contentId}`
    : ANSWER_URL.exec(url)?.[1] === identity.contentId;
}

export function parseSourcePost(value: unknown): SourcePost | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== POST_KEYS.length ||
    !POST_KEYS.every((key) => Object.hasOwn(record, key))
  )
    return null;
  const identity = parsePostIdentity(record);
  const { title, url } = record;
  if (!identity || !isPostTitle(title) || typeof url !== "string") return null;
  return matchesPostUrl(identity, url) ? { ...identity, title, url } : null;
}

export function parseSourcePosts(value: unknown): SourcePost[] | null {
  if (!Array.isArray(value)) return null;
  const posts: SourcePost[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const post = parseSourcePost(raw);
    if (!post || ids.has(post.postId)) return null;
    posts.push(post);
    ids.add(post.postId);
  }
  return posts;
}

export function hasSourcePostReference(
  author: { readonly platformId: string; readonly sourcePostId: string | null },
  posts: readonly SourcePost[],
): boolean {
  return (
    author.sourcePostId === null ||
    posts.some(
      (post) => post.postId === author.sourcePostId && post.platformId === author.platformId,
    )
  );
}
