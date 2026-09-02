import type { JSX } from "react";

/**
 * The icon set.
 *
 * One set, one grid, one stroke weight. Every icon is drawn on a 16px viewBox with a
 * 1.5 stroke and no fill, and takes its colour from `currentColor`, so an icon
 * always matches the text beside it, at every size and in both themes.
 *
 * The previous version mixed colour emoji with geometric unicode glyphs. Those render
 * at different sizes, weights and colours depending on the platform's font fallback,
 * which is most of why the UI looked unfinished.
 */

const PATHS = {
  table: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 6h12M6.5 6v7.5" /></>,
  entity: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6.5h12" /></>,
  concept: <><path d="M8 2.2 13.8 8 8 13.8 2.2 8z" /></>,
  key: <><circle cx="5.5" cy="6.5" r="2.5" /><path d="M7.5 8.5 13 14M11 12l1.5-1.5M9.5 10.5 11 9" /></>,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  trash: <><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" /></>,
  edit: <path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5z" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  /**
   * Sliders, not a gear.
   *
   * The gear was a circle with radiating spokes, which at 16px is the same drawing as
   * the sun used for the theme toggle, and the two sat next to each other in the rail,
   * so neither could be told from the other.
   */
  settings: <><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /><circle cx="5.5" cy="4.5" r="1.6" fill="var(--n0)" /><circle cx="10.5" cy="8" r="1.6" fill="var(--n0)" /><circle cx="6.5" cy="11.5" r="1.6" fill="var(--n0)" /></>,
  users: <><circle cx="6.5" cy="5.5" r="2.5" /><path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 3.4a2.4 2.4 0 0 1 0 4.4M12.5 13.5c0-1.6-.5-2.7-1.3-3.4" /></>,
  branch: <><circle cx="4.5" cy="3.5" r="1.8" /><circle cx="4.5" cy="12.5" r="1.8" /><circle cx="11.5" cy="5.5" r="1.8" /><path d="M4.5 5.3v5.4M11.5 7.3c0 2.2-2 3-4.4 3.3" /></>,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  warn: <><path d="M8 2.5 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></>,
  layers: <><path d="M8 2 14 5.5 8 9 2 5.5z" /><path d="M2 9.5 8 13l6-3.5" /></>,
  note: <><path d="M3 2.5h10v7l-3.5 4H3z" /><path d="M13 9.5H9.5v4M5.5 5.5h5M5.5 8h3" /></>,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  grid: <><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>,
  chevronDown: <path d="M4 6.5 8 10.5 12 6.5" />,
  chevronRight: <path d="M6.5 4 10.5 8 6.5 12" />,
  chevronLeft: <path d="M9.5 4 5.5 8 9.5 12" />,
  chevronUp: <path d="M4 9.5 8 5.5 12 9.5" />,
  pr: <><path d="M5.5 13V6.5A3 3 0 0 1 8.5 3.5H12" /><path d="M9.5 1.5 12 3.5 9.5 5.5" /><circle cx="5.5" cy="13" r="1.6" /></>,
  refresh: <><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" /><path d="M13.7 1.5v3h-3" /></>,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  /**
   * The row-actions kebab: three dots, vertical.
   *
   * Filled rather than stroked, because at 13px a 1.5-stroke ring reads as a smudge while
   * a solid dot stays a dot. `currentColor` is set explicitly since the set's default is
   * `fill: none`, which would render this as nothing at all.
   */
  kebab: <><circle cx="8" cy="3.2" r="1.25" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" /><circle cx="8" cy="12.8" r="1.25" fill="currentColor" stroke="none" /></>,
  shield: <><path d="M8 1.8 13.2 4v4c0 3.2-2.2 5.4-5.2 6.2C5 13.4 2.8 11.2 2.8 8V4z" /><path d="M6 8l1.6 1.6L10.2 7" /></>,
  flow: <><rect x="1.5" y="5.5" width="4" height="5" rx="1" /><rect x="10.5" y="2.5" width="4" height="4" rx="1" /><rect x="10.5" y="9.5" width="4" height="4" rx="1" /><path d="M5.5 7.5h2.5v-3h2.5M5.5 8.5h2.5v3h2.5" /></>,
  link: <><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.5 3a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5 7.5 13a2.8 2.8 0 0 1-4-4L5 7.5" /></>,
  folder: <path d="M2 12.5v-9h4l1.5 2h6.5v7z" />,
  /** A luggage tag, as Harness marks a tag count beside a name. */
  tag: <><path d="M8.5 2H13.5v5L7 13.5 2.5 9z" /><circle cx="11" cy="4.5" r="0.9" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  upload: <><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" /><path d="M8 2.5v8M5 5.5 8 2.5l3 3" /></>,
  arrowRight: <path d="M2.5 8h11M9.5 4l4 4-4 4" />,
  compare: <><rect x="1.5" y="3.5" width="5.5" height="9" rx="1" /><rect x="9" y="3.5" width="5.5" height="9" rx="1" /><path d="M8 1.5v13" /></>,
  code: <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9 3l-2 10" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" /></>,
  moon: <path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6z" />,
  signout: <><path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6" /><path d="M10 5.5 12.5 8 10 10.5M6 8h6.5" /></>,
  doc: <><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3M5.5 8h5M5.5 10.5h3" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,

  // Text formatting. Drawn as letterforms rather than glyphs so they sit on the same
  // 16px grid and stroke weight as everything else.
  bold: <><path d="M5 2.8h4a2.6 2.6 0 0 1 0 5.2H5z" /><path d="M5 8h4.6a2.6 2.6 0 0 1 0 5.2H5z" /></>,
  italic: <path d="M10.5 2.8h-3M8.5 13.2h-3M9.5 2.8 6.5 13.2" />,
  underline: <><path d="M4.5 2.5v5a3.5 3.5 0 0 0 7 0v-5" /><path d="M3.5 13.5h9" /></>,
  alignLeft: <path d="M2.5 3.5h11M2.5 6.8h7M2.5 10h11M2.5 13.2h7" />,
  alignCenter: <path d="M2.5 3.5h11M4.5 6.8h7M2.5 10h11M4.5 13.2h7" />,
  alignRight: <path d="M2.5 3.5h11M6.5 6.8h7M2.5 10h11M6.5 13.2h7" />,

  // Object alignment. A guide line plus the two boxes it aligns.
  objLeft: <><path d="M2.5 2v12" /><rect x="5" y="3.5" width="8" height="3.5" rx="1" /><rect x="5" y="9" width="5" height="3.5" rx="1" /></>,
  objCenterX: <><path d="M8 2v12" /><rect x="3.5" y="3.5" width="9" height="3.5" rx="1" /><rect x="5.5" y="9" width="5" height="3.5" rx="1" /></>,
  objRight: <><path d="M13.5 2v12" /><rect x="3" y="3.5" width="8" height="3.5" rx="1" /><rect x="6" y="9" width="5" height="3.5" rx="1" /></>,
  objTop: <><path d="M2 2.5h12" /><rect x="3.5" y="5" width="3.5" height="8" rx="1" /><rect x="9" y="5" width="3.5" height="5" rx="1" /></>,
  objCenterY: <><path d="M2 8h12" /><rect x="3.5" y="3.5" width="3.5" height="9" rx="1" /><rect x="9" y="5.5" width="3.5" height="5" rx="1" /></>,
  objBottom: <><path d="M2 13.5h12" /><rect x="3.5" y="3" width="3.5" height="8" rx="1" /><rect x="9" y="6" width="3.5" height="5" rx="1" /></>,
  distH: <><path d="M2.5 2v12M13.5 2v12" /><rect x="6" y="4.5" width="4" height="7" rx="1" /></>,
  distV: <><path d="M2 2.5h12M2 13.5h12" /><rect x="4.5" y="6" width="7" height="4" rx="1" /></>,

  // Shape palette.
  shapeRect: <rect x="2" y="4" width="12" height="8" rx="1" />,
  shapeRounded: <rect x="2" y="4" width="12" height="8" rx="3" />,
  shapeEllipse: <ellipse cx="8" cy="8" rx="6" ry="4.2" />,
  shapeDiamond: <polygon points="8,2.5 13.5,8 8,13.5 2.5,8" />,
  shapeCylinder: <><path d="M3 4.6v6.8c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6V4.6" /><ellipse cx="8" cy="4.6" rx="5" ry="1.6" /></>,
  shapeProcess: <><rect x="2" y="4" width="12" height="8" rx="1" /><path d="M4.6 4v8M11.4 4v8" /></>,
  shapeParallelogram: <polygon points="4.5,4 14,4 11.5,12 2,12" />,
  shapeHexagon: <polygon points="4.6,4 11.4,4 14,8 11.4,12 4.6,12 2,8" />,
  shapeText: <path d="M3 4.5V3.5h10v1M8 3.5v9M6 12.5h4" />,
  shapeNote: <><path d="M2.5 3h11v7l-3 3h-8z" /><path d="M13.5 10h-3v3" /></>,
  connector: <><path d="M2.5 12.5 13 3.5" /><path d="M9 3.5h4v4" /></>,
  cursor: <path d="M3.5 2.5 12 8.5l-3.6.6L10 13l-1.8.8-1.6-3.9-2.6 2.3z" />,
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}

export function Icon({ name, size = 16, className, title }: Props): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{ flex: "none", display: "block" }}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
