import { describe, expect, it } from "vitest";
import { parseObject } from "./object";

/**
 * What the schema does not understand, and whether it admits to it.
 *
 * A key the schema has no field for is kept exactly as written and named in
 * `unrecognised`. Both halves matter, and for different reasons.
 *
 * Naming it has cost real work twice. `physical.ts` records the first: the properties panel
 * offered a Grain field the schema had no key for, so every save silently dropped the text.
 * The second shipped in the quickstart example, where `partitionBy` and `clusterBy` are
 * really called `partitioning` and `clustering`. Both were stripped on load, so `fct_order`
 * generated a `CREATE TABLE` with no `PARTITION BY` beneath a comment promising one, and
 * `strata check` was perfectly happy about it.
 *
 * Keeping it is what makes the format survive its own versions. Stripping was once
 * described here as the reason a file written by a newer Strata still loads in an older
 * one, and that is true but only of the read. The next save wrote the stripped object back,
 * so the newer version's fields left the repository as a deletion in a pull request nobody
 * authored. For a tool whose whole premise is that the files are the model, that is data
 * loss. See the round trip test in `packages/storage`.
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
    expect(result.unrecognised).toBeUndefined();
  });

  it("names a top-level key the schema does not have", () => {
    // The exact bug that shipped in the example: `clustering` misspelled as `clusterBy`.
    const result = parseObject({ ...table, clusterBy: ["customer_id"] });

    expect(result.object).toBeDefined();
    expect(result.unrecognised).toEqual(["clusterBy"]);
  });

  it("still returns a usable object, because an unknown key is not a failure", () => {
    const result = parseObject({ ...table, partitionBy: { field: "order_date" } });

    expect(result.error).toBeUndefined();
    expect(result.object?.kind).toBe("table");
    expect(result.unrecognised).toEqual(["partitionBy"]);
  });

  it("keeps the unrecognised value, so a later write cannot lose it", () => {
    const result = parseObject({ ...table, retentionPolicy: "7y" });

    expect(result.object).toMatchObject({ retentionPolicy: "7y" });
  });

  it("keeps an unrecognised value nested inside an array", () => {
    // Where a newer Strata is most likely to add a field, and where losing one is worst.
    const result = parseObject({
      ...table,
      columns: [{ id: "col_a", name: "order_id", dataType: "STRING", maskingPolicy: "sha256" }],
    });

    expect(result.object).toMatchObject({ columns: [{ maskingPolicy: "sha256" }] });
  });

  it("names `__proto__` but refuses to carry it", () => {
    /*
      The `yaml` parser gives a file's `__proto__` back as a real own key, and
      `target["__proto__"] = value` reassigns the prototype instead of adding a property.
      Model files are attacker-controlled wherever a workspace takes pull requests, so this
      one key is reported and dropped rather than preserved.
    */
    // Built through JSON.parse because `__proto__:` in an object literal is prototype
    // syntax, not an own key, and would not reproduce what the YAML parser hands over.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const input: Record<string, unknown> = { ...table };
    Object.defineProperty(input, "__proto__", {
      value: hostile.__proto__,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = parseObject(input);

    expect(result.unrecognised).toContain("__proto__");
    expect(Object.getPrototypeOf(result.object!)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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

    expect(result.unrecognised).toEqual(["columns[0].datatype"]);
  });

  it("reports every unrecognised key, not just the first", () => {
    const result = parseObject({ ...table, clusterBy: [], partitionBy: {}, nonsense: 1 });

    expect(result.unrecognised).toEqual(["clusterBy", "partitionBy", "nonsense"]);
  });

  it("does not confuse a genuine schema violation for an unrecognised key", () => {
    // No `kind` at all is an error, and `unrecognised` has no meaning on a failed parse.
    const result = parseObject({ name: "nameless" });

    expect(result.object).toBeUndefined();
    expect(result.error).toContain("kind");
    expect(result.unrecognised).toBeUndefined();
  });
});
