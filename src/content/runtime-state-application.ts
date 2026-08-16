import {
  normalizeMemberHashId,
  type BlacklistState,
} from "./blacklist-state.ts";

interface RuntimeCardFilter {
  loadStableUserIds(userIds: ReadonlySet<string>): void;
}

interface RuntimeCommentFilter {
  refreshStableUserIds(userIds: ReadonlySet<string>, root: Node): void;
}

export interface RuntimeStateApplicationDependencies {
  readonly setCurrentState: (state: BlacklistState) => void;
  readonly renderTagChoices: () => void;
  readonly cardFilter: RuntimeCardFilter;
  readonly commentFilter: RuntimeCommentFilter;
}

export function applyBlacklistRuntimeState(
  state: BlacklistState,
  commentSearchRoot: Node,
  dependencies: RuntimeStateApplicationDependencies,
): void {
  dependencies.setCurrentState(state);
  dependencies.renderTagChoices();

  const stableUserIds = new Set(
    state.authors.flatMap((author) => {
      const userId = normalizeMemberHashId(author.userId) ?? author.userId;
      const memberHashId = normalizeMemberHashId(author.memberHashId);
      return memberHashId === null ? [userId] : [userId, memberHashId];
    }),
  );
  dependencies.cardFilter.loadStableUserIds(stableUserIds);
  dependencies.commentFilter.refreshStableUserIds(
    stableUserIds,
    commentSearchRoot,
  );
}
