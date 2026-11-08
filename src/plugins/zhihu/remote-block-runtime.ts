import type { BackgroundBlacklistClient } from "../../content/background-blacklist-client.ts";
import {
  createRemoteBlockCoordinator,
  type RemoteBlockCoordinatorDependencies,
} from "../../content/remote-block-coordinator.ts";
import { blockZhihuUser, type RemoteFetch } from "../../content/zhihu-remote-api.ts";
import { ZHIHU_PLATFORM_ID } from "../../content/blacklist-state.ts";

interface ZhihuRemoteBlockDependencies extends Pick<
  RemoteBlockCoordinatorDependencies,
  "withCrossContextLock" | "tryWithCrossContextUserLock"
> {
  readonly client: Pick<
    BackgroundBlacklistClient,
    "preflightDirect" | "preflightUpvoter" | "commitUpvoter"
  >;
  readonly fetchImpl: RemoteFetch;
  readonly readCookie: () => string;
}

export function createZhihuRemoteCoordinator(dependencies: ZhihuRemoteBlockDependencies) {
  const { client, fetchImpl, readCookie } = dependencies;
  return createRemoteBlockCoordinator({
    withCrossContextLock: dependencies.withCrossContextLock,
    tryWithCrossContextUserLock: dependencies.tryWithCrossContextUserLock,
    preflightDirect: (userId, expected) =>
      client.preflightDirect({ platformId: ZHIHU_PLATFORM_ID, userId }, expected),
    preflightUpvoter: (userId, expected) =>
      client.preflightUpvoter({ platformId: ZHIHU_PLATFORM_ID, userId }, expected),
    commitUpvoter: (input) => client.commitUpvoter(input),
    now: () => new Date(),
    blockUser: (userId, isStopped) =>
      blockZhihuUser(
        (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(10_000) }),
        userId,
        readCookie(),
        { isStopped },
      ),
    reportStorageFailure() {
      console.error("[Cocoon] 无法读取或保存屏蔽操作所需的本地状态。");
    },
  });
}
