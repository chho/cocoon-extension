import type * as SourcePostModule from "../core/source-post.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundSourcePost from "../core/source-post.ts?background-copy";
import {
  parseStoredImportPost,
  type StoredImportAuthor,
  type StoredImportSession,
} from "./blacklist-idb-import-schema.ts";
import { BLACKLIST_STORE_NAMES, requestResult } from "./blacklist-idb-schema.ts";
import { IncompleteBlacklistImportError } from "./blacklist-transfer-repository-errors.ts";

const { parseSourcePost } = backgroundSourcePost as typeof SourcePostModule;

export function importStagedPosts(
  transaction: IDBTransaction,
  session: StoredImportSession,
  mode: "merge" | "replace",
): Promise<void> {
  const live = transaction.objectStore(BLACKLIST_STORE_NAMES.posts);
  if (mode === "replace") live.clear();
  return new Promise<void>((resolve, reject) => {
    let expected = 0;
    const range = IDBKeyRange.bound(
      [session.sessionId, 0],
      [session.sessionId, Number.MAX_SAFE_INTEGER],
    );
    const request = transaction.objectStore(BLACKLIST_STORE_NAMES.importPosts).openCursor(range);
    request.onerror = () => reject(request.error ?? new Error("Import post scan failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        if (expected !== session.metadata.postCount) reject(new IncompleteBlacklistImportError());
        else resolve();
        return;
      }
      void (async () => {
        try {
          const stored = parseStoredImportPost(cursor.value);
          if (!stored) throw new IncompleteBlacklistImportError();
          const { sessionId, index, ...post } = stored;
          if (sessionId !== session.sessionId || index !== expected)
            throw new IncompleteBlacklistImportError();
          const existing = await requestResult(live.get(post.postId));
          if (existing === undefined) live.add(post);
          else if (!parseSourcePost(existing))
            throw new Error("IndexedDB live post is unreadable.");
          expected += 1;
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      })();
    };
  });
}

export async function verifyImportedAuthorPost(
  transaction: IDBTransaction,
  author: StoredImportAuthor,
): Promise<void> {
  if (author.sourcePostId === null) return;
  const staged = parseStoredImportPost(
    await requestResult(
      transaction
        .objectStore(BLACKLIST_STORE_NAMES.importPosts)
        .index("by-session-post")
        .get([author.sessionId, author.sourcePostId]),
    ),
  );
  const live = parseSourcePost(
    await requestResult(
      transaction.objectStore(BLACKLIST_STORE_NAMES.posts).get(author.sourcePostId),
    ),
  );
  if (
    !staged ||
    staged.sessionId !== author.sessionId ||
    staged.postId !== author.sourcePostId ||
    staged.platformId !== author.platformId ||
    !live ||
    live.postId !== author.sourcePostId ||
    live.platformId !== author.platformId
  )
    throw new IncompleteBlacklistImportError();
}
