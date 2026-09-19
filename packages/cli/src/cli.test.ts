import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";
import { EXIT } from "./commands.js";

/**
 * End-to-end CLI tests.
 *
 * These drive `run()` exactly as the terminal does, against real files in a
 * temporary directory, and assert on exit codes. Exit codes are the contract CI
 * depends on, so they are worth testing directly rather than inferring from
 * output text.
 */

let root: string;
let output: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-cli-"));
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function printed(): string {
  return output.join("");
}

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

const VALID_MODEL = [
  "---",
  "id: mdl_core",
  "kind: model",
  "name: core",
  "tier: logical",
  "---",
  "id: ent_customer",
  "kind: entity",
  "name: Customer",
  "model: core",
  "attributes:",
  "  - id: att_id",
  "    name: customer_id",
  "    logicalType: string",
  "    required: true",
  "primaryKey: [customer_id]",
  "",
].join("\n");

async function seedValid(preset = "by-model-and-kind"): Promise<void> {
  await write("strata.config.yaml", `version: 1\nname: test\nroots: ["."]\nlayout:\n  preset: ${preset}\n`);
  await write("scratch/everything.yaml", VALID_MODEL);
}

describe("help and version", () => {
  it("prints help with no arguments and succeeds", async () => {
    expect(await run([])).toBe(EXIT.ok);
    expect(printed()).toContain("strata, data modelling CLI");
  });

  it("prints a version", async () => {
    expect(await run(["--version"])).toBe(EXIT.ok);
    expect(printed().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("reports an unknown command as a usage error", async () => {
    expect(await run(["frobnicate"])).toBe(EXIT.failure);
    expect(printed()).toContain("unknown command");
  });

  it("rejects an unknown output format", async () => {
    await seedValid();
    expect(await run(["check", "--cwd", root, "--format", "xml"])).toBe(EXIT.failure);
    expect(printed()).toContain("unknown format");
  });

  it("rejects an unknown layout preset", async () => {
    await seedValid();
    expect(await run(["reorganize", "--cwd", root, "--preset", "by-vibes"])).toBe(EXIT.failure);
    expect(printed()).toContain("unknown layout preset");
  });
});

describe("init", () => {
  it("creates a config that check can immediately read", async () => {
    expect(await run(["init", root, "--name", "acme", "--preset", "by-layer"])).toBe(EXIT.ok);

    const config = await readFile(join(root, "strata.config.yaml"), "utf8");
    expect(config).toContain("name: acme");
    expect(config).toContain("preset: by-layer");

    expect(await run(["check", "--cwd", root])).toBe(EXIT.ok);
  });

  it("explains itself when there is no workspace", async () => {
    expect(await run(["check", "--cwd", root])).toBe(EXIT.failure);
    expect(printed()).toContain("strata init");
  });
});

describe("check", () => {
  it("passes a valid workspace", async () => {
    await seedValid();
    expect(await run(["check", "--cwd", root])).toBe(EXIT.ok);
    expect(printed()).toContain("No problems found");
  });

  it("fails on a structural error", async () => {
    await seedValid();
    // Primary key naming an attribute that does not exist.
    await write(
      "scratch/broken.yaml",
      ["id: ent_order", "kind: entity", "name: Order", "model: core", "primaryKey: [nope]", ""].join("\n"),
    );

    expect(await run(["check", "--cwd", root])).toBe(EXIT.findings);
    expect(printed()).toContain("key/unknownAttribute");
  });

  it("emits GitHub annotations when asked", async () => {
    await seedValid();
    await write(
      "scratch/broken.yaml",
      ["id: ent_order", "kind: entity", "name: Order", "model: core", "primaryKey: [nope]", ""].join("\n"),
    );

    expect(await run(["check", "--cwd", root, "--format", "github"])).toBe(EXIT.findings);
    expect(printed()).toMatch(/::error file=scratch\/broken\.yaml,title=key\/unknownAttribute::/);
  });

  it("emits machine-readable JSON with a summary", async () => {
    await seedValid();
    expect(await run(["check", "--cwd", root, "--format", "json"])).toBe(EXIT.ok);

    const parsed = JSON.parse(printed()) as { diagnostics: unknown[]; summary: { total: number } };
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.summary.total).toBe(0);
  });

  it("passes with a warning by default but fails under --strict", async () => {
    await seedValid();
    // An entity with no primary key is a warning, not an error.
    await write(
      "scratch/warn.yaml",
      ["id: ent_order", "kind: entity", "name: Order", "model: core", ""].join("\n"),
    );

    expect(await run(["check", "--cwd", root])).toBe(EXIT.ok);
    output = [];
    expect(await run(["check", "--cwd", root, "--strict"])).toBe(EXIT.findings);
  });

  it("honours a rule turned off in config", async () => {
    await write(
      "strata.config.yaml",
      [
        "version: 1",
        "name: test",
        'roots: ["."]',
        "lint:",
        "  rules:",
        "    entity/noPrimaryKey: off",
        "",
      ].join("\n"),
    );
    await write("scratch/everything.yaml", VALID_MODEL);
    await write("scratch/warn.yaml", ["id: ent_order", "kind: entity", "name: Order", "model: core", ""].join("\n"));

    expect(await run(["check", "--cwd", root, "--strict"])).toBe(EXIT.ok);
  });

  it("lints names only when a model points at a standard", async () => {
    await write("strata.config.yaml", `version: 1\nname: test\nroots: ["."]\n`);
    await write(
      "scratch/model.yaml",
      [
        "---",
        "id: nst_1",
        "kind: namingStandard",
        "name: corporate",
        "rules:",
        "  - appliesTo: [entity]",
        "    casing: PascalCase",
        "    severity: error",
        "---",
        "id: mdl_core",
        "kind: model",
        "name: core",
        "tier: logical",
        "namingStandard: corporate",
        "---",
        "id: ent_1",
        "kind: entity",
        "name: customer_account",
        "model: core",
        "attributes:",
        "  - id: a1",
        "    name: id",
        "    logicalType: string",
        "    required: true",
        "primaryKey: [id]",
        "",
      ].join("\n"),
    );

    expect(await run(["lint", "--cwd", root])).toBe(EXIT.findings);
    expect(printed()).toContain("naming/case");

    // `validate` covers structure only, so the naming finding must not appear.
    output = [];
    expect(await run(["validate", "--cwd", root])).toBe(EXIT.ok);
  });
});

describe("fmt", () => {
  it("detects non-canonical files without changing them", async () => {
    await seedValid();
    expect(await run(["fmt", "--cwd", root, "--check"])).toBe(EXIT.findings);
    expect(printed()).toContain("not in canonical form");

    // Nothing was written, so the same check fails again identically.
    output = [];
    expect(await run(["fmt", "--cwd", root, "--check"])).toBe(EXIT.findings);
  });

  it("rewrites files and is then idempotent", async () => {
    await seedValid();
    expect(await run(["fmt", "--cwd", root])).toBe(EXIT.ok);

    const written = await readFile(join(root, "models/core/entities/customer.yaml"), "utf8");
    expect(written).toContain("kind: entity");

    output = [];
    expect(await run(["fmt", "--cwd", root, "--check"])).toBe(EXIT.ok);
    expect(printed()).toContain("canonical form");
  });

  it("refuses to rewrite when a file failed to load", async () => {
    // Writing the graph back out with part of it missing would delete the
    // unparseable file's objects, so this must stop rather than proceed.
    await seedValid();
    await write("scratch/broken.yaml", "kind: entity\nid: only_an_id\n");

    expect(await run(["fmt", "--cwd", root])).toBe(EXIT.failure);
    expect(printed()).toContain("refusing to rewrite");
    // The original file is untouched.
    expect(await readFile(join(root, "scratch/everything.yaml"), "utf8")).toContain("kind: entity");
  });
});

describe("reorganize", () => {
  it("shows the moves without writing under --dry-run", async () => {
    await seedValid();
    expect(await run(["reorganize", "--cwd", root, "--preset", "flat", "--dry-run"])).toBe(EXIT.ok);
    expect(printed()).toContain("dry run");

    // Neither the files nor the config changed.
    expect(await readFile(join(root, "scratch/everything.yaml"), "utf8")).toContain("kind: entity");
    expect(await readFile(join(root, "strata.config.yaml"), "utf8")).toContain("by-model-and-kind");
  });

  it("moves files and persists the new preset", async () => {
    await seedValid();
    expect(await run(["reorganize", "--cwd", root, "--preset", "single-file-per-model"])).toBe(EXIT.ok);

    const collapsed = await readFile(join(root, "models/core.yaml"), "utf8");
    expect(collapsed).toContain("kind: model");
    expect(collapsed).toContain("kind: entity");

    // The preset is saved, so a later `fmt` does not undo the move.
    expect(await readFile(join(root, "strata.config.yaml"), "utf8")).toContain("single-file-per-model");
    output = [];
    expect(await run(["fmt", "--cwd", root, "--check"])).toBe(EXIT.ok);
  });

  it("preserves comments in the config when saving a preset", async () => {
    await write(
      "strata.config.yaml",
      ["version: 1", "name: test", "# we chose this deliberately", "layout:", "  preset: flat", ""].join("\n"),
    );
    await write("scratch/everything.yaml", VALID_MODEL);

    expect(await run(["reorganize", "--cwd", root, "--preset", "by-kind"])).toBe(EXIT.ok);

    const config = await readFile(join(root, "strata.config.yaml"), "utf8");
    expect(config).toContain("# we chose this deliberately");
    expect(config).toContain("preset: by-kind");
  });

  it("reports when there is nothing to move", async () => {
    await seedValid();
    await run(["fmt", "--cwd", root]);
    output = [];

    expect(await run(["reorganize", "--cwd", root])).toBe(EXIT.ok);
    expect(printed()).toContain("already organised");
  });
});

describe("info", () => {
  it("summarises models by tier", async () => {
    await seedValid();
    expect(await run(["info", "--cwd", root])).toBe(EXIT.ok);

    const text = printed();
    expect(text).toContain("MODELS");
    expect(text).toContain("core");
    expect(text).toContain("logical");
  });

  it("counts a shared domain separately from model members", async () => {
    await seedValid();
    await write(
      "scratch/shared.yaml",
      ["id: dom_1", "kind: domain", "name: money", "logicalType: decimal", ""].join("\n"),
    );

    expect(await run(["info", "--cwd", root, "--format", "json"])).toBe(EXIT.ok);
    const parsed = JSON.parse(printed()) as {
      shared: Record<string, number>;
      models: { name: string; counts: Record<string, number> }[];
    };
    expect(parsed.shared.domain).toBe(1);
    expect(parsed.models.find((m) => m.name === "core")?.counts.domain).toBeUndefined();
  });

  it("counts a model-scoped glossary term under its model, not as shared", async () => {
    await seedValid();
    await write(
      "scratch/glossary.yaml",
      ["id: term_1", "kind: glossaryTerm", "name: Buyer", "model: core", "definition: Someone buying.", ""].join("\n"),
    );

    expect(await run(["info", "--cwd", root, "--format", "json"])).toBe(EXIT.ok);
    const parsed = JSON.parse(printed()) as {
      shared: Record<string, number>;
      models: { name: string; counts: Record<string, number> }[];
    };
    expect(parsed.shared.glossaryTerm).toBeUndefined();
    expect(parsed.models.find((m) => m.name === "core")?.counts.glossaryTerm).toBe(1);
  });
});
