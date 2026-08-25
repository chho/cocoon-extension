import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  BlacklistState,
  BlacklistedAuthor,
  CocoonTag,
  CommitInput,
  UpvoterCommitInput,
} from "../content/blacklist-state.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundBlacklistState from "../content/blacklist-state.ts?background-copy";
import type * as RevisionContractModule from "../core/blacklist-revision-contract.ts";
// @ts-expect-error Vite resolves the background-only copy during bundling.
import * as backgroundRevisionContract from "../core/blacklist-revision-contract.ts?background-copy";
import {
  BLACKLIST_DATABASE_NAME,
  BLACKLIST_DATABASE_VERSION,
  BLACKLIST_METADATA_KEY,
  BLACKLIST_STORE_NAMES,
  createMetadata,
  createStoredAuthor,
  createStoredIdentifier,
  createStoredTag,
  identifierKey,
  openBlacklistDatabase,
  parseStoredAuthor,
  parseStoredIdentifier,
  parseStoredMetadata,
  parseStoredTag,
  requestResult,
  transactionDone,
  type StoredBlacklistMetadata,
} from "./blacklist-idb-schema.ts";
import {
  deleteTagTarget,
  removeAuthorsTarget,
  removeAuthorTarget,
  renameTagTarget,
  restoreAuthorTarget,
} from "./blacklist-repository-management.ts";
import {
  backfillMemberHashTarget,
  commitAuthorTarget,
  commitUpvoterTarget,
  preflightDirectTarget,
} from "./blacklist-repository-targets.ts";
import type { BlacklistHydration, BlacklistRepository } from "./blacklist-repository-types.ts";

const { STORAGE_KEY, parseBlacklistState } =
  backgroundBlacklistState as typeof BlacklistStateModule;
const {
  BLACKLIST_REVISION_STORAGE_KEY,
  createBlacklistRevisionSignal,
  parseBlacklistRevisionSignal,
} = backgroundRevisionContract as typeof RevisionContractModule;

export { BLACKLIST_DATABASE_VERSION, BLACKLIST_STORE_NAMES };
export type { BlacklistRepository } from "./blacklist-repository-types.ts";

interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface BlacklistRepositoryOptions {
  readonly indexedDB: IDBFactory;
  readonly storage: LocalStorageArea;
  readonly databaseName?: string;
  readonly beforeMigrationComplete?: () => void;
}

function logicalAuthor(
  author: NonNullable<ReturnType<typeof parseStoredAuthor>>,
): BlacklistedAuthor {
  return {
    platformId: author.platformId,
    userId: author.userId,
    memberHashId: author.memberHashId,
    authorNameAtCapture: author.authorNameAtCapture,
    tagId: author.tagId,
    blacklistedAt: author.blacklistedAt,
    blockSource: author.blockSource,
  };
}

function logicalTag(tag: NonNullable<ReturnType<typeof parseStoredTag>>): CocoonTag {
  return { tagId: tag.tagId, name: tag.name };
}

function abort(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // Preserve the original validation or request failure.
  }
}

function writeStateRecords(transaction: IDBTransaction, state: BlacklistState): void {
  const authors = transaction.objectStore(BLACKLIST_STORE_NAMES.authors);
  const identifiers = transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers);
  const tags = transaction.objectStore(BLACKLIST_STORE_NAMES.tags);
  state.tags.forEach((tag, order) => tags.add(createStoredTag(tag, order)));
  state.authors.forEach((author, order) => {
    authors.add(createStoredAuthor(author, order));
    identifiers.add(createStoredIdentifier(author, author.userId));
    if (author.memberHashId !== null) {
      identifiers.add(createStoredIdentifier(author, author.memberHashId));
    }
  });
}

async function readMetadata(database: IDBDatabase): Promise<StoredBlacklistMetadata | null> {
  const transaction = database.transaction(BLACKLIST_STORE_NAMES.metadata, "readonly");
  const done = transactionDone(transaction);
  const raw = await requestResult(
    transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
  );
  await done;
  if (raw === undefined) return null;
  const metadata = parseStoredMetadata(raw as unknown);
  if (!metadata) throw new Error("IndexedDB blacklist metadata is unreadable.");
  return metadata;
}

function validateOrders(values: readonly { readonly order: number }[], nextOrder: number): boolean {
  const orders = new Set(values.map(({ order }) => order));
  return orders.size === values.length && values.every(({ order }) => order < nextOrder);
}

interface RawHydration {
  readonly metadata: unknown;
  readonly authors: readonly unknown[];
  readonly identifiers: readonly unknown[];
  readonly tags: readonly unknown[];
}

async function readRawHydration(database: IDBDatabase): Promise<RawHydration> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readonly");
  const done = transactionDone(transaction);
  const [metadata, authors, identifiers, tags] = await Promise.all([
    requestResult(
      transaction.objectStore(BLACKLIST_STORE_NAMES.metadata).get(BLACKLIST_METADATA_KEY),
    ),
    requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.authors).getAll()),
    requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.identifiers).getAll()),
    requestResult(transaction.objectStore(BLACKLIST_STORE_NAMES.tags).getAll()),
  ]);
  await done;
  return { metadata, authors, identifiers, tags };
}

function requireParsed<Value>(values: readonly (Value | null)[], message: string): Value[] {
  if (values.some((value) => value === null)) throw new Error(message);
  return values as Value[];
}

function parseHydrationTags(values: readonly unknown[]): ReturnType<typeof parseStoredTag>[] {
  return values.map(parseStoredTag);
}

function parseHydrationAuthors(
  values: readonly unknown[],
  tags: readonly NonNullable<ReturnType<typeof parseStoredTag>>[],
): ReturnType<typeof parseStoredAuthor>[] {
  const tagsById = new Map(tags.map((tag) => [tag.tagId, logicalTag(tag)]));
  return values.map((value) => {
    if (typeof value !== "object" || value === null || !("tagId" in value)) return null;
    const tag = typeof value.tagId === "string" ? tagsById.get(value.tagId) : undefined;
    return tag ? parseStoredAuthor(value, tag) : null;
  });
}

function validateHydrationMetadata(
  metadata: StoredBlacklistMetadata,
  authors: readonly NonNullable<ReturnType<typeof parseStoredAuthor>>[],
  tags: readonly NonNullable<ReturnType<typeof parseStoredTag>>[],
): void {
  const countsMatch = metadata.authorCount === authors.length && metadata.tagCount === tags.length;
  const ordersMatch =
    validateOrders(authors, metadata.nextAuthorOrder) &&
    validateOrders(tags, metadata.nextTagOrder);
  if (!countsMatch || !ordersMatch) {
    throw new Error("IndexedDB blacklist metadata does not match its records.");
  }
}

function validateIdentifierNamespace(
  authors: readonly NonNullable<ReturnType<typeof parseStoredAuthor>>[],
  identifiers: readonly NonNullable<ReturnType<typeof parseStoredIdentifier>>[],
): void {
  const expected = new Map<string, string>();
  for (const author of authors) {
    expected.set(identifierKey(author.platformId, author.userId), author.authorKey);
    if (author.memberHashId !== null) {
      expected.set(identifierKey(author.platformId, author.memberHashId), author.authorKey);
    }
  }
  const matches = identifiers.every(
    (identifier) => expected.get(identifier.identifierKey) === identifier.authorKey,
  );
  if (expected.size !== identifiers.length || !matches) {
    throw new Error("IndexedDB identifier namespace is incomplete or conflicting.");
  }
}

function createHydrationState(
  authors: NonNullable<ReturnType<typeof parseStoredAuthor>>[],
  tags: NonNullable<ReturnType<typeof parseStoredTag>>[],
): BlacklistState {
  authors.sort((left, right) => left.order - right.order);
  tags.sort((left, right) => left.order - right.order);
  const candidate = {
    schemaVersion: 5,
    tags: tags.map(logicalTag),
    authors: authors.map(logicalAuthor),
  } satisfies BlacklistState;
  const parsed = parseBlacklistState(candidate);
  if (parsed.status !== "valid")
    throw new Error("IndexedDB logical blacklist state is unreadable.");
  return parsed.state;
}

async function readHydration(database: IDBDatabase): Promise<BlacklistHydration> {
  const raw = await readRawHydration(database);
  const metadata = parseStoredMetadata(raw.metadata);
  if (!metadata) throw new Error("IndexedDB blacklist state is unreadable.");
  const tags = requireParsed(
    parseHydrationTags(raw.tags),
    "IndexedDB blacklist state is unreadable.",
  );
  const authors = requireParsed(
    parseHydrationAuthors(raw.authors, tags),
    "IndexedDB blacklist state is unreadable.",
  );
  const identifiers = requireParsed(
    raw.identifiers.map(parseStoredIdentifier),
    "IndexedDB blacklist state is unreadable.",
  );
  validateHydrationMetadata(metadata, authors, tags);
  validateIdentifierNamespace(authors, identifiers);
  return { state: createHydrationState(authors, tags), revision: metadata.revision };
}

async function migrateState(
  database: IDBDatabase,
  state: BlacklistState,
  beforeMigrationComplete: (() => void) | undefined,
): Promise<StoredBlacklistMetadata> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const metadataStore = transaction.objectStore(BLACKLIST_STORE_NAMES.metadata);
    const existingRaw = await requestResult(metadataStore.get(BLACKLIST_METADATA_KEY));
    if (existingRaw !== undefined) {
      const existing = parseStoredMetadata(existingRaw as unknown);
      if (!existing) throw new Error("IndexedDB blacklist metadata is unreadable.");
      await done;
      return existing;
    }
    for (const storeName of Object.values(BLACKLIST_STORE_NAMES)) {
      transaction.objectStore(storeName).clear();
    }
    writeStateRecords(transaction, state);
    beforeMigrationComplete?.();
    const metadata = createMetadata(state, 0);
    metadataStore.add(metadata);
    await done;
    return metadata;
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

async function replaceState(database: IDBDatabase, state: BlacklistState): Promise<number> {
  const transaction = database.transaction(Object.values(BLACKLIST_STORE_NAMES), "readwrite");
  const done = transactionDone(transaction);
  try {
    const metadataStore = transaction.objectStore(BLACKLIST_STORE_NAMES.metadata);
    const raw = await requestResult(metadataStore.get(BLACKLIST_METADATA_KEY));
    const current = parseStoredMetadata(raw as unknown);
    if (!current || current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("IndexedDB blacklist metadata is unreadable.");
    }
    for (const storeName of [
      BLACKLIST_STORE_NAMES.authors,
      BLACKLIST_STORE_NAMES.identifiers,
      BLACKLIST_STORE_NAMES.tags,
    ]) {
      transaction.objectStore(storeName).clear();
    }
    writeStateRecords(transaction, state);
    metadataStore.put(createMetadata(state, current.revision + 1));
    await done;
    return current.revision + 1;
  } catch (error) {
    abort(transaction);
    await done.catch(() => undefined);
    throw error;
  }
}

interface RepositoryEnvironment {
  readonly options: BlacklistRepositoryOptions;
  readonly database: Promise<IDBDatabase>;
  initialization: Promise<IDBDatabase> | null;
  pendingRevision: number | null;
  legacyCleanupPending: boolean;
}

async function publishRevision(
  environment: RepositoryEnvironment,
  revision: number,
): Promise<void> {
  try {
    const { storage } = environment.options;
    const values = await storage.get(BLACKLIST_REVISION_STORAGE_KEY);
    const current = parseBlacklistRevisionSignal(values[BLACKLIST_REVISION_STORAGE_KEY]);
    if (current?.revision !== revision) {
      await storage.set({
        [BLACKLIST_REVISION_STORAGE_KEY]: createBlacklistRevisionSignal(revision),
      });
    }
    if (environment.pendingRevision === revision) environment.pendingRevision = null;
  } catch {
    environment.pendingRevision = revision;
  }
}

async function settleCommittedMetadata(
  environment: RepositoryEnvironment,
  metadata: StoredBlacklistMetadata,
): Promise<void> {
  try {
    await environment.options.storage.remove(STORAGE_KEY);
    environment.legacyCleanupPending = false;
  } catch {
    environment.legacyCleanupPending = true;
  }
  await publishRevision(environment, metadata.revision);
}

async function readLegacyState(environment: RepositoryEnvironment): Promise<BlacklistState> {
  let values: Record<string, unknown>;
  try {
    values = await environment.options.storage.get(STORAGE_KEY);
  } catch {
    throw new Error("Legacy blacklist storage is unreadable.");
  }
  const parsed = parseBlacklistState(values[STORAGE_KEY]);
  if (parsed.status === "malformed") {
    throw new Error("Legacy blacklist storage is malformed or from a future version.");
  }
  return parsed.state;
}

async function initializeRepository(environment: RepositoryEnvironment): Promise<IDBDatabase> {
  const database = await environment.database;
  const existing = await readMetadata(database);
  if (existing) {
    await settleCommittedMetadata(environment, existing);
    return database;
  }
  const state = await readLegacyState(environment);
  const metadata = await migrateState(database, state, environment.options.beforeMigrationComplete);
  await settleCommittedMetadata(environment, metadata);
  return database;
}

async function repairInitializationEffects(environment: RepositoryEnvironment): Promise<void> {
  if (environment.legacyCleanupPending) {
    try {
      await environment.options.storage.remove(STORAGE_KEY);
      environment.legacyCleanupPending = false;
    } catch {
      // The IDB completion marker remains authoritative until cleanup can retry.
    }
  }
  if (environment.pendingRevision !== null) {
    await publishRevision(environment, environment.pendingRevision);
  }
}

async function ensureInitialized(environment: RepositoryEnvironment): Promise<IDBDatabase> {
  const alreadyInitialized = environment.initialization !== null;
  const pending = environment.initialization ?? initializeRepository(environment);
  environment.initialization = pending;
  try {
    const database = await pending;
    if (alreadyInitialized) await repairInitializationEffects(environment);
    return database;
  } catch (error) {
    if (environment.initialization === pending) environment.initialization = null;
    throw error;
  }
}

async function publishResult<Result extends { readonly revision: number }>(
  environment: RepositoryEnvironment,
  operation: (database: IDBDatabase) => Promise<Result>,
): Promise<Result> {
  const result = await operation(await ensureInitialized(environment));
  await publishRevision(environment, result.revision);
  return result;
}

class IndexedDbBlacklistRepository implements BlacklistRepository {
  readonly environment: RepositoryEnvironment;

  constructor(options: BlacklistRepositoryOptions) {
    this.environment = {
      options,
      database: openBlacklistDatabase(
        options.indexedDB,
        options.databaseName ?? BLACKLIST_DATABASE_NAME,
      ),
      initialization: null,
      pendingRevision: null,
      legacyCleanupPending: false,
    };
  }

  async hydrate(): Promise<BlacklistHydration> {
    return readHydration(await ensureInitialized(this.environment));
  }

  commitAuthor(input: CommitInput) {
    return publishResult(this.environment, async (database) => commitAuthorTarget(database, input));
  }

  backfillMemberHash(
    identity: Parameters<BlacklistRepository["backfillMemberHash"]>[0],
    memberHashId: string,
  ) {
    return publishResult(this.environment, async (database) =>
      backfillMemberHashTarget(database, identity.platformId, identity.userId, memberHashId),
    );
  }

  commitUpvoter(input: UpvoterCommitInput) {
    return publishResult(this.environment, async (database) =>
      commitUpvoterTarget(database, input),
    );
  }

  async preflightDirect(input: Parameters<BlacklistRepository["preflightDirect"]>[0]) {
    return preflightDirectTarget(await ensureInitialized(this.environment), input);
  }

  deleteTag(tagId: string) {
    return publishResult(this.environment, async (database) => deleteTagTarget(database, tagId));
  }

  removeAuthor(identity: Parameters<BlacklistRepository["removeAuthor"]>[0]) {
    return publishResult(this.environment, async (database) =>
      removeAuthorTarget(database, identity),
    );
  }

  restoreAuthor(author: BlacklistedAuthor) {
    return publishResult(this.environment, async (database) =>
      restoreAuthorTarget(database, author),
    );
  }

  removeAuthors(identities: Parameters<BlacklistRepository["removeAuthors"]>[0]) {
    return publishResult(this.environment, async (database) =>
      removeAuthorsTarget(database, identities),
    );
  }

  renameTag(tagId: string, name: string) {
    return publishResult(this.environment, async (database) =>
      renameTagTarget(database, tagId, name),
    );
  }

  async replaceAll(untrustedState: BlacklistState): Promise<BlacklistHydration> {
    const parsed = parseBlacklistState(untrustedState);
    if (parsed.status !== "valid") throw new Error("Replacement blacklist state is invalid.");
    const database = await ensureInitialized(this.environment);
    const revision = await replaceState(database, parsed.state);
    await publishRevision(this.environment, revision);
    return { state: parsed.state, revision };
  }
}

export function createBlacklistRepository(
  options: BlacklistRepositoryOptions,
): BlacklistRepository {
  return new IndexedDbBlacklistRepository(options);
}
