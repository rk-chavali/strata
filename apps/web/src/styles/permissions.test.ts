import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A disabled control must look refused, everywhere, in one rule.
 *
 * The gap this closes: role enforcement was correct on the server and correct in the UI, and
 * *silent* in both. A viewer opened strata, found every control greyed out, and had no way to
 * tell "you are not allowed" from "this is broken". Nothing in the app set `cursor: not-allowed`
 * at all, so the pointer stayed an ordinary arrow over a control that was refusing them.
 *
 * Asserted against the stylesheet text rather than a rendered DOM, matching `responsive.test.ts`:
 * this suite has no jsdom, and adding one to catch a CSS regression would be a large dependency
 * for a small guarantee. Walking the artefact and asserting a property of every case is the same
 * shape as the server's route audit.
 *
 * The regression this actually prevents is **re-specialisation**. The base rule is a bare
 * `button:disabled`, which any class-qualified selector outranks. Eight rules across four files
 * already did exactly that with `cursor: default`, and removing them once does not stop the next
 * person adding a ninth, silently, in the component they happen to be styling.
 */

const STYLES = dirname(fileURLToPath(import.meta.url));

function stylesheet(name: string): string {
  return readFileSync(join(STYLES, name), "utf8");
}

function stylesheets(): string[] {
  return readdirSync(STYLES).filter((name) => name.endsWith(".css"));
}

describe("the refusal cursor", () => {
  it("is declared once, in base.css, for every kind of disabled control", () => {
    const base = stylesheet("base.css");

    // One selector list covering all four, so a new disabled input is right without a new rule.
    expect(base).toMatch(/button:disabled,\s*input:disabled,\s*select:disabled,\s*textarea:disabled\s*\{\s*cursor: not-allowed;/);
  });

  it("is not overridden back to an ordinary pointer by any component rule", () => {
    /*
      `cursor: default` on a `:disabled` selector is the specific mistake. It is not a style
      preference: it makes the control indistinguishable from one that is merely unresponsive,
      which is the whole failure being fixed.
    */
    const offenders: string[] = [];

    for (const name of stylesheets()) {
      const text = stylesheet(name);

      for (const [index, line] of text.split("\n").entries()) {
        if (!line.includes(":disabled")) continue;
        // Single-line rule: selector and declarations together.
        if (/cursor:\s*(default|pointer|auto)/.test(line)) {
          offenders.push(`${name}:${index + 1} ${line.trim()}`);
        }
      }

      // Multi-line rule: the declaration sits in the block that a `:disabled` selector opened.
      for (const block of text.matchAll(/:disabled[^{]*\{([^}]*)\}/g)) {
        if (/cursor:\s*(default|pointer|auto)/.test(block[1] ?? "")) {
          offenders.push(`${name}: ${block[0]!.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }

    expect(offenders, "these put an ordinary cursor back on a refused control").toEqual([]);
  });
});

describe("the read-only banner", () => {
  it("only changes the main layout when it is actually shown", () => {
    /*
      Every page fills its grid cell by being the sole child of that area. Switching the cell to
      flex unconditionally would resize all of them to serve a strip most sessions never render,
      so the flex column hangs off a modifier rather than the base class.
    */
    const shell = stylesheet("shell.css");

    expect(shell).toMatch(/\.shell__main--banner\s*\{[^}]*display: flex/);
    // The base rule must stay layout-neutral.
    expect(shell).not.toMatch(/\.shell__main\s*\{[^}]*display: flex/);
  });

  it("does not scroll away with the page", () => {
    // `flex: none` against siblings that take `flex: 1`. A banner that scrolls off answers the
    // "why is everything greyed out" question only for people who have not scrolled yet.
    const shell = stylesheet("shell.css");
    expect(shell).toMatch(/\.readonly\s*\{[^}]*flex: none/);
  });
});
