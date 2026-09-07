export class ImportSessionNotFoundError extends Error {
  constructor() {
    super("Blacklist import session was not found.");
  }
}

export class ImportSessionExpiredError extends Error {
  constructor() {
    super("Blacklist import session has expired.");
  }
}

export class ImportChunkConflictError extends Error {
  constructor() {
    super("Blacklist import chunk conflicts with staged data.");
  }
}

export class IncompleteBlacklistImportError extends Error {
  constructor() {
    super("Blacklist import staging is incomplete.");
  }
}

export class TransferFinalizeConflictError extends Error {
  constructor() {
    super("Blacklist import conflicts with live data.");
  }
}

export class StaleBlacklistExportError extends Error {
  constructor() {
    super("Blacklist export revision is stale.");
  }
}
