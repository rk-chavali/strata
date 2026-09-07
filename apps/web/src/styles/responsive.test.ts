import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Layout invariants that three separate overlap bugs all violated.
 *
 * These are asserted against the stylesheet text rather than a rendered DOM, on purpose.
 * The web suite has no jsdom and no testing library, and adding both to catch a CSS
 * regression would be a large dependency for a small guarantee. This is the same shape as
 * `routes.test.ts` in the server: walk the artefact, assert a property of every case,
 * rather than mock something and assert it was called.
 *
 * What went wrong, so nobody re-introduces it while tidying:
 *
 * 1. `.page__centre` was `position: absolute; left: 50%`, centred on the title row without
 *    reserving any width. It only looked right while the heading and the actions happened
 *    to leave a hole in the middle. At 768px it drew straight over both: the tier badge sat
 *    under the Diagram toggle and "Repository" was clipped by Export.
 *
 * 2. The collapsed sidebar was described twice, once as `.nav--collapsed` and once as a
 *    hand copy inside `@media (max-width: 900px)`. The copy reproduced three of the eight
 *    rule groups, so below 900px the dirty marker, the twisties, the depth indents and the
 *    collapse button's own label all kept expanded styling inside a 48px rail.
 *
 * 3. `.canvasbar` was a no-wrap flex row. Nothing above it scrolls, so its right-hand group
 *    was not clipped-but-scrollable, it was unreachable: 841px of content in a 664px box.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(here, path), "utf8");

const shell = read("shell.css");
const pageTsx = read("../app/Page.tsx");
const appShellTsx = read("../app/AppShell.tsx");

/** The body of the first `@media (<query>)` block, brace-matched. */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start === -1) throw new Error(`no @media ${query} block in the stylesheet`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after @media ${query}`);
}

/** The declarations of a top-level rule, e.g. `.canvasbar`. */
function rule(css: string, selector: string): string {
  const marker = `\n${selector} {`;
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`no \`${selector}\` rule in the stylesheet`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("page header centre zone", () => {
  it("reserves a grid track instead of overlaying the row", () => {
    const centred = rule(shell, ".page__titlerow--centred");
    expect(centred).toMatch(/display:\s*grid/);
    // Two equal side tracks keep the centre optically centred; `auto` is its own space.
    expect(centred).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
  });

  it("takes the centre out of absolute positioning once the row is a grid", () => {
    expect(rule(shell, ".page__titlerow--centred .page__centre")).toMatch(/position:\s*static/);
  });

  it("stacks the centre onto its own row rather than crushing the title", () => {
    const narrow = mediaBlock(shell, "(width <= 1100px)");
    expect(narrow).toContain(".page__titlerow--centred");
    expect(narrow).toMatch(/grid-row:\s*2/);
  });

  it("is what Page.tsx actually asks for", () => {
    // The CSS above is dead unless the component emits the modifier.
    expect(pageTsx).toContain("page__titlerow--centred");
    expect(pageTsx).toMatch(/centre\s*\?\s*" page__titlerow--centred"/);
  });
});

describe("collapsed sidebar", () => {
  it("is described once, by the class, not again by the media query", () => {
    const narrow = mediaBlock(shell, "(max-width: 900px)");
    // Any `.nav` selector here means the duplication is back.
    expect(narrow).not.toMatch(/\.nav[^a-z-]/);
    expect(narrow).not.toContain(".nav__item");
    expect(narrow).not.toContain(".nav__collapse");
  });

  it("applies that one class from the viewport as well as the preference", () => {
    expect(appShellTsx).toContain('useMediaQuery("(max-width: 900px)")');
    expect(appShellTsx).toMatch(/collapsed=\{navCollapsed \|\| navTooNarrow\}/);
  });

  it("hides the toggle when the width leaves nothing to toggle", () => {
    expect(appShellTsx).toMatch(/navTooNarrow\s*\?\s*undefined/);
  });
});

describe("canvas toolbar", () => {
  it("wraps rather than pushing controls past the clipping edge", () => {
    expect(rule(shell, ".canvasbar")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("lets the fixed run of drawing tools scroll at the narrowest widths", () => {
    // Wrapping alone cannot help a single group that is wider than the bar.
    expect(shell).toMatch(/\.canvasbar \.shapebar \{[^}]*overflow-x:\s*auto/);
  });
});
