import type { BlacklistTransferRepository } from "./blacklist-transfer-repository-types.ts";
import {
  beginBlacklistExport,
  exportBlacklistAuthorsPage,
  exportBlacklistTagsPage,
  finishBlacklistExport,
} from "./blacklist-export-repository.ts";
import { finalizeImport } from "./blacklist-import-finalize.ts";
import {
  abortImportStaging,
  beginImportStaging,
  cleanupExpiredImportStaging,
  inspectImportStaging,
  stageImportAuthorsChunk,
  stageImportTagsChunk,
} from "./blacklist-import-staging.ts";

export interface BlacklistTransferRepositoryEnvironment {
  readonly database: () => Promise<IDBDatabase>;
  readonly clock: () => number;
  readonly randomSessionId: () => string;
  readonly beforeFinalizeCommit?: (transaction: IDBTransaction) => void;
  readonly publishRevision: (revision: number) => Promise<void>;
}

class BlacklistTransferRepositoryAdapter implements BlacklistTransferRepository {
  #environment: BlacklistTransferRepositoryEnvironment;

  constructor(environment: BlacklistTransferRepositoryEnvironment) {
    this.#environment = environment;
  }

  readonly beginImport: BlacklistTransferRepository["beginImport"] = async (metadata) =>
    beginImportStaging({
      database: await this.#environment.database(),
      metadata,
      clock: this.#environment.clock,
      randomSessionId: this.#environment.randomSessionId,
    });

  readonly stageAuthorsChunk: BlacklistTransferRepository["stageAuthorsChunk"] = async (input) =>
    stageImportAuthorsChunk({
      database: await this.#environment.database(),
      clock: this.#environment.clock,
      input,
    });

  readonly stageTagsChunk: BlacklistTransferRepository["stageTagsChunk"] = async (input) =>
    stageImportTagsChunk({
      database: await this.#environment.database(),
      clock: this.#environment.clock,
      input,
    });

  readonly inspectImport: BlacklistTransferRepository["inspectImport"] = async (sessionId) =>
    inspectImportStaging(await this.#environment.database(), sessionId, this.#environment.clock);

  readonly abortImport: BlacklistTransferRepository["abortImport"] = async (sessionId) =>
    abortImportStaging(await this.#environment.database(), sessionId);

  readonly cleanupExpiredImports: BlacklistTransferRepository["cleanupExpiredImports"] = async () =>
    cleanupExpiredImportStaging(await this.#environment.database(), this.#environment.clock);

  readonly finalizeMerge: BlacklistTransferRepository["finalizeMerge"] = (sessionId) =>
    this.finalize(sessionId, "merge");

  readonly finalizeReplace: BlacklistTransferRepository["finalizeReplace"] = (sessionId) =>
    this.finalize(sessionId, "replace");

  readonly beginExport: BlacklistTransferRepository["beginExport"] = async () =>
    beginBlacklistExport(await this.#environment.database(), this.#environment.clock);

  readonly exportAuthorsPage: BlacklistTransferRepository["exportAuthorsPage"] = async (input) =>
    exportBlacklistAuthorsPage(await this.#environment.database(), input);

  readonly exportTagsPage: BlacklistTransferRepository["exportTagsPage"] = async (input) =>
    exportBlacklistTagsPage(await this.#environment.database(), input);

  readonly finishExport: BlacklistTransferRepository["finishExport"] = async (revision) =>
    finishBlacklistExport(await this.#environment.database(), revision);

  private async finalize(sessionId: string, mode: "merge" | "replace") {
    const result = await finalizeImport({
      database: await this.#environment.database(),
      sessionId,
      mode,
      clock: this.#environment.clock,
      beforeCommit: this.#environment.beforeFinalizeCommit,
    });
    await this.#environment.publishRevision(result.revision);
    return result;
  }
}

export function createBlacklistTransferRepository(
  environment: BlacklistTransferRepositoryEnvironment,
): BlacklistTransferRepository {
  return new BlacklistTransferRepositoryAdapter(environment);
}
