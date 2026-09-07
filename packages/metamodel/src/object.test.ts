import { describe, expect, it } from "vitest";
import { parseObject } from "./object";

/**
 * What the schema throws away, and whether it admits to it.
 *
 * The physical schema strips unrecognised keys, which is how a file written by a newer
 * Strata still loads in an older one. The cost is that a key spelled wrongly is accepted,
 * discarded, and never mentioned.
 *
 * This has cost real work twice. `physical.ts` records the first: the properties panel
 * offered a Grain field the schema had no key for, so every save silently dropped the text.
 * The second shipped in the quickstart example, where `partitionBy` and `clusterBy` are
 * really called `partitioning` and `clustering`. Both were stripped on load, so `fct_order`
 * generated a `CREATE TABLE` with no `PARTITION BY` beneath a comment promising one, and
 * `strata check` was perfectly happy about it.
 *
 * The object still parses and still loads. `discarded` is how the loader knows to say that
 * part of the file had no effect.
 */

const table = {
  id: "tbl_fct_order",
  kind: "table" as const,
  name: "fct_order",
  model: "shop_warehouse",
  columns: [{ id: "col_a", name: "order_id", dataType: "STRING" }],
};

describe("parseObject", () => {
  it("says nothing when every key is real", () => {
    const result = parseObject(table);

    expect(result.object).toBeDefined();
    expect(result.discarded).toBeUndefined();
  });

  it("names a top-level key the schema does not have", () => {
    // The exact bug that shipped in the example: `clustering` misspelled as `clusterBy`.
    const result = parseObject({ ...table, clusterBy: ["customer_id"] });

    expect(result.object).toBeDefined();
    expect(result.discarded).toEqual(["clusterBy"]);
  });

  it("still returns a usable object, because stripping is not a failure", () => {
    const result = parseObject({ ...table, partitionBy: { field: "order_date" } });

    expect(result.error).toBeUndefined();
    expect(result.object?.kind).toBe("table");
    expect(result.discarded).toEqual(["partitionBy"]);
  });

  it("finds keys nested inside an array, with the index in the path", () => {
    /*
      The case worth catching most. A mistyped key on a column is the easiest mistake to
      make and the most expensive to lose, and a bare field name would not say which column
      it came from.
    */
    const result = parseObject({
      ...table,
      columns: [{ id: "col_a", name: "order_id", dataType: "STRING", datatype: "STRING" }],
    });

    expect(result.discarded).toEqual(["columns[0].datatype"]);
  });

  it("reports every discarded key, not just the first", () => {
    const result = parseObject({ ...table, clusterBy: [], partitionBy: {}, nonsense: 1 });

    expect(result.discarded).toEqual(["clusterBy", "partitionBy", "nonsense"]);
  });

  it("does not confuse a genuine schema violation for a discarded key", () => {
    // No `kind` at all is an error, and `discarded` has no meaning on a failed parse.
    const result = parseObject({ name: "nameless" });

    expect(result.object).toBeUndefined();
    expect(result.error).toContain("kind");
    expect(result.discarded).toBeUndefined();
  });
});
