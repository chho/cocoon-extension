import {
  COMMENTS_CONTAINER_SELECTOR,
  COMMENT_ROOT_SELECTOR,
  resolveCommentAuthorUserId,
  type CommentFilterContext,
} from "../../content/comment-filter-controller.ts";
import type { SubmissionPoint } from "../../content/drawer-controller.ts";

function exposedElement(document: Document, point?: SubmissionPoint): Element | null {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const drawer = document.querySelector(".cocoon-tag-drawer:not([hidden])");
  if (!drawer || typeof document.elementsFromPoint !== "function") return null;
  try {
    const stack = document.elementsFromPoint(point.x, point.y);
    if (!stack[0] || !drawer.contains(stack[0])) return null;
    return stack.find((element) => !drawer.contains(element)) ?? null;
  } catch {
    return null;
  }
}

// Hit testing is UI context only, never evidence linking a hash to the submitted author.
export function captureCommentExposure(
  document: Document,
  point?: SubmissionPoint,
): readonly CommentFilterContext[] {
  const exposed = exposedElement(document, point);
  if (!exposed) return [];
  const container = exposed.closest(COMMENTS_CONTAINER_SELECTOR);
  if (!container) return [];
  const contexts: CommentFilterContext[] = [];
  for (
    let root = exposed.closest<HTMLElement>(COMMENT_ROOT_SELECTOR);
    root && root !== container && container.contains(root);
    root = root.parentElement?.closest<HTMLElement>(COMMENT_ROOT_SELECTOR) ?? null
  ) {
    const identifier = resolveCommentAuthorUserId(root);
    if (identifier) contexts.push({ root, identifier, dataId: root.getAttribute("data-id") });
  }
  return contexts;
}
