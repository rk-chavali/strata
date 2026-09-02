import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import { impact, lineage } from "./lineage.js";

/**
 * Lineage and impact, against a fixture shaped like a real warehouse.
 *
 * `raw → stg → dim` with a fact joining the dimension, one expression in the middle of the
 * chain, one generated column with no source at all, a self-referencing foreign key, and a
 * mapping that hides behind `customSql`. Every one of those is a case where a traversal can
 * quietly produce a wrong answer that looks right, a missing hop, a cycle, a column
 * attributed to the wrong table, or a confident claim about SQL nobody parsed.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-lineage-"));

  await write(
    "strata.config.yaml",
    `version: 1
name: test-models
roots:
  - "."
layout:
  preset: by-model-and-kind
  slugStyle: snake
`,
  );

  await write(
    "models/logical/model.yaml",
    `id: model_logical
kind: model
name: logical
tier: logical
namespace: sales
`,
  );

  await write(
    "models/logical/entities/customer.yaml",
    `id: entity_customer
kind: entity
name: Customer
model: logical
attributes:
  - id: attr_email
    name: email
    logicalType: string
primaryKey:
  - email
`,
  );

  await write(
    "models/warehouse/model.yaml",
    `id: model_warehouse
kind: model
name: warehouse
tier: physical
namespace: sales
derivedFrom: logical
`,
  );

  await write(
    "models/warehouse/tables/raw_customer.yaml",
    `id: tbl_raw
kind: table
name: raw_customer
model: warehouse
columns:
  - id: col_raw_email
    name: email_address
    dataType: STRING
  - id: col_raw_id
    name: customer_id
    dataType: STRING
`,
  );

  // The middle of the chain: one column is transformed, so its edge is a rewrite not a break.
  await write(
    "models/warehouse/tables/stg_customer.yaml",
    `id: tbl_stg
kind: table
name: stg_customer
model: warehouse
columns:
  - id: col_stg_email
    name: email_address
    dataType: STRING
    attributeRef: logical:Customer.email
  - id: col_stg_id
    name: customer_id
    dataType: STRING
`,
  );

  await write(
    "models/warehouse/tables/dim_customer.yaml",
    `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
columns:
  - id: col_dim_key
    name: customer_key
    dataType: INT64
  - id: col_dim_email
    name: email_address
    dataType: STRING
  - id: col_dim_parent
    name: parent_key
    dataType: INT64
primaryKey:
  - customer_key
foreignKeys:
  # A self-reference: the table's own impact list must not name itself.
  - name: fk_parent
    columns:
      - parent_key
    references:
      table: dim_customer
      columns:
        - customer_key
`,
  );

  await write(
    "models/warehouse/tables/fct_order.yaml",
    `id: tbl_fct
kind: table
name: fct_order
model: warehouse
columns:
  - id: col_fct_ck
    name: customer_key
    dataType: INT64
foreignKeys:
  - name: fk_customer
    columns:
      - customer_key
    references:
      table: dim_customer
      columns:
        - customer_key
`,
  );

  await write(
    "models/warehouse/mappings/load_stg.yaml",
    `id: map_stg
kind: mapping
name: load_stg_customer
model: warehouse
target: stg_customer
sources:
  - alias: r
    ref: raw_customer
columnMappings:
  - target: email_address
    sources:
      - r.email_address
    expression: LOWER(TRIM(r.email_address))
    rule: Addresses are stored lowercased.
  - target: customer_id
    sources:
      - r.customer_id
loadStrategy: full
`,
  );

  await write(
    "models/warehouse/mappings/load_dim.yaml",
    `id: map_dim
kind: mapping
name: load_dim_customer
model: warehouse
target: dim_customer
sources:
  - alias: s
    ref: stg_customer
columnMappings:
  - target: email_address
    sources:
      - s.email_address
  # Generated with no source: a surrogate key. It still has to exist in the graph.
  - target: customer_key
    sources: []
    expression: FARM_FINGERPRINT(s.customer_id)
loadStrategy: scd2
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lineage upstream", () => {
  it("follows a column back through every hop of the chain", async () => {
    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_dim", { column: "email_address" });

    const hops = result!.edges
      .filter((edge) => edge.kind === "mapping")
      .map((edge) => `${edge.from.objectName}.${edge.from.column}->${edge.to.objectName}.${edge.to.column}`);

    // Two mapping hops, not one: a traversal that stopped at the immediate source would
    // answer "it comes from staging" and never reach the actual origin.
    expect(hops).toContain("stg_customer.email_address->dim_customer.email_address");
    expect(hops).toContain("raw_customer.email_address->stg_customer.email_address");
  });

  it("carries the expression and the business rule that produced the value", async () => {
    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_stg", { column: "email_address" });
    const edge = result!.edges.find((candidate) => candidate.kind === "mapping");

    // "Where did this come from" is only half the question; "what was done to it" is the
    // half a table-level lineage graph cannot answer.
    expect(edge?.expression).toBe("LOWER(TRIM(r.email_address))");
    expect(edge?.rule).toBe("Addresses are stored lowercased.");
  });

  it("does not attribute a column to the wrong table when a name is shared", async () => {
    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_dim", { column: "email_address" });

    // `email_address` exists on all three tables. Every edge must name a real pairing.
    for (const edge of result!.edges.filter((candidate) => candidate.kind === "mapping")) {
      expect(edge.from.objectName).not.toBe(edge.to.objectName);
    }
  });

  it("reports a generated column as produced by its mapping rather than omitting it", async () => {
    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_dim", { column: "customer_key" });

    const generated = result!.edges.find((edge) => edge.to.column === "customer_key");
    expect(generated?.from.objectName).toBe("load_dim_customer");
    expect(generated?.expression).toBe("FARM_FINGERPRINT(s.customer_id)");
  });

  it("crosses from physical to logical through attributeRef", async () => {
    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_stg", { column: "email_address" });

    expect(
      result!.edges.some((edge) => edge.kind === "implements" && edge.from.objectName === "Customer"),
    ).toBe(true);
  });

  it("returns undefined for an object that does not exist", async () => {
    const workspace = await loadWorkspace(root);
    expect(lineage(workspace.graph, "nope")).toBeUndefined();
  });
});

describe("impact downstream", () => {
  it("ranks a straight passthrough as breaking and a transformed column as needing a rewrite", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_raw", { column: "email_address" });

    const stg = result!.entries.find((entry) => entry.objectName === "stg_customer");
    const dim = result!.entries.find((entry) => entry.objectName === "dim_customer");

    // The distinction is the whole value of the ranking: one needs a human to rewrite SQL,
    // the other simply stops working.
    expect(stg?.severity).toBe("rewrites");
    expect(dim?.severity).toBe("breaks");
  });

  it("names the consequence rather than just the object", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_raw", { column: "email_address" });
    const stg = result!.entries.find((entry) => entry.objectName === "stg_customer");

    expect(stg?.reason).toContain("LOWER(TRIM(r.email_address))");
    expect(stg?.via?.name).toBe("load_stg_customer");
  });

  it("finds foreign-key dependents of a whole table, not only of a named column", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_dim");

    /*
      The regression this guards: foreign-key and mapping edges are column-keyed, so walking
      from a bare table id alone found nothing at all, dropping `dim_customer` reported zero
      impact while dropping one of its columns correctly reported two.
    */
    expect(result!.entries.some((entry) => entry.objectName === "fct_order")).toBe(true);
    expect(result!.counts.breaks).toBeGreaterThan(0);
  });

  it("never lists the focus as its own dependent, even through a self-referencing key", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_dim");

    expect(result!.entries.every((entry) => entry.objectId !== "tbl_dim")).toBe(true);
  });

  it("keeps the worst verdict when an object is reached more than once", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_dim", { column: "customer_key" });

    // `fct_order` is reached by a foreign key. If a milder edge also reached it, reporting
    // that one would bury the breakage.
    const fct = result!.entries.find((entry) => entry.objectName === "fct_order");
    expect(fct?.severity).toBe("breaks");
  });

  it("sorts breakages above rewrites", async () => {
    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_raw", { column: "email_address" });

    const severities = result!.entries.map((entry) => entry.severity);
    const firstRewrite = severities.indexOf("rewrites");
    const lastBreak = severities.lastIndexOf("breaks");
    if (firstRewrite !== -1 && lastBreak !== -1) expect(lastBreak).toBeLessThan(firstRewrite);
  });

  it("terminates on a cycle instead of recursing forever", async () => {
    // Two mappings feeding each other, which a real warehouse does contain.
    await write(
      "models/warehouse/mappings/cycle_a.yaml",
      `id: map_cycle_a
kind: mapping
name: cycle_a
model: warehouse
target: raw_customer
sources:
  - alias: d
    ref: dim_customer
columnMappings:
  - target: email_address
    sources:
      - d.email_address
loadStrategy: full
`,
    );

    const workspace = await loadWorkspace(root);
    const result = impact(workspace.graph, "tbl_raw", { column: "email_address" });

    expect(result).toBeDefined();
    expect(result!.entries.length).toBeGreaterThan(0);
  });
});

describe("opaque mappings", () => {
  it("admits which mappings it could not see through", async () => {
    await write(
      "models/warehouse/mappings/load_dim.yaml",
      `id: map_dim
kind: mapping
name: load_dim_customer
model: warehouse
target: dim_customer
sources:
  - alias: s
    ref: stg_customer
columnMappings:
  - target: email_address
    sources:
      - s.email_address
customSql: |
  SELECT * FROM somewhere_else
loadStrategy: full
`,
    );

    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_dim", { column: "email_address" });

    /*
      Nothing here parses SQL. A graph that silently drops the columns it could not parse is
      worse than one that says so, because the omission is indistinguishable from an answer.
    */
    expect(result!.opaque.map((entry) => entry.name)).toContain("load_dim_customer");
  });

  it("reports only the opaque mappings actually reached", async () => {
    await write(
      "models/warehouse/mappings/unrelated.yaml",
      `id: map_unrelated
kind: mapping
name: load_something_else
model: warehouse
target: fct_order
sources: []
columnMappings: []
customSql: SELECT 1
loadStrategy: full
`,
    );

    const workspace = await loadWorkspace(root);
    const result = lineage(workspace.graph, "tbl_stg", { column: "email_address" });

    expect(result!.opaque.map((entry) => entry.name)).not.toContain("load_something_else");
  });
});
