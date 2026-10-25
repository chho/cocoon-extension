export const HOVER_MEMBER_HASH = "abcdef0123456789".repeat(2);

export function memberHoverMarkup(
  userId = "synthetic-author",
  memberHash = HOVER_MEMBER_HASH,
): string {
  return `<div class="hover-root">
    <a class="UserLink-link" href="/people/${userId}">Synthetic Author</a>
    <div class="HoverCard-item">
      <div class="NumberBoard">
        ${["answers", "posts", "followers"]
          .map(
            (section) =>
              `<a class="NumberBoard-item" href="/people/${memberHash}/${section}">${section}</a>`,
          )
          .join("")}
      </div>
      <div class="MemberButtonGroup ProfileButtonGroup HoverCard-buttons"></div>
    </div>
  </div>`;
}
