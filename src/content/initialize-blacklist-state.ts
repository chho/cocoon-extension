import type {
  BlacklistState,
  ParsedBlacklistState,
} from "./blacklist-state";

export interface InitializeBlacklistStateDependencies {
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
}

export async function initializeBlacklistState(
  dependencies: InitializeBlacklistStateDependencies,
): Promise<ParsedBlacklistState> {
  const initialRead = await dependencies.readState();
  if (
    initialRead.status !== "missing" &&
    initialRead.status !== "migrated"
  ) {
    return initialRead;
  }

  return dependencies.withExclusiveLock(async () => {
    const latestRead = await dependencies.readState();
    if (
      latestRead.status !== "missing" &&
      latestRead.status !== "migrated"
    ) {
      return latestRead;
    }

    await dependencies.writeState(latestRead.state);
    return dependencies.readState();
  });
}
