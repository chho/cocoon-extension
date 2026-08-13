import {
  planTagDeletion,
  type BlacklistState,
  type ParsedBlacklistState,
} from "./blacklist-state.ts";
import type { CancelInteraction } from "./drawer-controller.ts";

export type TagDeletionResult =
  | { readonly status: "persisted"; readonly state: BlacklistState }
  | { readonly status: "protected" | "missing" }
  | { readonly status: "failed"; readonly error: unknown };

export interface TagDeletionControllerDependencies {
  readonly withExclusiveLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly readState: () => Promise<ParsedBlacklistState>;
  readonly writeState: (state: BlacklistState) => Promise<void>;
  readonly applyPersistedState: (state: BlacklistState) => void;
  readonly reportFailure: (error: unknown) => void;
}

export interface TagDeletionController {
  deleteTag(
    tagId: string,
    interaction: CancelInteraction,
  ): Promise<TagDeletionResult>;
}

export function createTagDeletionController(
  dependencies: TagDeletionControllerDependencies,
): TagDeletionController {
  async function deleteLocked(tagId: string): Promise<TagDeletionResult> {
    const parsed = await dependencies.readState();
    if (parsed.status === "malformed") {
      throw new Error("Stored blacklist state is malformed.");
    }

    const plan = planTagDeletion(parsed.state, tagId);
    if (plan.status !== "ready") {
      return { status: plan.status };
    }

    await dependencies.writeState(plan.state);
    dependencies.applyPersistedState(plan.state);
    return { status: "persisted", state: plan.state };
  }

  return {
    async deleteTag(tagId, interaction) {
      interaction.preventDefault();
      interaction.stopImmediatePropagation();
      try {
        return await dependencies.withExclusiveLock(async () =>
          deleteLocked(tagId),
        );
      } catch (error) {
        dependencies.reportFailure(error);
        return { status: "failed", error };
      }
    },
  };
}
