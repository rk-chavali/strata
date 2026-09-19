import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import {
  RULES,
  loadSkills,
  parseAgentFindings,
  parseSkill,
  runGate,
  runSkill,
  setEnabledInSource,
  setSkillEnabled,
} from "./skills.js";

/**
 * Skills, against a real workspace on disk.
 *
 * The behaviours worth guarding are the ones that decide whether a governance control can be
 * trusted: a broken skill must not silently stop enforcing, an unconfigured agent must not report
 * success it has not earned, and `blocking` versus `advisory` must be the difference between a
 * refused proposal and an annotated one.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function skill(name: string, content: string): Promise<void> {
  await write(`.strata/skills/${name}.md`, content);
}

async function load(): Promise<LoadedWorkspace> {
  return loadWorkspace(root);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-skills-"));

  await write(
    "strata.config.yaml",
    `version: 1
name: governed
roots:
  - "."
`,
  );
  await write(
    "models/model.yaml",
    `id: m1
kind: model
name: warehouse
tier: physical
`,
  );
  await write(
    "models/tmp_staging.yaml",
    `id: tbl_tmp
kind: table
name: tmp_staging
model: warehouse
columns:
  - id: c1
    name: id
    dataType: INT64
`,
  );
  await write(
    "models/dim_customer.yaml",
    `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
description: One row per customer.
columns:
  - id: c2
    name: customer_key
    dataType: INT64
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("parsing", () => {
  it("reads frontmatter and keeps the body as the reasoning", () => {
    const parsed = parseSkill(
      `---
name: no-temp-tables
description: No temporary tables in the warehouse.
kind: check
rule: forbidden-words
severity: blocking
config:
  words: [tmp, temp]
---
Temporary tables outlive the person who made them.`,
      ".strata/skills/no-temp.md",
    );

    expect(parsed.name).toBe("no-temp-tables");
    expect(parsed.severity).toBe("blocking");
    expect(parsed.rule).toBe("forbidden-words");
    expect(parsed.config.words).toEqual(["tmp", "temp"]);
    expect(parsed.body).toContain("outlive");
  });

  it("defaults to enabled and advisory", () => {
    // A skill someone committed is one they meant to run; advisory is the safe default severity.
    const parsed = parseSkill(`---\nrule: naming\n---\n`, ".strata/skills/x.md");
    expect(parsed.enabled).toBe(true);
    expect(parsed.severity).toBe("advisory");
  });

  it("names itself after the file when the frontmatter does not", () => {
    const parsed = parseSkill(`---\nrule: naming\n---\n`, ".strata/skills/grain-required.md");
    expect(parsed.name).toBe("grain-required");
  });

  it("rejects a check skill with no rule", () => {
    expect(() => parseSkill(`---\nkind: check\n---\n`, "x.md")).toThrow(/must name a .rule./);
  });

  it("rejects an unknown rule by name, listing the real ones", () => {
    expect(() => parseSkill(`---\nrule: no-such-rule\n---\n`, "x.md")).toThrow(/unknown rule/);
  });

  it("rejects a file with no frontmatter", () => {
    expect(() => parseSkill(`Just some prose.`, "x.md")).toThrow(/frontmatter/);
  });

  it("does not end the frontmatter early on a YAML document separator", () => {
    /*
      YAML's own document separator is also `---`, so a regex over the whole file terminates the
      block at the wrong place and silently drops half the metadata, including, in the worst
      case, `severity: blocking`.
    */
    const parsed = parseSkill(
      `---
rule: forbidden-words
config:
  words: ["---"]
severity: blocking
---
body`,
      "x.md",
    );
    expect(parsed.severity).toBe("blocking");
  });
});

describe("loading", () => {
  it("returns an empty list when the workspace has no skills", async () => {
    // Not an error: most workspaces have not adopted skills.
    expect(await loadSkills(root)).toEqual([]);
  });

  it("keeps a broken skill, disabled, with its error", async () => {
    await skill("broken", `---\nkind: check\n---\nno rule here`);
    const [found] = await loadSkills(root);

    /*
      The important half is `enabled: false`.

      Reporting a malformed skill as enabled would block every proposal in the workspace until
      someone fixed the file, turning a typo into an outage. Dropping it silently would be worse
      still: someone would believe a control was running when it was not.
    */
    expect(found!.error).toMatch(/must name a .rule./);
    expect(found!.enabled).toBe(false);
  });
});

describe("built-in rules", () => {
  it("forbidden-words finds the offending object and names the word", async () => {
    await skill(
      "no-temp",
      `---
rule: forbidden-words
severity: blocking
config:
  words: [tmp]
  kinds: [table]
---`,
    );

    const workspace = await load();
    const [found] = await loadSkills(root);
    const run = await runSkill(workspace, found!);

    expect(run.status).toBe("failed");
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]!.objectName).toBe("tmp_staging");
    expect(run.findings[0]!.message).toContain("tmp");
    // The file matters: a finding you cannot locate is a complaint, not a review comment.
    expect(run.findings[0]!.file).toBe("models/tmp_staging.yaml");
  });

  it("forbidden-words respects the kind filter", async () => {
    await skill(
      "no-temp",
      `---
rule: forbidden-words
config:
  words: [tmp]
  kinds: [entity]
---`,
    );
    const run = await runSkill(await load(), (await loadSkills(root))[0]!);
    expect(run.status).toBe("passed");
  });

  it("required-description flags only what is missing one", async () => {
    await skill(
      "describe-tables",
      `---
rule: required-description
config:
  kinds: [table]
---`,
    );

    const run = await runSkill(await load(), (await loadSkills(root))[0]!);

    expect(run.findings.map((f) => f.objectName)).toEqual(["tmp_staging"]);
  });

  it("required-field reports a table with no grain", async () => {
    await skill(
      "grain",
      `---
rule: required-field
config:
  field: grain
  kinds: [table]
---`,
    );

    const run = await runSkill(await load(), (await loadSkills(root))[0]!);
    expect(run.findings).toHaveLength(2);
    expect(run.findings[0]!.message).toContain("grain");
  });

  it("passes when nothing violates the rule", async () => {
    await skill(
      "no-zzz",
      `---
rule: forbidden-words
config:
  words: [zzz]
---`,
    );
    const run = await runSkill(await load(), (await loadSkills(root))[0]!);
    expect(run.status).toBe("passed");
    expect(run.findings).toEqual([]);
  });

  it("exposes every rule the parser will accept", () => {
    // The parser validates `rule` against this map, so a rule named in docs but missing here
    // would fail at load time rather than at run time.
    expect(Object.keys(RULES).sort()).toEqual([
      "classification-coverage",
      "forbidden-words",
      "naming",
      "required-description",
      "required-field",
    ]);
  });
});

describe("agent skills", () => {
  it("is skipped, not passed, when no provider is configured", async () => {
    await skill(
      "grain-sense",
      `---
kind: agent
severity: advisory
---
Does each table's grain match its name?`,
    );

    const run = await runSkill(await load(), (await loadSkills(root))[0]!);

    /*
      The distinction that matters.

      Reporting `passed` because nothing ran would produce a green tick nobody earned, and a
      governance page full of unearned green ticks is worse than one that says "not configured".
    */
    expect(run.status).toBe("skipped");
    expect(run.reason).toContain("provider");
    expect(run.findings).toEqual([]);
  });

  it("turns the model's reply into findings", async () => {
    await skill(
      "grain-sense",
      `---
kind: agent
severity: advisory
---
Check the grain.`,
    );

    const run = await runSkill(await load(), (await loadSkills(root))[0]!, {
      complete: async () => "dim_customer: the name implies one row per customer but no grain is stated.",
    });

    expect(run.status).toBe("failed");
    expect(run.findings[0]!.objectName).toBe("dim_customer");
  });

  it("passes when the model reports OK", async () => {
    await skill("grain-sense", `---\nkind: agent\n---\nCheck.`);
    const run = await runSkill(await load(), (await loadSkills(root))[0]!, {
      complete: async () => "OK",
    });
    expect(run.status).toBe("passed");
  });

  it("sends the prompt and a model summary, and errors without a prompt", async () => {
    await skill("empty", `---\nkind: agent\n---\n`);
    const run = await runSkill(await load(), (await loadSkills(root))[0]!, {
      complete: async () => "OK",
    });
    expect(run.status).toBe("errored");
    expect(run.reason).toContain("prompt");
  });

  it("records a provider failure as errored rather than letting it escape", async () => {
    await skill("grain-sense", `---\nkind: agent\n---\nCheck.`);
    const run = await runSkill(await load(), (await loadSkills(root))[0]!, {
      complete: async () => {
        throw new Error("429 rate limited");
      },
    });
    expect(run.status).toBe("errored");
    expect(run.reason).toContain("429");
  });
});

describe("parseAgentFindings", () => {
  it("tolerates list markers and blank lines", () => {
    const parsed = parseAgentFindings("- a: one\n\n* b: two\n", {
      name: "s",
      severity: "advisory",
    } as never);
    expect(parsed.map((f) => f.objectName)).toEqual(["a", "b"]);
  });

  it("treats several ways of saying nothing as nothing", () => {
    for (const reply of ["OK", "ok", "No issues found", "no findings"]) {
      expect(parseAgentFindings(reply, { name: "s", severity: "advisory" } as never)).toEqual([]);
    }
  });
});

describe("the gate", () => {
  it("separates blocking findings from advisory ones", async () => {
    await skill(
      "no-temp",
      `---
rule: forbidden-words
severity: blocking
config: { words: [tmp] }
---`,
    );
    await skill(
      "describe",
      `---
rule: required-description
severity: advisory
config: { kinds: [table] }
---`,
    );

    const result = await runGate(await load());

    expect(result.runs).toHaveLength(2);
    expect(result.blocking).toHaveLength(1);
    expect(result.advisory).toHaveLength(1);
    expect(result.blocking[0]!.skill).toBe("no-temp");
  });

  it("ignores a disabled skill", async () => {
    await skill(
      "off",
      `---
rule: forbidden-words
severity: blocking
enabled: false
config: { words: [tmp] }
---`,
    );

    const result = await runGate(await load());
    expect(result.runs).toHaveLength(0);
    expect(result.blocking).toEqual([]);
  });

  it("runs a disabled skill only when explicitly asked, for the authoring loop", async () => {
    await skill(
      "off",
      `---
rule: forbidden-words
enabled: false
config: { words: [tmp] }
---`,
    );

    // The Run button on the skills page passes this; the propose gate never does.
    const result = await runGate(await load(), { includeDisabled: true });
    expect(result.runs).toHaveLength(1);
  });

  it("runs one named skill when asked", async () => {
    await skill("a", `---\nrule: forbidden-words\nconfig: { words: [tmp] }\n---`);
    await skill("b", `---\nrule: required-description\n---`);

    const result = await runGate(await load(), { only: "a" });
    expect(result.runs.map((r) => r.skill)).toEqual(["a"]);
  });

  it("lets a broken skill report itself without stopping the others", async () => {
    await skill("broken", `---\nkind: check\n---`);
    await skill(
      "works",
      `---
rule: forbidden-words
severity: blocking
config: { words: [tmp] }
---`,
    );

    const result = await runGate(await load(), { includeDisabled: true });

    const byName = Object.fromEntries(result.runs.map((run) => [run.skill, run]));
    expect(byName.broken!.status).toBe("errored");
    expect(byName.works!.status).toBe("failed");
    // One malformed file must not disarm the rest of the gate.
    expect(result.blocking).toHaveLength(1);
  });
});

describe("enabling and disabling", () => {
  it("rewrites an existing enabled line and leaves everything else alone", () => {
    const source = `---
name: keep-me
# This comment explains why the rule exists, and must survive a toggle.
rule: naming
enabled: true
severity: blocking
---
Body prose.`;

    const flipped = setEnabledInSource(source, false);

    expect(flipped).toContain("enabled: false");
    /*
      A targeted line edit, not a parse-and-reserialise.

      The file belongs to the customer and their reviewers read it. A toggle that reformatted the
      frontmatter or dropped the comment explaining the rule would be doing real damage in
      exchange for our convenience, and it would make every toggle a noisy diff.
    */
    expect(flipped).toContain("# This comment explains why");
    expect(flipped).toContain("severity: blocking");
    expect(flipped).toContain("Body prose.");
  });

  it("inserts the line when the frontmatter never mentioned it", () => {
    const flipped = setEnabledInSource("---\nrule: naming\n---\nbody", false);
    expect(flipped).toContain("enabled: false");
    expect(parseSkill(flipped, "x.md").enabled).toBe(false);
  });

  it("ignores an `enabled:` that appears in the prose body", () => {
    // The body is documentation. Editing a sentence because it happens to start with a keyword
    // would corrupt the explanation the rule depends on.
    const source = "---\nrule: naming\n---\nenabled: this word appears in prose";
    const flipped = setEnabledInSource(source, false);

    expect(flipped).toContain("enabled: this word appears in prose");
    expect(parseSkill(flipped, "x.md").enabled).toBe(false);
  });

  it("preserves CRLF line endings", () => {
    // Otherwise every toggle on Windows rewrites the whole file and buries the real change.
    const source = "---\r\nrule: naming\r\nenabled: true\r\n---\r\nbody";
    expect(setEnabledInSource(source, false)).toContain("\r\n");
  });

  it("round-trips through the filesystem", async () => {
    await skill("toggle-me", "---\nrule: forbidden-words\nconfig: { words: [tmp] }\n---\nwhy");

    await setSkillEnabled(root, "toggle-me", false);
    expect((await loadSkills(root))[0]!.enabled).toBe(false);

    await setSkillEnabled(root, "toggle-me", true);
    expect((await loadSkills(root))[0]!.enabled).toBe(true);
  });

  it("refuses to toggle a skill that does not exist", async () => {
    await expect(setSkillEnabled(root, "nope", false)).rejects.toThrow(/no skill named/);
  });
});
