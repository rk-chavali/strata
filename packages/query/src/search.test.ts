import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject } from "@strata/metamodel";
import { search } from "./search.js";

/**
 * Workspace search.
 *
 * The palette previously matched object names only, which answers "what is this called" and
 * nothing else. These tests are about the questions that needed the other facets: which table
 * holds a column, and where a sentence was written down.
 */

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function fixture(): ObjectGraph {
  const graph = new ObjectGraph();

  graph.add(obj({ id: "mdl", kind: "model", name: "warehouse", tier: "physical", namespace: "sales" }));

  graph.add(
    obj({
      id: "gls",
      kind: "glossaryTerm",
      name: "Chargeback",
      definition: "A payment reversed by the issuing bank after a dispute.",
    }),
  );

  graph.add(
    obj({
      id: "tbl_c",
      kind: "table",
      name: "dim_customer",
      model: "warehouse",
      description: "One row per customer.",
      columns: [
        { id: "c1", name: "email_address", dataType: "STRING" },
        { id: "c2", name: "reorder_flag", dataType: "BOOL" },
        { id: "c3", name: "order_total", dataType: "NUMERIC" },
        {
          id: "c4",
          name: "address",
          dataType: "STRUCT",
          fields: [{ id: "c5", name: "postcode", dataType: "STRING", description: "Royal Mail postcode." }],
        },
      ],
    }),
  );

  graph.add(
    obj({
      id: "map",
      kind: "mapping",
      name: "load_stg_customer",
      model: "warehouse",
      target: "dim_customer",
      sources: [{ alias: "r", ref: "dim_customer" }],
      columnMappings: [
        {
          target: "email_address",
          sources: ["r.email_address"],
          expression: "LOWER(TRIM(r.email_address))",
          rule: "Email addresses are lower-cased so they compare reliably.",
        },
      ],
    }),
  );

  return graph;
}

describe("search", () => {
  it("says nothing for a one-character query", () => {
    // A single character matches most of a real model, which is not an answer.
    expect(search(fixture(), "e").hits).toEqual([]);
  });

  it("finds the table that holds a column", () => {
    const result = search(fixture(), "email");
    const field = result.hits.find((hit) => hit.kind === "field");

    // The question a name-only search cannot answer at all.
    expect(field?.label).toBe("dim_customer.email_address");
    expect(field?.path).toBe("email_address");
  });

  it("finds a nested STRUCT field by its dotted path", () => {
    const result = search(fixture(), "postcode");
    expect(result.hits.find((hit) => hit.kind === "field")?.label).toBe("dim_customer.address.postcode");
  });

  it("finds a glossary definition, not just its term", () => {
    const result = search(fixture(), "issuing bank");
    const hit = result.hits.find((candidate) => candidate.kind === "glossary");

    expect(hit?.objectName).toBe("Chargeback");
    expect(hit?.excerpt).toContain("issuing bank");
  });

  it("finds a mapping's business rule", () => {
    const result = search(fixture(), "lower-cased");
    const hit = result.hits[0];

    /*
      This text lives on a `columnMapping.rule`, not on any object or column description. It
      was invisible to search until the mapping facet existed, which meant the model held the
      answer and the tool could not reach it.
    */
    expect(hit?.kind).toBe("description");
    expect(hit?.meta).toBe("mapping rule");
    expect(hit?.excerpt).toContain("lower-cased");
  });

  it("finds a column description", () => {
    const result = search(fixture(), "Royal Mail");
    expect(result.hits[0]?.excerpt).toContain("Royal Mail");
  });

  it("ranks a word-boundary match above a match inside a word", () => {
    const result = search(fixture(), "order");
    const labels = result.hits.filter((hit) => hit.kind === "field").map((hit) => hit.label);

    // `order_total` starts with the word; `reorder_flag` merely contains it. Without the
    // boundary rule these come back in file order and the better match sits underneath.
    expect(labels.indexOf("dim_customer.order_total")).toBeLessThan(
      labels.indexOf("dim_customer.reorder_flag"),
    );
  });

  it("counts each facet separately", () => {
    const result = search(fixture(), "customer");

    expect(result.counts.object).toBeGreaterThan(0);
    expect(result.counts.description).toBeGreaterThan(0);
  });

  it("reports a name hit and a description hit on the same object as two answers", () => {
    const result = search(fixture(), "customer");
    const forTable = result.hits.filter((hit) => hit.objectId === "tbl_c");

    /*
      "The table is called this" and "the table is *about* this" are different answers.
      Deduplicating by object would hide the second whenever the first also matched.
    */
    expect(forTable.some((hit) => hit.kind === "object")).toBe(true);
    expect(forTable.some((hit) => hit.kind === "description")).toBe(true);
  });

  it("carries the owning model so a hit can be navigated to", () => {
    const result = search(fixture(), "email");
    expect(result.hits.find((hit) => hit.kind === "field")?.model).toBe("warehouse");
  });

  it("reports truncation rather than silently dropping results", () => {
    const graph = fixture();
    for (let index = 0; index < 30; index += 1) {
      graph.add(
        obj({
          id: `tbl_extra_${index}`,
          kind: "table",
          name: `email_table_${index}`,
          model: "warehouse",
          columns: [{ id: `x${index}`, name: "email_address", dataType: "STRING" }],
        }),
      );
    }

    const result = search(graph, "email", 5);
    expect(result.hits).toHaveLength(5);
    // A capped list presented as complete is how someone concludes a column is not used
    // anywhere.
    expect(result.truncated).toBe(true);
  });

  it("is case insensitive", () => {
    expect(search(fixture(), "EMAIL").hits.length).toBeGreaterThan(0);
  });

  it("treats regex metacharacters in a query as literal text", () => {
    // `.` and `(` are ordinary characters to someone searching for `LOWER(TRIM`. An unescaped
    // query compiled into a RegExp would throw and take the whole palette down with it.
    expect(() => search(fixture(), "LOWER(TRIM")).not.toThrow();
    expect(search(fixture(), "LOWER(TRIM").hits.length).toBeGreaterThan(0);
  });
});
