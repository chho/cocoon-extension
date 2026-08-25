import type { BlacklistSnapshotDto } from "../core/blacklist-rpc-contract.ts";
import type { BlacklistRpcClient } from "./background-rpc.ts";

export async function loadBlacklistSnapshot(
  rpc: BlacklistRpcClient,
): Promise<BlacklistSnapshotDto> {
  const response = await rpc.request("snapshot");
  if (!response.ok || !response.data.snapshot) throw new Error("snapshot unavailable");
  return response.data.snapshot;
}
