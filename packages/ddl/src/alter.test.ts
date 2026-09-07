import { describe, expect, it } from "vitest";
import type { Column, Table } from "@strata/metamodel";
import { generateAlter, isWidening, renderAlterScript } from "./alter.js";

/**
 * ALTER generation, and specifically what it refuses to generate.
 *
 * The easy half, "a new column becomes ADD COLUMN", is barely worth a test. The half that
 * matters is the refusals: BigQuery cannot narrow a type, cannot add NOT NULL, cannot repartition
 * and cannot change a STRUCT's shape, and a generator that emitted the obvious statement anyway
 * would produce migrations that fail partway through and leave a table in a state nobody planned.
 * Most of what follows checks that nothing runnable is emitted for those.
 */

function column(name: string, dataType: string, extra: Partial<Column> = {}): Column {
  return {
    id: `col_${name}`,
    name,
    dataType,
    mode: "NULLABLE",
    tags: [],
    properties: {},
    previousNames: [],
    ...extra,
  } as Column;
}

function table(name: string, columns: Column[], extra: Partial<Table> = {}): Table {
  return {
    id: `tbl_${name}`,
    name,
    kind: "table",
    model: "warehouse",
    dataset: "mart",
    objectType: "table",
    columns,
    primaryKey: [],
    uniqueKeys: [],
    foreignKeys: [],
    clustering: [],
    options: { labels: {} },
    dataform: { tags: [], uniqueKey: [], dependencies: [], preOperations: [], postOperations: [] },
    tags: [],
    properties: {},
    previousNames: [],
    layers: [],
    ...extra,
  } as unknown as Table;
}

/**
 * A dotted name, which the generator backticks, and must.
 *
 * GCP project ids routinely contain hyphens, so BigQuery parses an unquoted
 * `acme-analytics-prod.mart.t` as subtraction. The expectations below include the backticks for
 * that reason; a version of this file without them was asserting broken SQL.
 */
const NAME = { qualifiedName: "proj.mart.dim_customer" };

describe("isWidening", () => {
  it("accepts BigQuery's widening conversions", () => {
    expect(isWidening("INT64", "NUMERIC")).toBe(true);
    expect(isWidening("NUMERIC", "BIGNUMERIC")).toBe(true);
    expect(isWidening("DATE", "DATETIME")).toBe(true);
    expect(isWidening("DATETIME", "TIMESTAMP")).toBe(true);
  });

  it("refuses narrowing", () => {
    expect(isWidening("NUMERIC", "INT64")).toBe(false);
    expect(isWidening("TIMESTAMP", "DATE")).toBe(false);
    expect(isWidening("STRING", "INT64")).toBe(false);
  });

  it("grows precision and scale together", () => {
    expect(isWidening("NUMERIC(9, 2)", "NUMERIC(18, 2)")).toBe(true);
    expect(isWidening("NUMERIC(9, 2)", "NUMERIC(9, 4)")).toBe(false);
  });

  it("refuses a precision increase that shrinks the integer part", () => {
    /**
     * The case a naive precision comparison gets wrong, and the reason this function exists.
     *
     * `NUMERIC(9, 2)` holds 7 integer digits; `NUMERIC(10, 4)` holds 6. Precision went up, so
     * "wider" looks true, but `12345678.90` no longer fits and BigQuery rejects the statement.
     */
    expect(isWidening("NUMERIC(9, 2)", "NUMERIC(10, 4)")).toBe(false);
  });

  it("treats removing parameters as widening and adding them as narrowing", () => {
    expect(isWidening("NUMERIC(9, 2)", "NUMERIC")).toBe(true);
    expect(isWidening("NUMERIC", "NUMERIC(9, 2)")).toBe(false);
  });

  it("is not a change when the types are identical", () => {
    expect(isWidening("STRING", "STRING")).toBe(false);
  });
});

describe("generateAlter", () => {
  it("adds a new nullable column", () => {
    const script = generateAlter(
      table("dim_customer", [column("id", "STRING")]),
      table("dim_customer", [column("id", "STRING"), column("email", "STRING")]),
      NAME,
    );

    expect(script.statements).toHaveLength(1);
    expect(script.statements[0]).toBe(
      "ALTER TABLE `proj.mart.dim_customer` ADD COLUMN IF NOT EXISTS email STRING;",
    );
    expect(script.requiresRecreate).toBe(false);
  });

  it("adds a REQUIRED column as nullable, and says so", () => {
    /**
     * BigQuery rejects `ADD COLUMN ... NOT NULL` outright, the rows that already exist would
     * violate it. Emitting it nullable gets the column in place and flags that the constraint did
     * not come with it, which is more useful than refusing the whole change.
     */
    const script = generateAlter(
      table("dim_customer", [column("id", "STRING")]),
      table("dim_customer", [column("id", "STRING"), column("email", "STRING", { mode: "REQUIRED" })]),
      NAME,
    );

    const change = script.changes.find((entry) => entry.code === "column/addRequired");
    expect(change?.severity).toBe("lossy");
    expect(change?.sql).not.toContain("NOT NULL");
    expect(change?.message).toContain("backfill");
  });

  it("widens a type in place", () => {
    const script = generateAlter(
      table("f", [column("amount", "NUMERIC(9, 2)")]),
      table("f", [column("amount", "NUMERIC(18, 2)")]),
      NAME,
    );

    expect(script.changes[0]?.code).toBe("column/widen");
    expect(script.statements[0]).toContain("SET DATA TYPE NUMERIC(18, 2)");
  });

  it("refuses to narrow a type and emits no SQL for it", () => {
    const script = generateAlter(
      table("f", [column("amount", "NUMERIC")]),
      table("f", [column("amount", "INT64")]),
      NAME,
    );

    const change = script.changes.find((entry) => entry.code === "column/typeChanged");
    expect(change?.severity).toBe("recreate");
    expect(change?.sql).toBeUndefined();
    expect(script.statements).toHaveLength(0);
    expect(script.requiresRecreate).toBe(true);
  });

  it("ignores whitespace differences inside type parameters", () => {
    /**
     * `NUMERIC(18,2)` from a warehouse and `NUMERIC(18, 2)` from a hand-written model are the
     * same type. Treating them as different would generate an ALTER for every such column on
     * every single run, which is how a drift report becomes noise nobody reads.
     */
    const script = generateAlter(
      table("f", [column("amount", "NUMERIC(18,2)")]),
      table("f", [column("amount", "NUMERIC(18, 2)")]),
      NAME,
    );
    expect(script.changes).toHaveLength(0);
  });

  it("drops NOT NULL but refuses to add it", () => {
    const relaxed = generateAlter(
      table("f", [column("id", "STRING", { mode: "REQUIRED" })]),
      table("f", [column("id", "STRING", { mode: "NULLABLE" })]),
      NAME,
    );
    expect(relaxed.changes[0]?.code).toBe("column/dropNotNull");
    expect(relaxed.statements[0]).toContain("DROP NOT NULL");

    const tightened = generateAlter(
      table("f", [column("id", "STRING", { mode: "NULLABLE" })]),
      table("f", [column("id", "STRING", { mode: "REQUIRED" })]),
      NAME,
    );
    expect(tightened.changes[0]?.code).toBe("column/addNotNull");
    expect(tightened.changes[0]?.severity).toBe("recreate");
    expect(tightened.statements).toHaveLength(0);
  });

  it("does not drop a missing column unless asked", () => {
    const kept = generateAlter(
      table("f", [column("id", "STRING"), column("legacy", "STRING")]),
      table("f", [column("id", "STRING")]),
      NAME,
    );

    expect(kept.changes[0]?.code).toBe("column/drop");
    expect(kept.changes[0]?.sql).toBeUndefined();
    expect(kept.changes[0]?.message).toContain("Not dropped");

    const dropped = generateAlter(
      table("f", [column("id", "STRING"), column("legacy", "STRING")]),
      table("f", [column("id", "STRING")]),
      { ...NAME, dropColumns: true },
    );
    expect(dropped.statements[0]).toBe(
      "ALTER TABLE `proj.mart.dim_customer` DROP COLUMN IF EXISTS legacy;",
    );
  });

  it("refuses to change a STRUCT's shape", () => {
    const before = table("f", [
      column("address", "STRUCT", { fields: [column("city", "STRING")] }),
    ]);
    const after = table("f", [
      column("address", "STRUCT", {
        fields: [column("city", "STRING"), column("postcode", "STRING")],
      }),
    ]);

    const script = generateAlter(before, after, NAME);
    const change = script.changes.find((entry) => entry.code === "field/add");
    expect(change?.severity).toBe("recreate");
    expect(change?.column).toBe("address.postcode");
    expect(script.statements).toHaveLength(0);
  });

  it("refuses to repartition", () => {
    const script = generateAlter(
      table("f", [column("ts", "TIMESTAMP")]),
      table("f", [column("ts", "TIMESTAMP")], {
        partitioning: { type: "time", field: "ts", granularity: "DAY", requireFilter: false },
      }),
      NAME,
    );

    const change = script.changes.find((entry) => entry.code === "partitioning/changed");
    expect(change?.severity).toBe("recreate");
    expect(change?.sql).toBeUndefined();
  });

  it("re-clusters in place but refuses to un-cluster", () => {
    const clustered = generateAlter(
      table("f", [column("id", "STRING")]),
      table("f", [column("id", "STRING")], { clustering: ["id"] }),
      NAME,
    );
    expect(clustered.changes[0]?.severity).toBe("supported");
    expect(clustered.statements[0]).toContain('clustering_fields = ["id"]');

    const unclustered = generateAlter(
      table("f", [column("id", "STRING")], { clustering: ["id"] }),
      table("f", [column("id", "STRING")]),
      NAME,
    );
    expect(unclustered.changes[0]?.severity).toBe("recreate");
  });

  it("drops the old primary key before adding the new one", () => {
    const script = generateAlter(
      table("f", [column("a", "STRING"), column("b", "STRING")], { primaryKey: ["a"] }),
      table("f", [column("a", "STRING"), column("b", "STRING")], { primaryKey: ["a", "b"] }),
      NAME,
    );

    const sql = script.statements[0] as string;
    expect(sql.indexOf("DROP PRIMARY KEY")).toBeLessThan(sql.indexOf("ADD PRIMARY KEY"));
    expect(sql).toContain("NOT ENFORCED");
  });

  it("quotes each segment of a nested path separately", () => {
    /**
     * `` `outer.inner` `` names a column whose name contains a dot; `` `outer`.`inner` `` names a
     * field inside a struct. They are different columns and the first does not exist.
     */
    const before = table("f", [
      column("address", "STRUCT", { fields: [column("post code", "STRING", { mode: "REQUIRED" })] }),
    ]);
    const after = table("f", [
      column("address", "STRUCT", { fields: [column("post code", "STRING", { mode: "NULLABLE" })] }),
    ]);

    const script = generateAlter(before, after, NAME);
    expect(script.statements[0]).toContain("address.`post code`");
  });

  it("finds nothing to do for identical tables", () => {
    const one = table("f", [column("id", "STRING"), column("amount", "NUMERIC(18, 2)")]);
    const two = table("f", [column("id", "STRING"), column("amount", "NUMERIC(18, 2)")]);
    expect(generateAlter(one, two, NAME).changes).toHaveLength(0);
  });
});

describe("renderAlterScript", () => {
  it("says so plainly when there is nothing to do", () => {
    const script = generateAlter(
      table("f", [column("id", "STRING")]),
      table("f", [column("id", "STRING")]),
      NAME,
    );
    expect(renderAlterScript(script)).toContain("No differences");
  });

  it("spells out what it left out rather than silently omitting it", () => {
    /**
     * The failure this guards against is a script that looks complete. If the eight changes
     * BigQuery cannot make are simply absent, whoever runs it believes the table now matches the
     * model, and it does not.
     */
    const script = generateAlter(
      table("f", [column("amount", "NUMERIC")]),
      table("f", [column("amount", "INT64")]),
      NAME,
    );

    const text = renderAlterScript(script);
    expect(text).toContain("CANNOT be applied in place");
    expect(text).toContain("needs rebuilding");
    expect(text).toContain("column/typeChanged");
    expect(text).not.toMatch(/^ALTER TABLE/m);
  });

  it("comments every statement with what it is for", () => {
    const script = generateAlter(
      table("f", [column("id", "STRING")]),
      table("f", [column("id", "STRING"), column("email", "STRING")]),
      NAME,
    );

    const text = renderAlterScript(script);
    expect(text).toContain("-- Add `email`.");
    expect(text).toContain("ALTER TABLE `proj.mart.dim_customer` ADD COLUMN");
  });
});
