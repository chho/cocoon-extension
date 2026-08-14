import type { RemoteAuthorization } from "./drawer-controller.ts";
import type { ZhihuContentSource } from "./zhihu-content-source.ts";

export interface RemoteOperationHandlers {
  readonly blockAuthor: () => void;
  readonly blockVoters: (source: ZhihuContentSource) => void;
}

export interface RemoteOperationDispatch {
  readonly authorStarted: boolean;
  readonly votersStarted: boolean;
}

export function runAuthorizedRemoteOperations(
  authorization: RemoteAuthorization,
  voterSource: ZhihuContentSource | null,
  handlers: RemoteOperationHandlers,
): RemoteOperationDispatch {
  const authorStarted = authorization.blockAuthorOnZhihu;
  const votersStarted =
    authorization.blockContentVoters && voterSource !== null;

  if (authorStarted) {
    handlers.blockAuthor();
  }
  if (votersStarted && voterSource) {
    handlers.blockVoters(voterSource);
  }

  return { authorStarted, votersStarted };
}
