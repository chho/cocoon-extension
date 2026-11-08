import type { RemoteBlockCoordinator } from "../../content/remote-block-coordinator.ts";
import { createVoterBatchController } from "../../content/voter-batch-controller.ts";
import type { VoterObserver } from "../../content/voter-observation.ts";
import {
  fetchCurrentZhihuUser,
  fetchZhihuVoters,
  type RemoteFetch,
} from "../../content/zhihu-remote-api.ts";

export function createZhihuVoterBatch(
  coordinator: RemoteBlockCoordinator,
  fetchImpl: RemoteFetch,
  observer?: VoterObserver,
) {
  return createVoterBatchController({
    fetchCurrentUser: (isStopped) => fetchCurrentZhihuUser(fetchImpl, { isStopped }),
    fetchVoters: (source, isStopped, onProgress) =>
      fetchZhihuVoters(fetchImpl, source, {
        isStopped,
        onProgress,
        observer,
      }),
    coordinator,
    observer,
    reportProgress() {},
  });
}
