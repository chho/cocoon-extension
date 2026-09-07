import type * as BlacklistStateModule from "../content/blacklist-state.ts";
import type {
  BlacklistState,
  BlacklistedAuthor,
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
  openBlacklistDatabase,
  parseStoredMetadata,
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
  queryAuthorsPage,
  queryIdentityMatches,
  queryPlatformsPage,
  querySummary,
  queryTagsPage,
} from "./blacklist-repository-query.ts";
import {
  backfillMemberHashTarget,
  commitAuthorTarget,
  commitUpvoterTarget,
  preflightDirectTarget,
} from "./blacklist-repository-targets.ts";
import type {
  BlacklistRepository,
  TransferCapableBlacklistRepository,
} from "./blacklist-repository-types.ts";
import { createBlacklistTransferRepository } from "./blacklist-repository-transfer-adapter.ts";

const { STORAGE_KEY, parseBlacklistState } =
  backgroundBlacklistState as typeof BlacklistStateModule;
const {
  BLACKLIST_REVISION_STORAGE_KEY,
  createBlacklistRevisionSignal,
  parseBlacklistRevisionSignal,
} = backgroundRevisionContract as typeof RevisionContractModule;

export { BLACKLIST_DATABASE_VERSION, BLACKLIST_STORE_NAMES };
export type {
  BlacklistRepository,
  TransferCapableBlacklistRepository,
} from "./blacklist-repository-types.ts";

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
  readonly clock?: () => number;
  readonly randomSessionId?: () => string;
  readonly beforeFinalizeCommit?: (transaction: IDBTransaction) => void;
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

class IndexedDbBlacklistRepository {
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

  async querySummary() {
    return querySummary(await ensureInitialized(this.environment));
  }

  async queryAuthorsPage(query: Parameters<BlacklistRepository["queryAuthorsPage"]>[0]) {
    return queryAuthorsPage(await ensureInitialized(this.environment), query);
  }

  async queryTagsPage(query: Parameters<BlacklistRepository["queryTagsPage"]>[0]) {
    return queryTagsPage(await ensureInitialized(this.environment), query);
  }

  async queryPlatformsPage(query: Parameters<BlacklistRepository["queryPlatformsPage"]>[0]) {
    return queryPlatformsPage(await ensureInitialized(this.environment), query);
  }

  async queryIdentityMatches(query: Parameters<BlacklistRepository["queryIdentityMatches"]>[0]) {
    return queryIdentityMatches(await ensureInitialized(this.environment), query);
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
}

export function createBlacklistRepository(
  options: BlacklistRepositoryOptions,
): TransferCapableBlacklistRepository {
  const repository = new IndexedDbBlacklistRepository(options);
  const transfer = createBlacklistTransferRepository({
    database: () => ensureInitialized(repository.environment),
    clock: options.clock ?? Date.now,
    randomSessionId: options.randomSessionId ?? (() => crypto.randomUUID().replaceAll("-", "")),
    beforeFinalizeCommit: options.beforeFinalizeCommit,
    publishRevision: (revision) => publishRevision(repository.environment, revision),
  });
  return Object.assign(repository, transfer);
}
