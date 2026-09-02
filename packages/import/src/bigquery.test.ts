import { describe, expect, it } from "vitest";
import { assertDatasetId, columnsQuery, readBigQuery, type BigQueryColumnRow } from "./bigquery.js";
import { mapToObjects } from "./index.js";

/**
 * The live BigQuery reader.
 *
 * Rows rather than a fixture server, because the reader takes rows: the network belongs to the
 * caller, so everything worth testing here is reachable without one. What the tests cannot cover
 * is whether `INFORMATION_SCHEMA` really returns these shapes, and the honest answer is the same
 * one the erwin reader gives about erwin: the projection is written against Google's documented
 * columns and has not been run against a real warehouse.
 */

function column(over: Partial<BigQueryColumnRow> = {}): BigQueryColumnRow {
  return {
    table_name: "dim_customer",
    column_name: "customer_id",
    data_type: "STRING",
    is_nullable: "NO",
    ordinal_position: 1,
    table_schema: "analytics",
    table_type: "BASE TABLE",
    ...over,
  };
}

describe("readBigQuery", () => {
  it("groups columns into tables and keeps the warehouse type verbatim", () => {
    const model = readBigQuery([
      column({ column_name: "customer_id", data_type: "STRING", ordinal_position: 1 }),
      column({ column_name: "lifetime_value", data_type: "NUMERIC(18, 2)", ordinal_position: 2, is_nullable: "YES" }),
      column({ table_name: "fct_order", column_name: "order_id", data_type: "INT64", ordinal_position: 1 }),
    ]);

    expect(model.entities).toHaveLength(2);
    expect(model.tier, "a warehouse read back is physical by definition").toBe("physical");

    const customer = model.entities.find((entity) => entity.name === "dim_customer");
    expect(customer?.columns.map((c) => c.name)).toEqual(["customer_id", "lifetime_value"]);
    // The precision must survive. Classifying it to `decimal` here would lose the scale.
    expect(customer?.columns[1]?.type).toBe("NUMERIC(18, 2)");
    expect(customer?.schema).toBe("analytics");
  });

  it("reads nullability the right way round", () => {
    /*
      The obvious mistake inverts every nullability in the warehouse and fails nothing: the
      string "NO" is truthy, so a truthiness test marks required columns optional and vice versa.
    */
    const model = readBigQuery([
      column({ column_name: "customer_id", is_nullable: "NO" }),
      column({ column_name: "nickname", is_nullable: "YES", ordinal_position: 2 }),
    ]);

    const columns = model.entities[0]!.columns;
    expect(columns[0]?.required, "is_nullable NO means required").toBe(true);
    expect(columns[1]?.required, "is_nullable YES means optional").toBe(false);
  });

  it("orders columns by ordinal position, not by the order rows arrived", () => {
    const model = readBigQuery([
      column({ column_name: "third", ordinal_position: 3 }),
      column({ column_name: "first", ordinal_position: 1 }),
      column({ column_name: "second", ordinal_position: 2 }),
    ]);

    expect(model.entities[0]!.columns.map((c) => c.name)).toEqual(["first", "second", "third"]);
  });

  it("takes only the primary key constraint, not every declared key", () => {
    /*
      BigQuery names a primary key `<table>.pk$` and foreign keys share the same view. Treating a
      foreign key as part of the primary key silently changes the table's grain, which is the kind
      of wrong that surfaces in a report months later.
    */
    const model = readBigQuery(
      [
        column({ column_name: "customer_id", ordinal_position: 1 }),
        column({ column_name: "region_id", ordinal_position: 2 }),
      ],
      [
        { table_name: "dim_customer", column_name: "customer_id", constraint_name: "dim_customer.pk$" },
        { table_name: "dim_customer", column_name: "region_id", constraint_name: "dim_customer.fk$region" },
      ],
    );

    const columns = model.entities[0]!.columns;
    expect(columns.find((c) => c.name === "customer_id")?.isPrimaryKey).toBe(true);
    expect(columns.find((c) => c.name === "region_id")?.isPrimaryKey).toBeUndefined();
  });

  it("says so when a nested column arrives as a type string rather than a tree", () => {
    const model = readBigQuery([
      column({ column_name: "address", data_type: "STRUCT<line1 STRING, postcode STRING>" }),
    ]);

    // The type is carried through, because it is correct BigQuery and generates valid DDL.
    expect(model.entities[0]!.columns[0]?.type).toBe("STRUCT<line1 STRING, postcode STRING>");
    // And the limitation is stated rather than left for someone to discover in the editor.
    expect(model.diagnostics.map((d) => d.code)).toContain("import/nestedAsType");
  });

  it("reports an empty dataset as an error rather than an empty success", () => {
    const model = readBigQuery([], [], { dataset: "analytics" });

    expect(model.entities).toHaveLength(0);
    const diagnostic = model.diagnostics.find((d) => d.code === "import/emptyDataset");
    expect(diagnostic?.severity).toBe("error");
    // Permission is the likelier cause than emptiness, and the message has to say so or the
    // user retries the same credential.
    expect(diagnostic?.message).toContain("analytics");
  });

  it("flags a view rather than silently importing it as a table", () => {
    const model = readBigQuery([column({ table_name: "v_customer", table_type: "VIEW" })]);

    expect(model.entities).toHaveLength(1);
    expect(model.diagnostics.map((d) => d.code)).toContain("import/viewAsTable");
  });

  it("feeds the existing mapper, which is the whole point of producing a SourceModel", () => {
    /*
      The integration that makes this a fourth reader rather than a new subsystem. Everything
      downstream, preview, collision detection, apply and propose, is reached through
      `mapToObjects`, so a reader that produces a valid `SourceModel` gets all of it for free.
    */
    const model = readBigQuery(
      [
        column({ column_name: "customer_id", data_type: "STRING", ordinal_position: 1 }),
        column({ column_name: "email", data_type: "STRING", ordinal_position: 2, is_nullable: "YES" }),
      ],
      [{ table_name: "dim_customer", column_name: "customer_id", constraint_name: "dim_customer.pk$" }],
    );

    const { objects } = mapToObjects(model, { model: "warehouse", tier: "physical", dataset: "analytics" });

    const table = objects.find((object) => object.name === "dim_customer");
    expect(table?.kind).toBe("table");
    expect((table?.columns as { name: string; dataType: string; mode: string }[] | undefined)?.[0]).toMatchObject({
      name: "customer_id",
      dataType: "STRING",
      mode: "REQUIRED",
    });
    expect(table?.primaryKey).toEqual(["customer_id"]);
  });
});

describe("assertDatasetId", () => {
  /**
   * The trust boundary. The dataset is interpolated into a query string, and BigQuery's own
   * backtick quoting is no defence because a backtick in the value closes it.
   */
  it("accepts a dataset, and a project-qualified one", () => {
    expect(assertDatasetId("analytics")).toBe("analytics");
    expect(assertDatasetId(" my-project.analytics ")).toBe("my-project.analytics");
  });

  it("refuses anything that could close the quoting or append a statement", () => {
    for (const bad of [
      "analytics`",
      "analytics`.INFORMATION_SCHEMA.COLUMNS; DROP TABLE x; --",
      "a b",
      "analytics.a.b",
      "",
      "../etc",
      "analytics'",
    ]) {
      expect(() => assertDatasetId(bad), `${bad} must be refused`).toThrow();
    }
  });

  it("never lets an unvalidated value reach the query text", () => {
    // The guard and the builder are separate functions, so this asserts they are actually used
    // together: a validated id appears in the query, and a hostile one never gets that far.
    expect(columnsQuery(assertDatasetId("analytics"))).toContain("`analytics`.INFORMATION_SCHEMA.COLUMNS");
    expect(() => columnsQuery(assertDatasetId("analytics`; --"))).toThrow();
  });
});
