import type { TagDeletionMutationResult } from "../background/blacklist-repository-types.ts";
import type { CancelInteraction } from "./drawer-controller.ts";

export type TagDeletionResult =
  | { readonly status: "persisted" }
  | { readonly status: "protected" | "missing" }
  | { readonly status: "failed"; readonly error: unknown };

export interface TagDeletionControllerDependencies {
  readonly deleteTag: (tagId: string) => Promise<TagDeletionMutationResult>;
  readonly reportFailure: (error: unknown) => void;
}

export interface TagDeletionController {
  deleteTag(tagId: string, interaction: CancelInteraction): Promise<TagDeletionResult>;
}

export function createTagDeletionController(
  dependencies: TagDeletionControllerDependencies,
): TagDeletionController {
  return {
    async deleteTag(tagId, interaction) {
      interaction.preventDefault();
      interaction.stopImmediatePropagation();
      try {
        const result = await dependencies.deleteTag(tagId);
        if (result.status !== "persisted") return { status: result.status };
        return { status: "persisted" };
      } catch (error) {
        dependencies.reportFailure(error);
        return { status: "failed", error };
      }
    },
  };
}
