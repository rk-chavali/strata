import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject } from "@strata/metamodel";
import { generateAssertions, generateDataform, generateDeclarations } from "./dataform.js";

/**
 * Dataform generation.
 *
 * These tests carry more weight than most in this repo, because the output is SQL that
 * runs unattended against a warehouse. A wrong `CREATE TABLE` fails loudly at deploy; a
 * wrong SCD2 merge succeeds every night and quietly corrupts history, you find out when
 * a report disagrees with itself months later.
 *
 * So the assertions here are about *semantics*, not formatting: which statement runs
 * first, what the change hash covers, whether a dimension lookup respects the fact's event
 * time. Where a test pins an exact string it is because that string is load-bearing.
 */

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
  target: { project: "acme-prod", dataset: "mart" },
};

const rawCustomer = {
  id: "tbl_raw",
  kind: "table",
  name: "raw_customer",
  model: "warehouse",
  dataset: "raw",
  columns: [
    { id: "r1", name: "id", dataType: "STRING" },
    { id: "r2", name: "full_name", dataType: "STRING" },
  ],
};

const dimCustomer = {
  id: "tbl_dim_customer",
  kind: "table",
  name: "dim_customer",
  model: "warehouse",
  layer: "mart",
  columns: [
    { id: "d1", name: "customer_key", dataType: "INT64", mode: "REQUIRED" },
    { id: "d2", name: "customer_id", dataType: "STRING", mode: "REQUIRED" },
    { id: "d3", name: "customer_name", dataType: "STRING" },
    { id: "d4", name: "valid_from", dataType: "TIMESTAMP" },
    { id: "d5", name: "valid_to", dataType: "TIMESTAMP" },
    { id: "d6", name: "is_current", dataType: "BOOL" },
    { id: "d7", name: "change_hash", dataType: "INT64" },
  ],
  primaryKey: ["customer_key"],
};

const factOrderLine = {
  id: "tbl_fact",
  kind: "table",
  name: "fct_order_line",
  model: "warehouse",
  layer: "mart",
  columns: [
    { id: "f1", name: "order_line_key", dataType: "INT64", mode: "REQUIRED" },
    { id: "f2", name: "order_id", dataType: "STRING", mode: "REQUIRED" },
    { id: "f3", name: "order_date", dataType: "DATE", mode: "REQUIRED" },
    { id: "f4", name: "customer_key", dataType: "INT64" },
  ],
  primaryKey: ["order_line_key"],
  partitioning: { type: "time", field: "order_date" },
  clustering: ["customer_key"],
  foreignKeys: [
    {
      name: "fk_fol_customer",
      columns: ["customer_key"],
      references: { table: "dim_customer", columns: ["customer_key"] },
      assert: true,
    },
  ],
};

/** An SCD2 dimension, the case most of this module exists for. */
const scd2Mapping = {
  id: "map_dim_customer",
  kind: "mapping",
  name: "load_dim_customer",
  model: "warehouse",
  target: "dim_customer",
  sources: [{ alias: "s", ref: "raw_customer" }],
  loadStrategy: "scd2",
  columnMappings: [
    { target: "customer_id", sources: ["s.id"] },
    { target: "customer_name", sources: ["s.full_name"], trackChanges: true },
  ],
  dimensional: {
    role: "dimension",
    businessKey: ["customer_id"],
    surrogateKey: "customer_key",
    surrogateKeyStrategy: "hash",
    validFromColumn: "valid_from",
    validToColumn: "valid_to",
    currentFlagColumn: "is_current",
    hashColumn: "change_hash",
  },
};

const factMapping = {
  id: "map_fact",
  kind: "mapping",
  name: "load_fct_order_line",
  model: "warehouse",
  target: "fct_order_line",
  sources: [{ alias: "s", ref: "raw_customer" }],
  loadStrategy: "incremental",
  columnMappings: [
    { target: "order_id", sources: ["s.id"] },
    { target: "order_date", sources: ["s.id"] },
  ],
  dimensional: {
    role: "fact",
    businessKey: ["order_id"],
    surrogateKey: "order_line_key",
    surrogateKeyStrategy: "hash",
    watermarkColumn: "order_date",
    lookbackDays: 3,
    dimensionLookups: [
      {
        column: "customer_key",
        dimension: "dim_customer",
        sourceColumn: "customer_id",
        unknownMemberKey: -1,
        pointInTime: true,
      },
    ],
  },
};

function fileFor(files: { path: string }[], fragment: string): { path: string; contents: string } {
  const match = files.find((f) => f.path.includes(fragment)) as
    | { path: string; contents: string }
    | undefined;
  if (!match) throw new Error(`no generated file matching \`${fragment}\``);
  return match;
}

// ---------------------------------------------------------------- strategies

describe("load strategies map onto Dataform action types", () => {
  const base = {
    id: "map_x",
    kind: "mapping",
    name: "load_x",
    model: "warehouse",
    target: "dim_customer",
    sources: [{ alias: "s", ref: "raw_customer" }],
    columnMappings: [{ target: "customer_id", sources: ["s.id"] }],
  };

  const cases: { strategy: string; type: string }[] = [
    { strategy: "full", type: "table" },
    { strategy: "append", type: "incremental" },
    { strategy: "merge", type: "incremental" },
    { strategy: "incremental", type: "incremental" },
    { strategy: "scd1", type: "incremental" },
    { strategy: "snapshot", type: "incremental" },
    { strategy: "declaration", type: "declaration" },
    // SCD2 is operations because the load is two statements; see its own block below.
    { strategy: "scd2", type: "operations" },
  ];

  for (const { strategy, type } of cases) {
    it(`emits type "${type}" for ${strategy}`, () => {
      const graph = graphOf(model, rawCustomer, dimCustomer, {
        ...base,
        loadStrategy: strategy,
        ...(strategy === "scd2" || strategy === "scd1"
          ? { dimensional: { businessKey: ["customer_id"], surrogateKey: "customer_key" } }
          : {}),
      });
      const files = generateDataform(graph, "warehouse");
      expect(fileFor(files, "dim_customer").contents).toContain(`type: "${type}"`);
    });
  }

  it("gives append no uniqueKey, because append must never upsert", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...base,
      loadStrategy: "append",
      dimensional: { businessKey: ["customer_id"] },
    });
    const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;
    expect(contents).toContain('type: "incremental"');
    // Only the *config-level* key matters. An inline `assertions: { uniqueKey: ... }` is a
    // check, not an upsert instruction, so matching the bare word would be wrong here.
    expect(contents).not.toMatch(/^ {2}uniqueKey:/m);
  });

  it("keys a snapshot on the date plus the business key, so a re-run replaces the day", () => {
    // Without the date in the key a retry doubles that day's rows; without the business
    // key it collapses the whole copy to one row. Both halves are load-bearing.
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...base,
      loadStrategy: "snapshot",
      dimensional: { businessKey: ["customer_id"] },
    });
    const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;

    expect(contents).toContain('type: "incremental"');
    expect(contents).toContain('uniqueKey: ["snapshot_date", "customer_id"]');
    expect(contents).toContain("CURRENT_DATE() AS snapshot_date");
    expect(contents).toContain('partitionBy: "snapshot_date"');
  });

  it("honours a custom snapshot date column", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...base,
      loadStrategy: "snapshot",
      dimensional: { businessKey: ["customer_id"], snapshotDateColumn: "as_of_date" },
    });
    const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;

    expect(contents).toContain("CURRENT_DATE() AS as_of_date");
    expect(contents).toContain('uniqueKey: ["as_of_date", "customer_id"]');
  });

  it("keys scd1 on the business key, so the upsert is idempotent", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...base,
      loadStrategy: "scd1",
      dimensional: { businessKey: ["customer_id"], surrogateKey: "customer_key" },
    });
    expect(fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents).toContain(
      'uniqueKey: ["customer_id"]',
    );
  });
});

// ---------------------------------------------------------------- SCD2

describe("SCD2", () => {
  const graph = graphOf(model, rawCustomer, dimCustomer, scd2Mapping);
  const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;
  const [expire, insert] = contents.split("\n---\n");

  it("emits two statements, close before insert", () => {
    // The order is the whole correctness argument: the insert finds rows to open by
    // looking for business keys with no current row, which is only true after the merge
    // has closed them. Swap these and changed rows never get a new version.
    expect(contents).toContain("\n---\n");
    expect(expire).toContain("MERGE");
    expect(insert).toContain("INSERT INTO");
  });

  it("closes only rows whose tracked columns changed", () => {
    expect(expire).toContain("WHEN MATCHED AND target.change_hash != source.change_hash");
    expect(expire).toContain("valid_to = CURRENT_TIMESTAMP()");
    expect(expire).toContain("is_current = FALSE");
  });

  it("matches on the business key and only against the current row", () => {
    expect(expire).toContain("target.customer_id = source.customer_id");
    expect(expire).toContain("target.is_current = TRUE");
  });

  it("hashes only the change-tracked columns, not the business key", () => {
    // customer_name is trackChanges: true; customer_id is the business key and must be
    // excluded, or every row would look changed the moment the key is re-read.
    expect(contents).toContain(
      "FARM_FINGERPRINT(CONCAT(CAST(s.full_name AS STRING))) AS change_hash",
    );
  });

  it("versions the surrogate key, so each historical row is distinct", () => {
    // Without the validity timestamp in the hash, every version of one customer shares a
    // surrogate key and a fact table cannot tell them apart.
    expect(contents).toMatch(/FARM_FINGERPRINT\(CONCAT\(CAST\(s\.id AS STRING\), '\|', CAST\(CURRENT_TIMESTAMP\(\)/);
  });

  it("inserts only keys with no current row", () => {
    expect(insert).toContain("LEFT JOIN ${self()} AS target");
    expect(insert).toContain("WHERE target.customer_id IS NULL");
    expect(insert).toContain("TRUE AS is_current");
    expect(insert).toContain("CAST(NULL AS TIMESTAMP) AS valid_to");
  });

  it("declares hasOutput so the rest of the project can reference it", () => {
    expect(contents).toContain("hasOutput: true");
  });

  it("does not claim an inline uniqueKey assertion", () => {
    // Uniqueness on a type-2 dimension holds only among current rows. A bare uniqueKey
    // assertion would fail the first time a customer changes.
    expect(contents).not.toContain("assertions:");
  });

  it("generates a single-current-row assertion instead", () => {
    const assertions = generateAssertions(graph, "warehouse");
    const single = fileFor(assertions, "single_current");
    expect(single.contents).toContain("WHERE is_current = TRUE");
    expect(single.contents).toContain("GROUP BY customer_id");
    expect(single.contents).toContain("HAVING COUNT(*) > 1");
  });
});

// ---------------------------------------------------------------- surrogate keys

describe("surrogate keys", () => {
  function withStrategy(strategy: string): string {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...scd2Mapping,
      loadStrategy: "full",
      dimensional: {
        businessKey: ["customer_id"],
        surrogateKey: "customer_key",
        surrogateKeyStrategy: strategy,
      },
    });
    return fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;
  }

  it("hashes the business key, deterministically", () => {
    // Determinism is the point: the same business key yields the same surrogate in dev,
    // in prod and after a full rebuild, so environments stay comparable.
    expect(withStrategy("hash")).toContain(
      "FARM_FINGERPRINT(CONCAT(CAST(s.id AS STRING))) AS customer_key",
    );
  });

  it("supports uuid and rowNumber", () => {
    expect(withStrategy("uuid")).toContain("GENERATE_UUID() AS customer_key");
    expect(withStrategy("rowNumber")).toContain("ROW_NUMBER() OVER (ORDER BY s.id) AS customer_key");
  });

  it("synthesises nothing when the source already provides it", () => {
    const contents = withStrategy("sourceProvided");
    expect(contents).not.toContain("AS customer_key");
  });

  it("casts every part and separates them, so composite keys cannot collide", () => {
    // Without the separator ('a','bc') and ('ab','c') hash identically.
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...scd2Mapping,
      loadStrategy: "full",
      columnMappings: [
        { target: "customer_id", sources: ["s.id"] },
        { target: "customer_name", sources: ["s.full_name"] },
      ],
      dimensional: {
        businessKey: ["customer_id", "customer_name"],
        surrogateKey: "customer_key",
        surrogateKeyStrategy: "hash",
      },
    });
    expect(fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents).toContain(
      "FARM_FINGERPRINT(CONCAT(CAST(s.id AS STRING), '|', CAST(s.full_name AS STRING)))",
    );
  });
});

// ---------------------------------------------------------------- facts

describe("fact loads", () => {
  const graph = graphOf(model, rawCustomer, dimCustomer, factOrderLine, factMapping);
  const contents = fileFor(generateDataform(graph, "warehouse"), "fct_order_line").contents;

  it("joins a point-in-time dimension on the fact's own event time", () => {
    // This is the difference between reporting the customer's segment today and the
    // segment as it was when the order was placed. The first answer is quietly wrong.
    expect(contents).toContain("dim_customer_key.valid_from <= s.order_date");
    expect(contents).toContain(
      "(dim_customer_key.valid_to IS NULL OR dim_customer_key.valid_to > s.order_date)",
    );
  });

  it("joins a non-historical dimension on its current row instead", () => {
    const currentOnly = graphOf(model, rawCustomer, dimCustomer, factOrderLine, {
      ...factMapping,
      dimensional: {
        ...factMapping.dimensional,
        dimensionLookups: [{ ...factMapping.dimensional.dimensionLookups[0], pointInTime: false }],
      },
    });
    const sql = fileFor(generateDataform(currentOnly, "warehouse"), "fct_order_line").contents;
    expect(sql).toContain("dim_customer_key.is_current = TRUE");
    expect(sql).not.toContain("valid_from <= s.order_date");
  });

  it("finds validity columns on the dimension table when its mapping is out of scope", () => {
    // A conformed dimension is shared across marts and is very often built by a different
    // model than the one loading the fact. Depending solely on the dimension's mapping
    // being loaded is what made this silently degrade.
    const withoutDimensionMapping = graphOf(
      model,
      rawCustomer,
      dimCustomer,
      factOrderLine,
      factMapping,
    );
    const sql = fileFor(
      generateDataform(withoutDimensionMapping, "warehouse"),
      "fct_order_line",
    ).contents;

    expect(sql).toContain("dim_customer_key.valid_from <= s.order_date");
    expect(sql).not.toContain("WARNING");
  });

  it("warns loudly rather than fanning out when validity columns cannot be found", () => {
    // Joining a fact to a type-2 dimension with no validity predicate returns a row per
    // historical version and silently multiplies every measure. A comment a reviewer sees
    // beats a number nobody questions.
    const flatDimension = {
      ...dimCustomer,
      columns: [
        { id: "d1", name: "customer_key", dataType: "INT64" },
        { id: "d2", name: "customer_id", dataType: "STRING" },
      ],
    };
    const graph = graphOf(model, rawCustomer, flatDimension, factOrderLine, factMapping);
    const sql = fileFor(generateDataform(graph, "warehouse"), "fct_order_line").contents;

    expect(sql).toContain("WARNING: point-in-time lookup requested");
    expect(sql).toContain("returns a row per historical version");
  });

  it("routes a missed lookup to the unknown member rather than NULL", () => {
    // A NULL surrogate silently drops the row from every inner-joined report.
    expect(contents).toContain("COALESCE(dim_customer_key.customer_key, -1) AS customer_key");
  });

  it("filters incrementally against its own high-water mark, with a lookback", () => {
    expect(contents).toContain(
      "s.order_date >= (SELECT DATE_SUB(MAX(order_date), INTERVAL 3 DAY) FROM ${self()})",
    );
  });

  it("guards the incremental filter with when(incremental())", () => {
    // On a first run the target does not exist and `SELECT MAX(...) FROM ${self()}`
    // would fail outright.
    expect(contents).toContain("${when(incremental()");
  });

  it("carries partitioning and clustering through to the config", () => {
    expect(contents).toContain('partitionBy: "order_date"');
    expect(contents).toContain('clusterBy: ["customer_key"]');
  });
});

// ---------------------------------------------------------------- declarations

describe("declarations", () => {
  it("declares a source table nothing in this model produces", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, scd2Mapping);
    const declarations = generateDeclarations(graph, "warehouse");

    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.contents).toContain('type: "declaration"');
    expect(declarations[0]!.contents).toContain('schema: "raw"');
    expect(declarations[0]!.path).toBe("definitions/sources/raw/raw_customer.sqlx");
  });

  it("does not declare a table this model builds", () => {
    // dim_customer is produced by a mapping, so declaring it would claim it is external.
    const graph = graphOf(model, rawCustomer, dimCustomer, scd2Mapping);
    const names = generateDeclarations(graph, "warehouse").map((f) => f.path);
    expect(names.some((p) => p.includes("dim_customer"))).toBe(false);
  });

  it("declares a shared source only once", () => {
    const second = { ...scd2Mapping, id: "map_two", name: "load_two", target: "fct_order_line" };
    const graph = graphOf(model, rawCustomer, dimCustomer, factOrderLine, scd2Mapping, second);
    expect(generateDeclarations(graph, "warehouse")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- assertions

describe("assertions", () => {
  const graph = graphOf(model, rawCustomer, dimCustomer, factOrderLine, factMapping);

  it("checks referential integrity, which BigQuery does not enforce", () => {
    const assertion = fileFor(generateAssertions(graph, "warehouse"), "assert_fk_fol_customer");
    expect(assertion.contents).toContain('type: "assertion"');
    expect(assertion.contents).toContain("LEFT JOIN `acme-prod.mart.dim_customer` AS p");
    expect(assertion.contents).toContain("p.customer_key = c.customer_key");
    // Only rows that claim a parent are violations; a NULL key is not an orphan.
    expect(assertion.contents).toContain("WHERE c.customer_key IS NOT NULL");
    expect(assertion.contents).toContain("AND p.customer_key IS NULL");
  });

  it("skips a foreign key marked assert: false", () => {
    const relaxed = graphOf(model, rawCustomer, dimCustomer, factMapping, {
      ...factOrderLine,
      foreignKeys: [{ ...factOrderLine.foreignKeys[0], assert: false }],
    });
    expect(generateAssertions(relaxed, "warehouse").some((f) => f.path.includes("fk_fol"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------- general

describe("generateDataform", () => {
  it("refuses a non-physical model", () => {
    const logical = graphOf({ ...model, id: "mdl_l", name: "logical_wh", tier: "logical" });
    expect(() => generateDataform(logical, "logical_wh")).toThrow(/only generated from physical/);
  });

  it("never wraps ${self()} in backticks", () => {
    // `self()` already expands to a backticked fully qualified name; quoting it again
    // produces SQL BigQuery rejects. This caught a real bug where the SCD2 statements
    // quoted it and the incremental predicate did not.
    const graph = graphOf(model, rawCustomer, dimCustomer, factOrderLine, scd2Mapping, factMapping);
    for (const file of generateDataform(graph, "warehouse")) {
      expect(file.contents).not.toContain("`${self()}`");
    }
  });

  it("honours customSql verbatim as the escape hatch", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...scd2Mapping,
      loadStrategy: "full",
      customSql: "SELECT 1 AS handwritten",
    });
    const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;
    expect(contents).toContain("SELECT 1 AS handwritten");
    expect(contents).not.toContain("FROM `acme-prod.raw.raw_customer`");
  });

  it("is deterministic, the same model produces the same bytes", () => {
    // What makes it safe to run in CI and reviewable as a diff.
    const graph = graphOf(model, rawCustomer, dimCustomer, factOrderLine, scd2Mapping, factMapping);
    const first = generateDataform(graph, "warehouse");
    const second = generateDataform(graph, "warehouse");
    expect(second.map((f) => f.contents)).toEqual(first.map((f) => f.contents));
  });

  it("qualifies every source with project and dataset", () => {
    // An unquoted or unqualified name resolves against whatever dataset the run happens
    // to default to, which is how a dev pipeline writes into prod.
    const graph = graphOf(model, rawCustomer, dimCustomer, scd2Mapping);
    expect(fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents).toContain(
      "`acme-prod.raw.raw_customer`",
    );
  });

  it("applies source filters and mapping-level where clauses", () => {
    const graph = graphOf(model, rawCustomer, dimCustomer, {
      ...scd2Mapping,
      loadStrategy: "full",
      sources: [{ alias: "s", ref: "raw_customer", filter: "s.id IS NOT NULL" }],
      where: "s.full_name != ''",
    });
    const contents = fileFor(generateDataform(graph, "warehouse"), "dim_customer").contents;
    expect(contents).toContain("WHERE s.id IS NOT NULL");
    expect(contents).toContain("AND s.full_name != ''");
  });
});
