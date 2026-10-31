import type { DrawerTarget } from "../../content/drawer-controller.ts";
import type { HoverAuthorActivation } from "../../content/hover-card-controller.ts";
import type { SourcePost } from "../../core/source-post.ts";

export function createHoverDrawerTarget(
  activation: HoverAuthorActivation,
  targetId: string,
  sourcePost: SourcePost | null,
): DrawerTarget<HTMLElement, HTMLButtonElement> {
  return {
    targetId,
    card: activation.root,
    button: activation.button,
    authorNameAtClick: activation.authorName,
    profileUserIdAtClick: activation.userId,
    memberHashIdAtClick: activation.memberHashId,
    anchorBounds: activation.anchorBounds,
    // Provenance never grants content-voter authorization to a hover entry.
    voterSource: null,
    sourcePost,
  };
}
