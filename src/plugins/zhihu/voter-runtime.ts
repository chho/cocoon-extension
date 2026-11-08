import type { RemoteBlockCoordinator } from "../../content/remote-block-coordinator.ts";
import type * as PlatformPreferenceModule from "../../core/platform-block-preference.ts";
// @ts-expect-error Vite isolates content helpers from extension-page shared chunks.
import * as platformPreference from "../../core/platform-block-preference.ts?content-copy";
const { PLATFORM_BLOCK_PREFERENCE_KEY, parsePlatformBlockPreference } =
  platformPreference as typeof PlatformPreferenceModule;
import { createVoterBatchController } from "../../content/voter-batch-controller.ts";
import type { VoterObserver } from "../../content/voter-observation.ts";
import {
  fetchCurrentZhihuUser,
  fetchZhihuVoters,
  type RemoteFetch,
} from "../../content/zhihu-remote-api.ts";

export async function readVoterPlatformBlockPreference(storage: {
  get(key: string): Promise<Record<string, unknown>>;
}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 1_500);
  });
  try {
    const values = await Promise.race([storage.get(PLATFORM_BLOCK_PREFERENCE_KEY), expired]);
    return parsePlatformBlockPreference(values?.[PLATFORM_BLOCK_PREFERENCE_KEY]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

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
