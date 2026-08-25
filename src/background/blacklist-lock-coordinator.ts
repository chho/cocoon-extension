export const BLACKLIST_LOCK_NAME = "cocoon-blacklist-storage";

interface LockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface BlacklistLockCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export function createBlacklistLockCoordinator(locks: LockManager): BlacklistLockCoordinator {
  return {
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      return locks.request(BLACKLIST_LOCK_NAME, { mode: "exclusive" }, operation);
    },
  };
}
