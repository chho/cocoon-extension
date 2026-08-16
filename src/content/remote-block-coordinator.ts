import {
  DEFAULT_TAG_ID,
  createBlacklistTimestamp,
  planUpvoterCommit,
  type BlacklistState,
  type ParsedBlacklistState,
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
      readonly reason:
        | "authentication"
        | "rate-limit"
        | "csrf"
        | "network"
        | "http"
        | "storage";
    };

export type CrossContextTryLockResult<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

export interface RemoteBlockCoordinatorDependencies {
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withCrossContextLock: <T>(
    name: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly tryWithCrossContextUserLock: <T>(
    name: string,
    operation: () => Promise<T>,
  ) => Promise<CrossContextTryLockResult<T>>;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
  readonly applyPersistedState: (state: BlacklistState) => void;
  readonly now: () => Date;
  readonly blockUser: (
    userId: string,
    isStopped: () => boolean,
  ) => Promise<RemoteBlockResult>;
  readonly reportMalformedStorage: () => void;
  readonly reportStorageFailure: (error: unknown) => void;
}

export interface RemoteBlockCoordinator {
  block(
    request: UserBlockRequest,
    isStopped?: () => boolean,
  ): Promise<CoordinatedBlockResult>;
}

type PreflightResult = "ready" | "existing" | "invalid-tag" | "malformed";

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

  async function preflight(request: UserBlockRequest): Promise<PreflightResult> {
    return dependencies.withExclusiveLock(async () => {
      const parsed = await dependencies.readState();
      if (parsed.status === "malformed") {
        dependencies.reportMalformedStorage();
        return "malformed";
      }
      const existing = parsed.state.authors.find(
        (author) =>
          author.userId === request.userId ||
          author.memberHashId === request.userId,
      );
      if (request.source === "upvoter") {
        if (existing) {
          return "existing";
        }
        return parsed.state.tags.some((tag) => tag.tagId === request.tagId)
          ? "ready"
          : "invalid-tag";
      }
      return existing?.blockSource === "direct" &&
        existing.blacklistedAt === request.expectedBlacklistedAt
        ? "ready"
        : "existing";
    });
  }

  async function checkPreflight(
    request: UserBlockRequest,
  ): Promise<CoordinatedBlockResult | null> {
    let result: PreflightResult;
    try {
      result = await preflight(request);
    } catch (error) {
      dependencies.reportStorageFailure(error);
      return { status: "failed", reason: "storage" };
    }

    if (result === "ready") {
      return null;
    }
    if (result === "existing") {
      return { status: "skipped", reason: "existing" };
    }
    if (result === "invalid-tag") {
      dependencies.reportStorageFailure(
        new Error("The selected upvoter tag is not available."),
      );
    }
    return { status: "failed", reason: "storage" };
  }

  async function persistUpvoter(
    request: Extract<UserBlockRequest, { source: "upvoter" }>,
  ): Promise<boolean> {
    return dependencies.withExclusiveLock(async () => {
      const parsed = await dependencies.readState();
      if (parsed.status === "malformed") {
        dependencies.reportMalformedStorage();
        throw new Error("Stored blacklist state is malformed.");
      }
      if (
        parsed.state.authors.some(
          (author) =>
            author.userId === request.userId ||
            author.memberHashId === request.userId,
        )
      ) {
        return false;
      }
      const persistedTagId = parsed.state.tags.some(
        (tag) => tag.tagId === request.tagId,
      )
        ? request.tagId
        : DEFAULT_TAG_ID;
      const plan = planUpvoterCommit(parsed.state, {
        userId: request.userId,
        authorNameAtCapture: request.authorName,
        tagId: persistedTagId,
        blacklistedAt: createBlacklistTimestamp(dependencies.now),
      });
      if (plan.status !== "ready") {
        throw new Error("Unable to create an upvoter blacklist record.");
      }
      await dependencies.writeState(plan.state);
      dependencies.applyPersistedState(plan.state);
      return true;
    });
  }

  async function runInBlockSlot(
    request: UserBlockRequest,
    isStopped: () => boolean,
  ): Promise<SlotResult> {
    return dependencies.withCrossContextLock(
      slotLockName(request.userId),
      async () => {
        if (isStopped()) {
          return { status: "remote", result: { status: "stopped" } };
        }

        const latestPreflight = await checkPreflight(request);
        if (latestPreflight) {
          return { status: "preflight", result: latestPreflight };
        }
        if (isStopped()) {
          return { status: "remote", result: { status: "stopped" } };
        }

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
      },
    );
  }

  async function executeUserLocked(
    request: UserBlockRequest,
    isStopped: () => boolean,
  ): Promise<CoordinatedBlockResult> {
    if (isStopped()) {
      return { status: "stopped" };
    }

    const initialPreflight = await checkPreflight(request);
    if (initialPreflight) {
      return initialPreflight;
    }
    if (isStopped()) {
      return { status: "stopped" };
    }

    let slotResult: SlotResult;
    try {
      slotResult = await runInBlockSlot(request, isStopped);
    } catch {
      return { status: "failed", reason: "network" };
    }
    if (slotResult.status === "preflight") {
      return slotResult.result;
    }

    const remote = slotResult.result;
    if (remote.status === "stopped") {
      return { status: "stopped" };
    }
    if (remote.status === "failed") {
      return { status: "failed", reason: remote.reason };
    }
    if (request.source === "direct") {
      return { status: "success", persistedUpvoter: false };
    }

    try {
      const persistedUpvoter = await persistUpvoter(request);
      return { status: "success", persistedUpvoter };
    } catch (error) {
      dependencies.reportStorageFailure(error);
      return { status: "failed", reason: "storage" };
    }
  }

  async function execute(
    request: UserBlockRequest,
    isStopped: () => boolean,
  ): Promise<CoordinatedBlockResult> {
    if (isStopped()) {
      return { status: "stopped" };
    }
    try {
      const locked = await dependencies.tryWithCrossContextUserLock(
        userLockName(request.userId),
        async () => executeUserLocked(request, isStopped),
      );
      return locked.acquired
        ? locked.value
        : { status: "skipped", reason: "concurrent" };
    } catch {
      return { status: "failed", reason: "network" };
    }
  }

  return {
    async block(request, isStopped = () => false) {
      const existingRequest = inFlight.get(request.userId);
      if (existingRequest) {
        await existingRequest;
        return { status: "skipped", reason: "concurrent" };
      }

      const operation = execute(request, isStopped);
      inFlight.set(request.userId, operation);
      try {
        return await operation;
      } finally {
        if (inFlight.get(request.userId) === operation) {
          inFlight.delete(request.userId);
        }
      }
    },
  };
}
