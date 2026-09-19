import { describe, expect, it } from "vitest";
import { assertDatasetId, columnsQuery, readBigQuery, type BigQueryColumnRow } from "./bigquery.js";
import { mapToObjects } from "./index.js";

/**
 * The live BigQuery reader.
 *
 * Rows rather than a fixture server, because the reader takes rows: the network belongs to the
 * caller, so everything worth testing here is reachable without one.
 *
 * The shapes were written against Google's documented columns and have since been checked
 * against a real dataset: the three queries were run against a live BigQuery project and their
 * rows fed through this reader, which produced four tables, the compound key on `order_lines`,
 * and all three declared relationships with `lines_order` correctly identifying.
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
    const model = readBigQuery([], [], [], { dataset: "analytics" });

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

/**
 * Declared foreign keys, which the reader used to throw away.
 *
 * It read `KEY_COLUMN_USAGE`, kept the `pk$` constraints and skipped everything else, so an
 * imported model had primary keys and no relationships. That looks complete: every table is
 * there, every column is there, and a diagram of islands does not read as an error. The cost is
 * downstream, where joins are derived from relationships, so a model without them cannot be told
 * that joining a line-item table repeats its parent's rows and inflates a sum over them.
 *
 * The row shapes here are the ones a real BigQuery dataset returns, checked against one.
 */
describe("foreign keys", () => {
  const orderColumns = [
    column({ table_name: "orders", column_name: "order_id", ordinal_position: 1 }),
    column({ table_name: "orders", column_name: "total", data_type: "NUMERIC", ordinal_position: 2 }),
    column({ table_name: "order_lines", column_name: "order_id", ordinal_position: 1 }),
    column({ table_name: "order_lines", column_name: "line_number", data_type: "INT64", ordinal_position: 2 }),
  ];

  const orderKeys = [
    { table_name: "orders", column_name: "order_id", constraint_name: "orders.pk$", ordinal_position: 1 },
    { table_name: "order_lines", column_name: "order_id", constraint_name: "order_lines.pk$", ordinal_position: 1 },
    { table_name: "order_lines", column_name: "line_number", constraint_name: "order_lines.pk$", ordinal_position: 2 },
    { table_name: "order_lines", column_name: "order_id", constraint_name: "order_lines.lines_order", ordinal_position: 1 },
  ];

  const orderConstraints = [
    { constraint_name: "order_lines.lines_order", table_name: "orders", column_name: "order_id" },
  ];

  it("turns a declared foreign key into a relationship", () => {
    const model = readBigQuery(orderColumns, orderKeys, orderConstraints, { dataset: "main" });

    expect(model.relationships).toHaveLength(1);
    const [relationship] = model.relationships;
    // The child holds the foreign key and is therefore the many side. Inverting this inverts
    // every join drawn from it.
    expect(relationship?.child).toBe("order_lines");
    expect(relationship?.parent).toBe("orders");
    expect(relationship?.childColumns).toEqual(["order_id"]);
    expect(relationship?.parentColumns).toEqual(["order_id"]);
    expect(relationship?.cardinality).toBe("many-to-one");
  });

  it("names it without the table prefix BigQuery puts on a constraint", () => {
    const model = readBigQuery(orderColumns, orderKeys, orderConstraints, { dataset: "main" });

    expect(model.relationships[0]?.name).toBe("lines_order");
  });

  it("marks it identifying when the foreign key is part of the child's own key", () => {
    // order_lines is keyed on (order_id, line_number), so it cannot exist without an order.
    const model = readBigQuery(orderColumns, orderKeys, orderConstraints, { dataset: "main" });

    expect(model.relationships[0]?.identifying).toBe(true);
  });

  it("does not mark it identifying when the foreign key is merely a reference", () => {
    const columns = [
      column({ table_name: "orders", column_name: "order_id", ordinal_position: 1 }),
      column({ table_name: "campaigns", column_name: "campaign_id", ordinal_position: 1 }),
      column({ table_name: "campaigns", column_name: "order_id", ordinal_position: 2 }),
    ];
    const keys = [
      { table_name: "orders", column_name: "order_id", constraint_name: "orders.pk$", ordinal_position: 1 },
      { table_name: "campaigns", column_name: "campaign_id", constraint_name: "campaigns.pk$", ordinal_position: 1 },
      { table_name: "campaigns", column_name: "order_id", constraint_name: "campaigns.campaigns_order", ordinal_position: 1 },
    ];
    const constraints = [
      { constraint_name: "campaigns.campaigns_order", table_name: "orders", column_name: "order_id" },
    ];

    const model = readBigQuery(columns, keys, constraints, { dataset: "main" });

    expect(model.relationships[0]?.identifying).toBe(false);
  });

  it("still reads the primary key, in its declared order", () => {
    // A compound key read out of order pairs the wrong columns everywhere it is used.
    const model = readBigQuery(orderColumns, orderKeys, orderConstraints, { dataset: "main" });

    const lines = model.entities.find((e) => e.name === "order_lines");
    expect(lines?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual([
      "order_id",
      "line_number",
    ]);
  });

  it("does not read a primary key constraint as a relationship", () => {
    // CONSTRAINT_COLUMN_USAGE carries rows for primary keys too. Treating one as a foreign key
    // would give every table a relationship to itself.
    const constraints = [
      ...orderConstraints,
      { constraint_name: "orders.pk$", table_name: "orders", column_name: "order_id" },
      { constraint_name: "order_lines.pk$", table_name: "order_lines", column_name: "order_id" },
    ];

    const model = readBigQuery(orderColumns, orderKeys, constraints, { dataset: "main" });

    expect(model.relationships).toHaveLength(1);
    expect(model.relationships[0]?.name).toBe("lines_order");
  });

  it("pairs a compound foreign key by the parent's key order, not by row order", () => {
    /*
      CONSTRAINT_COLUMN_USAGE records no ordinal position, so its rows cannot be zipped against
      the referencing columns. Here they arrive reversed, which a naive pairing would take as
      truth and produce a join matching line_number to order_id.
    */
    const columns = [
      column({ table_name: "order_lines", column_name: "order_id", ordinal_position: 1 }),
      column({ table_name: "order_lines", column_name: "line_number", ordinal_position: 2 }),
      column({ table_name: "shipments", column_name: "order_id", ordinal_position: 1 }),
      column({ table_name: "shipments", column_name: "line_number", ordinal_position: 2 }),
    ];
    const keys = [
      { table_name: "order_lines", column_name: "order_id", constraint_name: "order_lines.pk$", ordinal_position: 1 },
      { table_name: "order_lines", column_name: "line_number", constraint_name: "order_lines.pk$", ordinal_position: 2 },
      { table_name: "shipments", column_name: "order_id", constraint_name: "shipments.ships_line", ordinal_position: 1 },
      { table_name: "shipments", column_name: "line_number", constraint_name: "shipments.ships_line", ordinal_position: 2 },
    ];
    const constraints = [
      { constraint_name: "shipments.ships_line", table_name: "order_lines", column_name: "line_number" },
      { constraint_name: "shipments.ships_line", table_name: "order_lines", column_name: "order_id" },
    ];

    const model = readBigQuery(columns, keys, constraints, { dataset: "main" });

    expect(model.relationships[0]?.childColumns).toEqual(["order_id", "line_number"]);
    expect(model.relationships[0]?.parentColumns).toEqual(["order_id", "line_number"]);
  });

  it("leaves out a foreign key it cannot pair, and says so", () => {
    // The parent has no declared key, so nothing orders the referenced side. A join with its
    // columns crossed runs and returns the wrong rows, which is worse than no join.
    const columns = [
      column({ table_name: "order_lines", column_name: "order_id", ordinal_position: 1 }),
      column({ table_name: "shipments", column_name: "order_id", ordinal_position: 1 }),
      column({ table_name: "shipments", column_name: "line_number", ordinal_position: 2 }),
    ];
    const keys = [
      { table_name: "shipments", column_name: "order_id", constraint_name: "shipments.ships_line", ordinal_position: 1 },
      { table_name: "shipments", column_name: "line_number", constraint_name: "shipments.ships_line", ordinal_position: 2 },
    ];
    const constraints = [
      { constraint_name: "shipments.ships_line", table_name: "order_lines", column_name: "order_id" },
    ];

    const model = readBigQuery(columns, keys, constraints, { dataset: "main" });

    expect(model.relationships).toHaveLength(0);
    expect(model.diagnostics.map((d) => d.code)).toContain("import/unpairableForeignKey");
  });

  it("says when a dataset declares no foreign keys at all", () => {
    // Silence here is what made the old behaviour invisible: a model with no joins looked fine.
    const model = readBigQuery(orderColumns, orderKeys, [], { dataset: "main" });

    expect(model.relationships).toHaveLength(0);
    expect(model.diagnostics.map((d) => d.code)).toContain("import/noRelationships");
  });

  it("leaves out a key pointing at a table that was not imported", () => {
    const constraints = [
      { constraint_name: "order_lines.lines_order", table_name: "somewhere_else", column_name: "id" },
    ];

    const model = readBigQuery(orderColumns, orderKeys, constraints, { dataset: "main" });

    expect(model.relationships).toHaveLength(0);
  });

  it("carries the relationships through to the mapper", () => {
    // The reader's output is only worth anything if the rest of the pipeline receives it.
    const model = readBigQuery(orderColumns, orderKeys, orderConstraints, { dataset: "main" });
    const mapped = mapToObjects(model, { model: "warehouse", tier: "physical", dataset: "main" });

    expect(JSON.stringify(mapped)).toContain("lines_order");
  });
});
