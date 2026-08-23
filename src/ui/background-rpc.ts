import {
  createBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";

export class BlacklistRpcClientError extends Error {
  constructor() {
    super("Cocoon background returned an invalid response.");
  }
}

export interface BlacklistRpcClient {
  request(
    operation: BlacklistRpcOperation,
    input?: Record<string, unknown>,
  ): Promise<BlacklistRpcResponse>;
  removeOne(userId: string): Promise<BlacklistRpcResponse>;
  restoreOne(author: BlacklistAuthorDto): Promise<BlacklistRpcResponse>;
}

export function createBlacklistRpcClient(
  sendMessage: (message: unknown) => Promise<unknown>,
): BlacklistRpcClient {
  return {
    async request(operation, input = {}) {
      const response = await sendMessage(
        createBlacklistRpcRequest(operation, input),
      );
      const parsed = parseBlacklistRpcResponse(response, operation);
      if (!parsed) {
        throw new BlacklistRpcClientError();
      }
      return parsed;
    },
    removeOne(userId) {
      return this.request("remove-one", { userId });
    },
    restoreOne(author) {
      return this.request("restore-one", { author });
    },
  };
}
