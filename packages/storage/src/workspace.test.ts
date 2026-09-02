import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validate } from "@strata/metamodel";
import { CONFIG_FILENAME } from "./config.js";
import { loadWorkspace, planWrites, saveWorkspace, type LoadedWorkspace } from "./workspace.js";
import { normalizeForWrite, parseYamlFile, serializeDocuments } from "./serialize.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** A small but realistic workspace: two tiers, a domain, a table and a diagram. */
async function seedWorkspace(preset = "by-model-and-kind"): Promise<void> {
  await write(
    CONFIG_FILENAME,
    `version: 1\nname: acme\nroots: ["."]\nlayout:\n  preset: ${preset}\n`,
  );
  await write(
    "anywhere/models.yaml",
    [
      "---",
      "id: mdl_core",
      "kind: model",
      "name: core",
      "tier: logical",
      "---",
      "id: mdl_wh",
      "kind: model",
      "name: warehouse",
      "tier: physical",
      "target:",
      "  project: acme",
      "  dataset: analytics",
      "",
    ].join("\n"),
  );
  await write(
    "anywhere/deeply/nested/stuff.yaml",
    [
      "---",
      "id: dom_money",
      "kind: domain",
      "name: money",
      "logicalType: decimal",
      "physicalType: NUMERIC(18, 2)",
      "---",
      "id: sa_sales",
      "kind: subjectArea",
      "name: Sales",
      "model: core",
      "---",
      "id: ent_customer",
      "kind: entity",
      "name: Customer",
      "model: core",
      "subjectArea: Sales",
      "attributes:",
      "  - id: att_id",
      "    name: customer_id",
      "    logicalType: string",
      "    required: true",
      "primaryKey: [customer_id]",
      "---",
      "id: tbl_dim",
      "kind: table",
      "name: dim_customer",
      "model: warehouse",
      "layer: mart",
      "columns:",
      "  - id: col_key",
      "    name: customer_key",
      "    dataType: INT64",
      "    mode: REQUIRED",
      "primaryKey: [customer_key]",
      "---",
      "id: dgm_1",
      "kind: diagram",
      "name: Sales Overview",
      "model: core",
      "nodes:",
      "  - ref: Customer",
      "    x: 40",
      "    y: 80",
      "",
    ].join("\n"),
  );
}

describe("loadWorkspace", () => {
  it("finds objects regardless of where the files sit", async () => {
    // Everything is buried under `anywhere/deeply/nested/`. Discovery must not
    // care, because meaning comes from file contents, not paths.
    await seedWorkspace();
    const ws = await loadWorkspace(root);

    expect(ws.diagnostics).toEqual([]);
    expect(ws.graph.all()).toHaveLength(7);
    expect(ws.graph.modelNamed("core")?.tier).toBe("logical");
    expect(ws.graph.resolve("Customer", { model: "core" })?.target.object.id).toBe("ent_customer");
    expect(validate(ws.graph)).toEqual([]);
  });

  it("walks up from a subdirectory to find the workspace", async () => {
    await seedWorkspace();
    const ws = await loadWorkspace(join(root, "anywhere", "deeply"));
    expect(ws.root).toBe(root);
  });

  it("skips YAML that is not ours without complaining", async () => {
    await seedWorkspace();
    await write(".github/workflows/ci.yaml", "name: CI\non: push\njobs: {}\n");
    await write("docker-compose.yml", "services:\n  db:\n    image: postgres\n");

    const ws = await loadWorkspace(root);
    expect(ws.diagnostics).toEqual([]);
    expect(ws.graph.all()).toHaveLength(7);
  });

  it("reports a file that claims to be a model object but is invalid", async () => {
    await seedWorkspace();
    await write("broken.yaml", "kind: entity\nid: ent_bad\n");

    const ws = await loadWorkspace(root);
    const codes = ws.diagnostics.map((d) => d.code);
    expect(codes).toContain("object/invalid");
    expect(ws.diagnostics[0]?.file).toBe("broken.yaml");
  });

  it("names an unknown kind instead of dumping a union error", async () => {
    await seedWorkspace();
    await write("odd.yaml", "kind: widget\nid: w_1\nname: W\n");

    const ws = await loadWorkspace(root);
    expect(ws.diagnostics.some((d) => d.message.includes("unknown kind `widget`"))).toBe(true);
  });

  it("reports YAML syntax errors with a line number", async () => {
    await seedWorkspace();
    await write("bad.yaml", "kind: entity\n  id: nope\n:::\n");

    const ws = await loadWorkspace(root);
    expect(ws.diagnostics.some((d) => d.code === "yaml/syntax")).toBe(true);
  });

  it("fails clearly when there is no workspace at all", async () => {
    await expect(loadWorkspace(root)).rejects.toThrow(/no strata.config.yaml/);
  });
});

describe("planWrites and saveWorkspace", () => {
  it("moves every file to the configured layout", async () => {
    await seedWorkspace();
    const ws = await loadWorkspace(root);
    const plan = planWrites(ws);

    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("models/core/entities/customer.yaml");
    expect(paths).toContain("models/warehouse/tables/dim_customer.yaml");
    expect(paths).toContain("shared/domains/money.yaml");
    expect(paths).toContain("diagrams/core/sales_overview.diagram.yaml");

    // The scratch files the objects were authored in are no longer needed.
    expect(plan.deletions).toContain("anywhere/deeply/nested/stuff.yaml");
    expect(plan.moves.length).toBe(7);
  });

  it("does not rewrite files whose content is unchanged", async () => {
    await seedWorkspace();
    await saveWorkspace(await loadWorkspace(root));

    const second = await saveWorkspace(await loadWorkspace(root));
    expect(second.written).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  it("changes nothing semantically when the layout changes", async () => {
    // This is the property the whole storage design exists to guarantee: a team
    // can reorganise the repo at any time and lose nothing.
    await seedWorkspace("by-model-and-kind");
    await saveWorkspace(await loadWorkspace(root));
    const before = summarize(await loadWorkspace(root));

    for (const preset of ["flat", "by-layer", "single-file-per-model", "by-subject-area", "by-kind"]) {
      await write(CONFIG_FILENAME, `version: 1\nname: acme\nroots: ["."]\nlayout:\n  preset: ${preset}\n`);
      await saveWorkspace(await loadWorkspace(root));

      const reloaded = await loadWorkspace(root);
      expect(reloaded.diagnostics, `preset ${preset} produced load diagnostics`).toEqual([]);
      expect(validate(reloaded.graph), `preset ${preset} produced validation errors`).toEqual([]);
      expect(summarize(reloaded), `preset ${preset} lost or changed an object`).toEqual(before);
    }
  });

  it("collapses a whole model into one multi-document file", async () => {
    await seedWorkspace("single-file-per-model");
    await saveWorkspace(await loadWorkspace(root));

    const content = await readFile(join(root, "models/core.yaml"), "utf8");
    const parsed = parseYamlFile(content);
    expect(parsed.errors).toEqual([]);
    // model, subject area, entity, the diagram lives elsewhere by design.
    expect(parsed.documents.map((d) => (d.value as { kind: string }).kind)).toEqual([
      "model",
      "subjectArea",
      "entity",
    ]);
  });

  it("prunes directories left empty by a move", async () => {
    await seedWorkspace();
    await saveWorkspace(await loadWorkspace(root));
    await expect(readFile(join(root, "anywhere/deeply/nested/stuff.yaml"), "utf8")).rejects.toThrow();
    // The empty scaffolding should be gone too, not left behind as clutter.
    const ws = await loadWorkspace(root);
    expect([...ws.filesByPath.keys()].some((p) => p.startsWith("anywhere/"))).toBe(false);
  });

  it("writes nothing at all in dry-run mode", async () => {
    await seedWorkspace();
    const ws = await loadWorkspace(root);
    const result = await saveWorkspace(ws, { dryRun: true });

    expect(result.written.length).toBeGreaterThan(0);
    // Reloading must still find the original files untouched.
    const reloaded = await loadWorkspace(root);
    expect([...reloaded.filesByPath.keys()]).toContain("anywhere/deeply/nested/stuff.yaml");
  });
});

describe("serialization", () => {
  it("omits defaulted-empty collections but keeps explicit falsy values", async () => {
    await seedWorkspace();
    await saveWorkspace(await loadWorkspace(root));

    const content = await readFile(join(root, "models/core/entities/customer.yaml"), "utf8");
    expect(content).not.toContain("tags:");
    expect(content).not.toContain("properties:");
    expect(content).not.toContain("previousNames:");
    // `required: true` is meaningful and must survive.
    expect(content).toContain("required: true");
  });

  it("keeps an explicit false rather than treating it as a default", () => {
    const normalized = normalizeForWrite({ a: false, b: 0, c: [], d: {}, e: undefined }) as Record<string, unknown>;
    expect(normalized).toEqual({ a: false, b: 0 });
  });

  it("puts identity fields first so files are scannable", async () => {
    await seedWorkspace();
    await saveWorkspace(await loadWorkspace(root));

    const content = await readFile(join(root, "models/core/entities/customer.yaml"), "utf8");
    const keys = content.split("\n").filter((l) => /^\w/.test(l)).map((l) => l.split(":")[0]);
    expect(keys.slice(0, 4)).toEqual(["id", "kind", "name", "model"]);
  });

  it("is byte-stable across repeated serialization", () => {
    const objects = [
      { kind: "domain", id: "dom_1", name: "money", logicalType: "decimal", tags: ["a", "b"] },
      { kind: "domain", id: "dom_2", name: "email", logicalType: "string" },
    ];
    expect(serializeDocuments(objects)).toBe(serializeDocuments(objects));
  });

  it("writes long text as a literal block rather than a wrapped line", () => {
    const long = "a".repeat(200);
    const output = serializeDocuments([{ kind: "domain", id: "d", name: "x", description: `${long}\n${long}` }]);
    expect(output).toContain("description: |-");
    // Each source line survives intact. Wrapping would turn a one-word edit into
    // a multi-line diff, which is the thing we are guarding against.
    const lines = output.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l === long)).toHaveLength(2);
  });
});

/** A layout-independent fingerprint of a workspace's semantic content. */
function summarize(ws: LoadedWorkspace): string[] {
  return ws.graph
    .all()
    .map((entry) => JSON.stringify(normalizeForWrite(entry.object)))
    .sort();
}
