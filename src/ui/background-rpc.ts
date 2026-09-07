import {
  parseBlacklistQueryRequest,
  parseBlacklistQueryResponse,
  type BlacklistQueryRequest,
  type BlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import {
  createBlacklistRpcRequest,
  parseBlacklistRpcRequest,
  parseBlacklistRpcResponse,
  type BlacklistAuthorDto,
  type BlacklistAuthorIdentityDto,
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
  removeOne(identity: BlacklistAuthorIdentityDto): Promise<BlacklistRpcResponse>;
  restoreOne(author: BlacklistAuthorDto): Promise<BlacklistRpcResponse>;
}

export interface BlacklistQueryRpcClient {
  query(request: BlacklistQueryRequest): Promise<BlacklistQueryResponse>;
}

export type StrictBlacklistRpcClient = BlacklistRpcClient & BlacklistQueryRpcClient;

export function createBlacklistRpcClient(
  sendMessage: (message: unknown) => Promise<unknown>,
): StrictBlacklistRpcClient {
  return {
    async request(operation, input = {}) {
      const request = parseBlacklistRpcRequest(createBlacklistRpcRequest(operation, input));
      if (!request) throw new BlacklistRpcClientError();
      const response = await sendMessage(request);
      const parsed = parseBlacklistRpcResponse(response, operation);
      if (!parsed) {
        throw new BlacklistRpcClientError();
      }
      return parsed;
    },
    async query(request) {
      const parsedRequest = parseBlacklistQueryRequest(request);
      if (!parsedRequest) {
        throw new BlacklistRpcClientError();
      }
      const response = await sendMessage(parsedRequest);
      const parsed = parseBlacklistQueryResponse(response, parsedRequest.operation);
      if (!parsed) {
        throw new BlacklistRpcClientError();
      }
      return parsed;
    },
    removeOne(identity) {
      return this.request("remove-one", { identity });
    },
    restoreOne(author) {
      return this.request("restore-one", { author });
    },
  };
}
