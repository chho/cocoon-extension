import type { AuthorMutationResult } from "../background/blacklist-repository-types.ts";
import {
  ZHIHU_PLATFORM_ID,
  createBlacklistTimestamp,
  type UpvoterCommitInput,
} from "./blacklist-state.ts";
import type { RemoteBlockResult } from "./zhihu-remote-api.ts";

const MAX_CONCURRENT_REMOTE_BLOCKS = 3;
const USER_LOCK_PREFIX = "cocoon-remote-block-user";
const SLOT_LOCK_PREFIX = "cocoon-remote-block-slot";

export type UserBlockRequest =
  | {
      readonly source: "direct";
      readonly userId: string;
      readonly expectedBlacklistedAt: string;
    }
  | {
      readonly source: "upvoter";
      readonly userId: string;
      readonly authorName: string;
      readonly tagId: string;
    };

export type CoordinatedBlockResult =
  | {
      readonly status: "success";
      readonly persistedUpvoter: boolean;
    }
  | {
      readonly status: "skipped";
      readonly reason: "existing" | "concurrent";
    }
  | { readonly status: "stopped" }
  | {
      readonly status: "failed";
      readonly reason: "authentication" | "rate-limit" | "csrf" | "network" | "http" | "storage";
    };

export type CrossContextTryLockResult<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

export interface RemoteBlockCoordinatorDependencies {
  readonly withCrossContextLock: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
  readonly tryWithCrossContextUserLock: <T>(
    name: string,
    operation: () => Promise<T>,
  ) => Promise<CrossContextTryLockResult<T>>;
  readonly preflightDirect: (
    userId: string,
    expectedBlacklistedAt: string,
  ) => Promise<{ readonly status: "ready" | "existing" }>;
  readonly commitUpvoter: (input: UpvoterCommitInput) => Promise<AuthorMutationResult>;
  readonly now: () => Date;
  readonly blockUser: (userId: string, isStopped: () => boolean) => Promise<RemoteBlockResult>;
  readonly reportStorageFailure: (error: unknown) => void;
}

export interface RemoteBlockCoordinator {
  block(request: UserBlockRequest, isStopped?: () => boolean): Promise<CoordinatedBlockResult>;
}

type DirectBlockRequest = Extract<UserBlockRequest, { source: "direct" }>;
type UpvoterBlockRequest = Extract<UserBlockRequest, { source: "upvoter" }>;

type SlotResult =
  | { readonly status: "preflight"; readonly result: CoordinatedBlockResult }
  | { readonly status: "remote"; readonly result: RemoteBlockResult };

export function stableRemoteBlockHash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function userLockName(userId: string): string {
  const hash = stableRemoteBlockHash32(userId).toString(16).padStart(8, "0");
  return `${USER_LOCK_PREFIX}-${hash}`;
}

function slotLockName(userId: string): string {
  const slot = stableRemoteBlockHash32(userId) % MAX_CONCURRENT_REMOTE_BLOCKS;
  return `${SLOT_LOCK_PREFIX}-${slot}`;
}

export function createRemoteBlockCoordinator(
  dependencies: RemoteBlockCoordinatorDependencies,
): RemoteBlockCoordinator {
  const inFlight = new Map<string, Promise<CoordinatedBlockResult>>();

  async function checkPreflight(
    request: DirectBlockRequest,
  ): Promise<CoordinatedBlockResult | null> {
    try {
      const result = await dependencies.preflightDirect(
        request.userId,
        request.expectedBlacklistedAt,
      );
      return result.status === "ready" ? null : { status: "skipped", reason: "existing" };
    } catch (error) {
      dependencies.reportStorageFailure(error);
      return { status: "failed", reason: "storage" };
    }
  }

  async function persistUpvoter(
    request: UpvoterBlockRequest,
    isStopped: () => boolean,
  ): Promise<CoordinatedBlockResult> {
    if (isStopped()) return { status: "stopped" };
    try {
      const result = await dependencies.commitUpvoter({
        platformId: ZHIHU_PLATFORM_ID,
        userId: request.userId,
        authorNameAtCapture: request.authorName,
        tagId: request.tagId,
        blacklistedAt: createBlacklistTimestamp(dependencies.now),
      });
      if (result.status === "invalid") {
        throw new Error("Unable to create an upvoter blacklist record.");
      }
      if (result.status === "duplicate") {
        return { status: "skipped", reason: "existing" };
      }
      return { status: "success", persistedUpvoter: true };
    } catch (error) {
      dependencies.reportStorageFailure(error);
      return { status: "failed", reason: "storage" };
    }
  }

  async function runInBlockSlot(
    request: DirectBlockRequest,
    isStopped: () => boolean,
  ): Promise<SlotResult> {
    return dependencies.withCrossContextLock(slotLockName(request.userId), async () => {
      if (isStopped()) return { status: "remote", result: { status: "stopped" } };
      const latestPreflight = await checkPreflight(request);
      if (latestPreflight) return { status: "preflight", result: latestPreflight };
      if (isStopped()) return { status: "remote", result: { status: "stopped" } };
      try {
        return {
          status: "remote",
          result: await dependencies.blockUser(request.userId, isStopped),
        };
      } catch {
        return {
          status: "remote",
          result: { status: "failed", reason: "network" },
        };
      }
    });
  }

  async function executeDirectUserLocked(
    request: DirectBlockRequest,
    isStopped: () => boolean,
  ): Promise<CoordinatedBlockResult> {
    if (isStopped()) return { status: "stopped" };
    const initialPreflight = await checkPreflight(request);
    if (initialPreflight) return initialPreflight;
    if (isStopped()) return { status: "stopped" };

    let slotResult: SlotResult;
    try {
      slotResult = await runInBlockSlot(request, isStopped);
    } catch {
      return { status: "failed", reason: "network" };
    }
    if (slotResult.status === "preflight") return slotResult.result;
    const remote = slotResult.result;
    if (remote.status === "stopped") return { status: "stopped" };
    if (remote.status === "failed") return { status: "failed", reason: remote.reason };
    return { status: "success", persistedUpvoter: false };
  }

  async function executeDirect(
    request: DirectBlockRequest,
    isStopped: () => boolean,
  ): Promise<CoordinatedBlockResult> {
    if (isStopped()) return { status: "stopped" };
    try {
      const locked = await dependencies.tryWithCrossContextUserLock(
        userLockName(request.userId),
        async () => executeDirectUserLocked(request, isStopped),
      );
      return locked.acquired ? locked.value : { status: "skipped", reason: "concurrent" };
    } catch {
      return { status: "failed", reason: "network" };
    }
  }

  return {
    async block(request, isStopped = () => false) {
      if (request.source === "upvoter") return persistUpvoter(request, isStopped);
      const existingRequest = inFlight.get(request.userId);
      if (existingRequest) {
        await existingRequest;
        return { status: "skipped", reason: "concurrent" };
      }
      const operation = executeDirect(request, isStopped);
      inFlight.set(request.userId, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(request.userId) === operation) inFlight.delete(request.userId);
      }
    },
  };
}
