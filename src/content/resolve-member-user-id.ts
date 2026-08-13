import { parseMemberUrlToken } from "./parse-zhihu-member-data.ts";

export interface MemberFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type MemberFetch = (
  input: string,
  init: { credentials: "same-origin" },
) => Promise<MemberFetchResponse>;

export type MemberUserIdResolver = (
  memberHash: string,
) => Promise<string | null>;

export function createMemberUserIdResolver(
  fetchMember: MemberFetch,
): MemberUserIdResolver {
  const successfulUserIds = new Map<string, string>();
  const inFlightRequests = new Map<string, Promise<string | null>>();

  async function requestMemberUserId(
    memberHash: string,
  ): Promise<string | null> {
    try {
      const response = await fetchMember(
        `/api/v4/members/${encodeURIComponent(memberHash)}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) {
        return null;
      }

      const value: unknown = await response.json();
      const userId = parseMemberUrlToken(value);
      if (userId) {
        successfulUserIds.set(memberHash, userId);
      }

      return userId;
    } catch {
      return null;
    }
  }

  async function removeSettledRequest(
    memberHash: string,
    request: Promise<string | null>,
  ): Promise<void> {
    try {
      await request;
    } finally {
      if (inFlightRequests.get(memberHash) === request) {
        inFlightRequests.delete(memberHash);
      }
    }
  }

  return async (memberHash: string): Promise<string | null> => {
    const cachedUserId = successfulUserIds.get(memberHash);
    if (cachedUserId) {
      return cachedUserId;
    }

    const inFlightRequest = inFlightRequests.get(memberHash);
    if (inFlightRequest) {
      return inFlightRequest;
    }

    const request = requestMemberUserId(memberHash);
    inFlightRequests.set(memberHash, request);
    void removeSettledRequest(memberHash, request);

    return request;
  };
}
