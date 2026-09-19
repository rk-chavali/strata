import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject } from "@strata/metamodel";
import { generateModelDdl, generatePolicyTagDdl, generateTableDdl } from "./bigquery.js";
import { checkGovernance, coverage, generateCodeowners, looksSensitive } from "./governance.js";

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function graphOf(...inputs: Record<string, unknown>[]): ObjectGraph {
  return ObjectGraph.from(inputs.map((i) => ({ object: obj(i), file: `models/${i.name}.yaml` })));
}

const model = {
  id: "mdl_wh",
  kind: "model",
  name: "warehouse",
  tier: "physical",
  target: { project: "acme", dataset: "mart" },
};

const fact = {
  id: "tbl_fact",
  kind: "table",
  name: "fct_order_line",
  model: "warehouse",
  description: "Transaction-grain order fact.",
  columns: [
    { id: "c1", name: "order_line_key", dataType: "INT64", mode: "REQUIRED" },
    { id: "c2", name: "order_date", dataType: "DATE", mode: "REQUIRED" },
    { id: "c3", name: "customer_key", dataType: "INT64" },
    { id: "c4", name: "line_amount", dataType: "NUMERIC(18, 2)", description: "Derived, never sourced." },
  ],
  primaryKey: ["order_line_key"],
  partitioning: { type: "time", field: "order_date", requireFilter: true },
  clustering: ["customer_key"],
  options: { labels: { layer: "mart" } },
};

describe("generateTableDdl", () => {
  it("emits a CREATE TABLE with a fully qualified name", () => {
    const graph = graphOf(model, fact);
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS `acme.mart.fct_order_line` (");
  });

  it("maps REQUIRED to NOT NULL and keeps column descriptions", () => {
    const graph = graphOf(model, fact);
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("order_line_key INT64 NOT NULL");
    expect(ddl).toContain('line_amount NUMERIC(18, 2) OPTIONS(description = "Derived, never sourced.")');
  });

  it("emits partitioning, clustering and require_partition_filter", () => {
    const graph = graphOf(model, fact);
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("PARTITION BY order_date");
    expect(ddl).toContain("CLUSTER BY customer_key");
    expect(ddl).toContain("require_partition_filter = TRUE");
  });

  it("marks keys NOT ENFORCED, because BigQuery does not enforce them", () => {
    const graph = graphOf(model, fact);
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("PRIMARY KEY (order_line_key) NOT ENFORCED");
  });

  it("renders a foreign key against the parent's qualified name", () => {
    const graph = graphOf(
      model,
      { ...fact, foreignKeys: [{ name: "fk_cust", columns: ["customer_key"], references: { table: "dim_customer", columns: ["customer_key"] } }] },
      {
        id: "tbl_dim",
        kind: "table",
        name: "dim_customer",
        model: "warehouse",
        columns: [{ id: "d1", name: "customer_key", dataType: "INT64", mode: "REQUIRED" }],
        primaryKey: ["customer_key"],
      },
    );
    const table = graph.ofKind("table").find((t) => t.object.name === "fct_order_line")!.object;
    const ddl = generateTableDdl(table, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain(
      "CONSTRAINT fk_cust FOREIGN KEY (customer_key) REFERENCES `acme.mart.dim_customer` (customer_key) NOT ENFORCED",
    );
  });

  it("backtick-quotes hyphenated project ids, which BigQuery would otherwise read as subtraction", () => {
    const graph = graphOf(
      { ...model, target: { project: "acme-analytics-prod", dataset: "mart" } },
      { ...fact, foreignKeys: [{ name: "fk_cust", columns: ["customer_key"], references: { table: "dim_customer", columns: ["customer_key"] } }] },
      {
        id: "tbl_dim",
        kind: "table",
        name: "dim_customer",
        model: "warehouse",
        columns: [{ id: "d1", name: "customer_key", dataType: "INT64", mode: "REQUIRED" }],
        primaryKey: ["customer_key"],
      },
    );
    const table = graph.ofKind("table").find((t) => t.object.name === "fct_order_line")!.object;
    const ddl = generateTableDdl(table, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS `acme-analytics-prod.mart.fct_order_line`");
    expect(ddl).toContain("REFERENCES `acme-analytics-prod.mart.dim_customer`");
  });

  it("renders nested STRUCT and REPEATED columns", () => {
    const graph = graphOf(model, {
      id: "tbl_n",
      kind: "table",
      name: "nested",
      model: "warehouse",
      columns: [
        {
          id: "n1",
          name: "addresses",
          dataType: "STRUCT",
          mode: "REPEATED",
          fields: [
            { id: "n2", name: "line1", dataType: "STRING" },
            { id: "n3", name: "postcode", dataType: "STRING" },
          ],
        },
      ],
    });
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("addresses ARRAY<STRUCT<");
    expect(ddl).toContain("line1 STRING");
  });

  it("never puts NOT NULL on a REPEATED column, which BigQuery rejects", () => {
    const graph = graphOf(model, {
      id: "tbl_r",
      kind: "table",
      name: "repeated",
      model: "warehouse",
      columns: [{ id: "r1", name: "tags", dataType: "STRING", mode: "REPEATED" }],
    });
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("tags ARRAY<STRING>");
    expect(ddl).not.toContain("NOT NULL");
  });

  it("uses CREATE OR REPLACE when asked", () => {
    const graph = graphOf(model, fact);
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"), {
      orReplace: true,
    });
    expect(ddl).toContain("CREATE OR REPLACE TABLE");
  });

  it("emits a view with its query", () => {
    const graph = graphOf(model, {
      id: "tbl_v",
      kind: "table",
      name: "v_orders",
      model: "warehouse",
      objectType: "view",
      viewQuery: "SELECT 1 AS x",
      columns: [{ id: "v1", name: "x", dataType: "INT64" }],
    });
    const ddl = generateTableDdl(graph.ofKind("table")[0]!.object, graph, graph.modelNamed("warehouse"));
    expect(ddl).toContain("CREATE VIEW IF NOT EXISTS");
    expect(ddl).toContain("SELECT 1 AS x");
  });
});

describe("generatePolicyTagDdl", () => {
  const classified = {
    id: "tbl_c",
    kind: "table",
    name: "dim_customer",
    model: "warehouse",
    columns: [
      { id: "p1", name: "customer_key", dataType: "INT64" },
      {
        id: "p2",
        name: "email_address",
        dataType: "STRING",
        classification: { categories: ["pii", "contact"], policyTag: "projects/p/locations/eu/taxonomies/1/policyTags/2" },
      },
    ],
  };

  it("emits an ALTER for a column with a resolved policy tag", () => {
    const graph = graphOf(model, classified);
    const ddl = generatePolicyTagDdl(graph.ofKind("table")[0]!.object, graph.modelNamed("warehouse"));
    expect(ddl).toContain("ALTER COLUMN email_address SET OPTIONS (policy_tags =");
    expect(ddl).toContain("pii, contact");
  });

  it("leaves a TODO when only a taxonomy name is known", () => {
    const graph = graphOf(model, {
      ...classified,
      columns: [
        { id: "p3", name: "email_address", dataType: "STRING", classification: { categories: ["pii"], policyTagName: "pii/contact" } },
      ],
    });
    const ddl = generatePolicyTagDdl(graph.ofKind("table")[0]!.object, graph.modelNamed("warehouse"));
    expect(ddl).toContain("TODO: resolve taxonomy");
  });

  it("returns nothing when no column is classified", () => {
    const graph = graphOf(model, fact);
    expect(generatePolicyTagDdl(graph.ofKind("table")[0]!.object, graph.modelNamed("warehouse"))).toBeUndefined();
  });
});

describe("generateModelDdl", () => {
  it("writes one file per table, into the configured folder", () => {
    const graph = graphOf(model, fact);
    const files = generateModelDdl(graph, "warehouse", { pathTemplate: "{name}.sql" });
    expect(files.find((f) => f.path === "fct_order_line.sql")).toBeDefined();
  });

  it("returns paths relative to the output folder, so the caller can prefix it", () => {
    // The caller supplies the folder; a template that repeated it would produce
    // DDL/DDL/… once joined.
    const graph = graphOf(model, fact);
    const files = generateModelDdl(graph, "warehouse");
    expect(files.every((file) => !file.path.startsWith("DDL/"))).toBe(true);
    expect(files.find((f) => f.path === "mart/fct_order_line.sql")).toBeDefined();
  });

  it("skips declarations, which describe tables someone else owns", () => {
    const graph = graphOf(model, fact, {
      id: "tbl_decl",
      kind: "table",
      name: "raw_source",
      model: "warehouse",
      dataform: { type: "declaration" },
      columns: [{ id: "s1", name: "id", dataType: "STRING" }],
    });
    const files = generateModelDdl(graph, "warehouse");
    expect(files.some((f) => f.contents.includes("raw_source"))).toBe(false);
  });

  it("includes an index explaining the folder is generated", () => {
    const graph = graphOf(model, fact);
    const index = generateModelDdl(graph, "warehouse").find((f) => f.kind === "index");
    expect(index?.contents).toContain("Do not edit these files by hand");
    expect(index?.contents).toContain("fct_order_line");
  });

  it("refuses to generate from a non-physical model", () => {
    const graph = graphOf({ id: "mdl_l", kind: "model", name: "core", tier: "logical" });
    expect(() => generateModelDdl(graph, "core")).toThrow(/only generated from physical models/);
  });
});

describe("governance", () => {
  it("recognises names that look like personal data", () => {
    expect(looksSensitive("email_address")).toBe(true);
    expect(looksSensitive("customer_dob")).toBe(true);
    expect(looksSensitive("order_line_key")).toBe(false);
  });

  it("reports unowned and undescribed objects only when asked", () => {
    const graph = graphOf(model, fact);
    expect(checkGovernance(graph, {})).toEqual([]);

    const codes = checkGovernance(graph, { requireOwner: ["table"] }).map((d) => d.code);
    expect(codes).toContain("governance/noOwner");
  });

  it("flags an unclassified column that looks sensitive", () => {
    const graph = graphOf(model, {
      ...fact,
      columns: [...fact.columns, { id: "c9", name: "email_address", dataType: "STRING" }],
    });
    const codes = checkGovernance(graph, { requireClassificationFor: [] }).map((d) => d.code);
    expect(codes).toContain("governance/unclassified");
  });

  it("does not flag a sensitive column that is classified", () => {
    const graph = graphOf(model, {
      ...fact,
      columns: [
        ...fact.columns,
        { id: "c9", name: "email_address", dataType: "STRING", classification: { categories: ["pii"] } },
      ],
    });
    expect(checkGovernance(graph, { requireClassificationFor: [] })).toEqual([]);
  });

  it("reports coverage percentages", () => {
    const graph = graphOf(model, {
      ...fact,
      ownership: { owner: "data@acme.example" },
      columns: [...fact.columns, { id: "c9", name: "email_address", dataType: "STRING" }],
    });
    const report = coverage(graph);
    expect(report.percentages.owned).toBe(100);
    expect(report.sensitiveColumns).toBe(1);
    expect(report.percentages.sensitiveClassified).toBe(0);
  });

  it("generates CODEOWNERS from ownership metadata", () => {
    const graph = graphOf(model, { ...fact, ownership: { owner: "@acme/finance" } });
    const codeowners = generateCodeowners(graph, () => "models/warehouse/tables/fct_order_line.yaml");
    expect(codeowners).toContain("/models/warehouse/tables/ @acme/finance");
  });

  it("says so plainly when nothing declares an owner", () => {
    const graph = graphOf(model, fact);
    expect(generateCodeowners(graph, () => "models/x.yaml")).toContain("No objects declare an owner");
  });
});
