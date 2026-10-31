import type { SourcePost } from "../core/source-post.ts";
import type * as SourcePostModule from "../core/source-post.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundSourcePost from "../core/source-post.ts?background-copy";
import {
  BLACKLIST_STORE_NAMES,
  incrementMetadata,
  requestResult,
  transactionDone,
} from "./blacklist-idb-schema.ts";
import { abortTransaction, metadataFrom, putMetadata } from "./blacklist-repository-records.ts";

const { parseSourcePost, isSourcePostId } = backgroundSourcePost as typeof SourcePostModule;

export class SourcePostUnavailableError extends Error {
  constructor() {
    super("The referenced source post is no longer available.");
    this.name = "SourcePostUnavailableError";
  }
}

export async function sourcePostFrom(
  transaction: IDBTransaction,
  postId: string,
): Promise<SourcePost | null> {
  const raw: unknown = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.posts).get(postId),
  );
  if (raw === undefined) return null;
  const post = parseSourcePost(raw);
  if (!post || post.postId !== postId) throw new Error("IndexedDB source post is unreadable.");
  return post;
}

export function isSourcePostReference(value: unknown): value is string | null {
  return value === null || isSourcePostId(value);
}

export async function requireSourcePost(
  transaction: IDBTransaction,
  author: { readonly platformId: string; readonly sourcePostId: string | null },
): Promise<void> {
  if (author.sourcePostId === null) return;
  const post = isSourcePostId(author.sourcePostId)
    ? await sourcePostFrom(transaction, author.sourcePostId)
    : null;
  if (!post || post.platformId !== author.platformId) throw new SourcePostUnavailableError();
}

export async function ensurePostTarget(
  database: IDBDatabase,
  input: SourcePost,
): Promise<{ readonly post: SourcePost; readonly revision: number }> {
  const post = parseSourcePost(input);
  if (!post) throw new TypeError("Source post is invalid.");
  const transaction = database.transaction(
    [BLACKLIST_STORE_NAMES.posts, BLACKLIST_STORE_NAMES.metadata],
    "readwrite",
  );
  const done = transactionDone(transaction);
  try {
    const metadata = await metadataFrom(transaction);
    const existing = await sourcePostFrom(transaction, post.postId);
    if (existing) {
      await done;
      return { post: existing, revision: metadata.revision };
    }
    transaction.objectStore(BLACKLIST_STORE_NAMES.posts).add(post);
    const next = incrementMetadata(metadata);
    putMetadata(transaction, next);
    await done;
    return { post, revision: next.revision };
  } catch (error) {
    abortTransaction(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}
