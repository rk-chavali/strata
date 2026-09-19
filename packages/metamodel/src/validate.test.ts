import { describe, expect, it } from "vitest";
import { ObjectGraph } from "./graph.js";
import { parseObject, type AnyObject } from "./object.js";
import { validate } from "./validate.js";

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function codesFor(...inputs: Record<string, unknown>[]): string[] {
  const graph = ObjectGraph.from(inputs.map((i) => ({ object: obj(i) })));
  return validate(graph).map((d) => d.code);
}

const logicalModel = { id: "mdl_core", kind: "model", name: "core", tier: "logical" };
const physicalModel = {
  id: "mdl_wh",
  kind: "model",
  name: "warehouse",
  tier: "physical",
  target: { project: "acme", dataset: "core" },
};

describe("uniqueness", () => {
  it("rejects duplicate ids", () => {
    expect(
      codesFor(logicalModel, { id: "ent_1", kind: "entity", name: "A", model: "core" }, {
        id: "ent_1",
        kind: "entity",
        name: "B",
        model: "core",
      }),
    ).toContain("id/duplicate");
  });

  it("rejects two objects of the same kind and name in one model", () => {
    expect(
      codesFor(logicalModel, { id: "ent_1", kind: "entity", name: "Customer", model: "core" }, {
        id: "ent_2",
        kind: "entity",
        name: "customer",
        model: "core",
      }),
    ).toContain("name/duplicate");
  });

  it("allows the same name in different models", () => {
    const codes = codesFor(
      logicalModel,
      physicalModel,
      { id: "ent_1", kind: "entity", name: "Customer", model: "core" },
      { id: "tbl_1", kind: "table", name: "Customer", model: "warehouse", columns: [{ id: "col_1", name: "id", dataType: "INT64" }] },
    );
    expect(codes).not.toContain("name/duplicate");
  });
});

describe("model membership and tiers", () => {
  it("requires objects to declare their model", () => {
    expect(codesFor(logicalModel, { id: "ent_1", kind: "entity", name: "A" })).toContain("model/missing");
  });

  it("rejects an entity placed in a physical model", () => {
    expect(codesFor(physicalModel, { id: "ent_1", kind: "entity", name: "A", model: "warehouse" })).toContain(
      "tier/mismatch",
    );
  });

  it("rejects a conceptual model deriving from a physical one", () => {
    expect(
      codesFor(physicalModel, {
        id: "mdl_c",
        kind: "model",
        name: "biz",
        tier: "conceptual",
        derivedFrom: "warehouse",
      }),
    ).toContain("tier/inverted");
  });
});

describe("entity keys", () => {
  it("rejects a primary key naming an attribute that does not exist", () => {
    expect(
      codesFor(logicalModel, {
        id: "ent_1",
        kind: "entity",
        name: "Customer",
        model: "core",
        attributes: [{ id: "att_1", name: "id", logicalType: "string", required: true }],
        primaryKey: ["customer_id"],
      }),
    ).toContain("key/unknownAttribute");
  });

  it("rejects a nullable primary key attribute", () => {
    expect(
      codesFor(logicalModel, {
        id: "ent_1",
        kind: "entity",
        name: "Customer",
        model: "core",
        attributes: [{ id: "att_1", name: "id", logicalType: "string" }],
        primaryKey: ["id"],
      }),
    ).toContain("key/nullable");
  });

  it("accepts a well-formed entity", () => {
    const codes = codesFor(logicalModel, {
      id: "ent_1",
      kind: "entity",
      name: "Customer",
      model: "core",
      attributes: [{ id: "att_1", name: "id", logicalType: "string", required: true }],
      primaryKey: ["id"],
    });
    expect(codes).toEqual([]);
  });
});

describe("BigQuery physical rules", () => {
  const table = (overrides: Record<string, unknown>) => ({
    id: "tbl_1",
    kind: "table",
    name: "orders",
    model: "warehouse",
    columns: [
      { id: "col_1", name: "order_id", dataType: "INT64", mode: "REQUIRED" },
      { id: "col_2", name: "ordered_at", dataType: "TIMESTAMP" },
      { id: "col_3", name: "status", dataType: "STRING" },
    ],
    ...overrides,
  });

  it("rejects an invalid column type", () => {
    expect(
      codesFor(physicalModel, table({ columns: [{ id: "col_1", name: "a", dataType: "VARCHAR(10)" }] })),
    ).toContain("bq/badType");
  });

  it("rejects identifiers BigQuery would not accept", () => {
    expect(codesFor(physicalModel, table({ name: "2orders" }))).toContain("bq/badTableName");
    expect(
      codesFor(physicalModel, table({ columns: [{ id: "col_1", name: "order-id", dataType: "INT64" }] })),
    ).toContain("bq/badColumnName");
  });

  it("rejects partitioning on a non-temporal column", () => {
    expect(
      codesFor(physicalModel, table({ partitioning: { type: "time", field: "status" } })),
    ).toContain("bq/badPartitionType");
  });

  it("accepts partitioning on a TIMESTAMP column", () => {
    expect(
      codesFor(physicalModel, table({ partitioning: { type: "time", field: "ordered_at" } })),
    ).not.toContain("bq/badPartitionType");
  });

  it("rejects more than four clustering columns", () => {
    expect(
      codesFor(
        physicalModel,
        table({
          columns: ["a", "b", "c", "d", "e"].map((n, i) => ({ id: `col_${i}`, name: n, dataType: "STRING" })),
          clustering: ["a", "b", "c", "d", "e"],
        }),
      ),
    ).toContain("bq/tooManyClusteringColumns");
  });

  it("rejects nested fields on a non-STRUCT column", () => {
    expect(
      codesFor(
        physicalModel,
        table({
          columns: [
            { id: "col_1", name: "a", dataType: "STRING", fields: [{ id: "col_2", name: "b", dataType: "STRING" }] },
          ],
        }),
      ),
    ).toContain("column/unexpectedFields");
  });

  it("validates nested struct fields recursively", () => {
    expect(
      codesFor(
        physicalModel,
        table({
          columns: [
            {
              id: "col_1",
              name: "address",
              dataType: "STRUCT",
              fields: [{ id: "col_2", name: "post code", dataType: "STRING" }],
            },
          ],
        }),
      ),
    ).toContain("bq/badColumnName");
  });

  it("rejects a foreign key whose target column does not exist", () => {
    const codes = codesFor(
      physicalModel,
      table({}),
      {
        id: "tbl_2",
        kind: "table",
        name: "customers",
        model: "warehouse",
        columns: [{ id: "col_9", name: "customer_id", dataType: "INT64" }],
      },
      {
        id: "tbl_3",
        kind: "table",
        name: "order_lines",
        model: "warehouse",
        columns: [{ id: "col_10", name: "cust_id", dataType: "INT64" }],
        foreignKeys: [
          { name: "fk_cust", columns: ["cust_id"], references: { table: "customers", columns: ["nope"] } },
        ],
      },
    );
    expect(codes).toContain("column/unknown");
  });
});

describe("dimensional mappings", () => {
  const dimTable = {
    id: "tbl_dim",
    kind: "table",
    name: "dim_customer",
    model: "warehouse",
    columns: [
      { id: "c1", name: "customer_key", dataType: "INT64", mode: "REQUIRED" },
      { id: "c2", name: "customer_id", dataType: "STRING", mode: "REQUIRED" },
      { id: "c3", name: "name", dataType: "STRING" },
      { id: "c4", name: "valid_from", dataType: "TIMESTAMP" },
      { id: "c5", name: "valid_to", dataType: "TIMESTAMP" },
      { id: "c6", name: "is_current", dataType: "BOOL" },
    ],
  };
  const stgTable = {
    id: "tbl_stg",
    kind: "table",
    name: "stg_customer",
    model: "warehouse",
    columns: [
      { id: "s1", name: "customer_id", dataType: "STRING" },
      { id: "s2", name: "name", dataType: "STRING" },
    ],
  };

  it("requires the validity columns for an SCD2 load", () => {
    const codes = codesFor(physicalModel, dimTable, stgTable, {
      id: "map_1",
      kind: "mapping",
      name: "load_dim_customer",
      model: "warehouse",
      target: "dim_customer",
      loadStrategy: "scd2",
      sources: [{ ref: "stg_customer", alias: "s" }],
      dimensional: { businessKey: ["customer_id"], surrogateKey: "customer_key" },
      columnMappings: [
        { target: "customer_id", sources: ["s.customer_id"] },
        { target: "name", sources: ["s.name"] },
      ],
    });
    expect(codes).toContain("dimensional/missingScd2Column");
  });

  it("accepts a complete SCD2 mapping", () => {
    const codes = codesFor(physicalModel, dimTable, stgTable, {
      id: "map_1",
      kind: "mapping",
      name: "load_dim_customer",
      model: "warehouse",
      target: "dim_customer",
      loadStrategy: "scd2",
      sources: [{ ref: "stg_customer", alias: "s" }],
      dimensional: {
        businessKey: ["customer_id"],
        surrogateKey: "customer_key",
        validFromColumn: "valid_from",
        validToColumn: "valid_to",
        currentFlagColumn: "is_current",
      },
      columnMappings: [
        { target: "customer_id", sources: ["s.customer_id"] },
        { target: "name", sources: ["s.name"] },
      ],
    });
    expect(codes).toEqual([]);
  });

  it("flags a required target column that nothing populates", () => {
    const codes = codesFor(physicalModel, dimTable, stgTable, {
      id: "map_1",
      kind: "mapping",
      name: "load_dim_customer",
      model: "warehouse",
      target: "dim_customer",
      loadStrategy: "full",
      sources: [{ ref: "stg_customer", alias: "s" }],
      columnMappings: [{ target: "name", sources: ["s.name"] }],
    });
    // `customer_id` is REQUIRED and unmapped, so this must be an error.
    expect(codes).toContain("mapping/missingColumn");
  });

  it("rejects a column mapping referring to an alias the mapping never declared", () => {
    const codes = codesFor(physicalModel, dimTable, stgTable, {
      id: "map_1",
      kind: "mapping",
      name: "load_dim_customer",
      model: "warehouse",
      target: "dim_customer",
      loadStrategy: "full",
      sources: [{ ref: "stg_customer", alias: "s" }],
      columnMappings: [{ target: "name", sources: ["other.name"] }],
    });
    expect(codes).toContain("mapping/unknownAlias");
  });

  it("requires a join on every source after the first", () => {
    const codes = codesFor(physicalModel, dimTable, stgTable, {
      id: "map_1",
      kind: "mapping",
      name: "load_dim_customer",
      model: "warehouse",
      target: "dim_customer",
      loadStrategy: "full",
      sources: [
        { ref: "stg_customer", alias: "s" },
        { ref: "stg_customer", alias: "t" },
      ],
      columnMappings: [{ target: "name", sources: ["s.name"] }],
    });
    expect(codes).toContain("mapping/missingJoin");
  });

  it("rejects a point-in-time lookup against a dimension that keeps no history", () => {
    const codes = codesFor(
      physicalModel,
      dimTable,
      stgTable,
      {
        id: "tbl_fact",
        kind: "table",
        name: "fct_order",
        model: "warehouse",
        columns: [
          { id: "f1", name: "customer_key", dataType: "INT64" },
          { id: "f2", name: "customer_id", dataType: "STRING" },
        ],
      },
      {
        id: "map_dim",
        kind: "mapping",
        name: "load_dim",
        model: "warehouse",
        target: "dim_customer",
        loadStrategy: "scd1",
        sources: [{ ref: "stg_customer", alias: "s" }],
        dimensional: { businessKey: ["customer_id"] },
        customSql: "select 1",
      },
      {
        id: "map_fact",
        kind: "mapping",
        name: "load_fact",
        model: "warehouse",
        target: "fct_order",
        loadStrategy: "append",
        sources: [{ ref: "stg_customer", alias: "s" }],
        customSql: "select 1",
        dimensional: {
          dimensionLookups: [
            {
              column: "customer_key",
              dimension: "dim_customer",
              sourceColumn: "customer_id",
              pointInTime: true,
              unknownMemberKey: -1,
            },
          ],
        },
      },
    );
    expect(codes).toContain("dimensional/pointInTimeWithoutHistory");
  });
});

describe("parseObject", () => {
  it("explains a missing kind rather than dumping a union error", () => {
    expect(parseObject({ id: "x", name: "y" }).error).toContain("missing a `kind`");
  });

  it("names the unknown kind", () => {
    expect(parseObject({ kind: "widget", id: "x", name: "y" }).error).toContain("unknown kind `widget`");
  });

  it("applies defaults so callers never handle undefined collections", () => {
    const result = parseObject({ id: "ent_1", kind: "entity", name: "A", model: "core" });
    expect(result.object).toMatchObject({ attributes: [], tags: [], primaryKey: [], properties: {} });
  });
});
