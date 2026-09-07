import type { JSX } from "react";

/**
 * The strata mark: three beds, each stepped right.
 *
 * **Not part of the icon set, deliberately.** Every icon in `Icon.tsx` is stroke-only on a 16px
 * grid so it can sit beside text at any size and take its colour from `currentColor`. A logo has
 * the opposite job: it has to be solid enough to survive a 16px favicon, where a 1.5px stroke
 * turns to grey mush. Keeping it out of that set is what stops someone reasonably "fixing" it
 * later to match the others.
 *
 * The stagger is the whole idea. Flat layers would read as a generic list; tilted ones read as
 * sedimentary rock, which is what the product is named after, and give the mark direction without
 * resorting to an arrow.
 *
 * Opacity rather than three colours, so it works in one ink: on the accent tile, in the favicon,
 * and in a print or single-colour context nobody has asked for yet.
 */
export function Logo({
  size = 16,
  title,
}: {
  size?: number;
  /** Supply only where the mark stands alone. Beside the wordmark it is decorative. */
  title?: string;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      role={title ? "img" : "presentation"}
      {...(title ? {} : { "aria-hidden": true })}
      style={{ flex: "none", display: "block" }}
    >
      {title ? <title>{title}</title> : null}
      <rect x="4" y="6" width="17" height="5" rx="2.5" />
      <rect x="7.5" y="13.5" width="17" height="5" rx="2.5" opacity="0.62" />
      <rect x="11" y="21" width="17" height="5" rx="2.5" opacity="0.32" />
    </svg>
  );
}
