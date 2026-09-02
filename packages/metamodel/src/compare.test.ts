import { describe, expect, it } from "vitest";
import { ObjectGraph } from "./graph.js";
import { compareModels, normaliseName } from "./compare.js";
import type { AnyObject } from "./object.js";

/**
 * Objects here are written raw rather than parsed, so schema defaults are missing.
 * `previousNames` is the one the graph indexes on, so it has to be supplied.
 */
function graphOf(...objects: Record<string, unknown>[]): ObjectGraph {
  const graph = new ObjectGraph();
  for (const object of objects) {
    graph.add({ previousNames: [], ...object } as unknown as AnyObject);
  }
  return graph;
}

const logicalModel = { id: "m_l", kind: "model", name: "retail_logical", tier: "logical" };
const physicalModel = { id: "m_p", kind: "model", name: "retail_warehouse", tier: "physical" };

const entity = (name: string, attributes: unknown[], extra: Record<string, unknown> = {}) => ({
  id: `e_${name}`,
  kind: "entity",
  name,
  model: "retail_logical",
  attributes,
  ...extra,
});

const table = (name: string, columns: unknown[], extra: Record<string, unknown> = {}) => ({
  id: `t_${name}`,
  kind: "table",
  name,
  model: "retail_warehouse",
  columns,
  ...extra,
});

describe("normaliseName", () => {
  it("reduces the three naming conventions to one key", () => {
    expect(normaliseName("Customer Order Line")).toBe("customerorderline");
    expect(normaliseName("customer_order_line")).toBe("customerorderline");
    expect(normaliseName("dim_customer")).toBe("customer");
    expect(normaliseName("fct_order")).toBe("order");
    expect(normaliseName("stg_order")).toBe("order");
  });

  it("expands the abbreviations every warehouse uses", () => {
    // Otherwise `Customer Identifier` vs `customer_id` reports as both missing and extra.
    expect(normaliseName("Customer Identifier")).toBe(normaliseName("customer_id"));
    expect(normaliseName("Order Number")).toBe(normaliseName("order_no"));
    expect(normaliseName("Line Amount")).toBe(normaliseName("line_amt"));
    expect(normaliseName("Product Description")).toBe(normaliseName("product_desc"));
  });

  it("splits camelCase, which erwin exports use", () => {
    expect(normaliseName("customerIdentifier")).toBe(normaliseName("customer_id"));
  });

  it("only strips known prefixes, so a real distinction survives", () => {
    // `customer_archive` is genuinely a different table from `Customer`.
    expect(normaliseName("customer_archive")).not.toBe(normaliseName("Customer"));
  });
});

describe("compareModels", () => {
  it("matches across naming conventions rather than reporting everything as missing", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "Customer ID" }]),
      table("dim_customer", [{ id: "c1", name: "customer_id", dataType: "INT64" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    expect(result.summary.matched).toBe(1);
    expect(result.summary.onlyInLeft).toBe(0);
    expect(result.pairs[0]?.matchedBy).toBe("normalisedName");
  });

  it("prefers an explicit trace reference over a name guess", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "id" }]),
      // Named to look like `Customer`, but the trace ref points elsewhere.
      table("dim_customer", [{ id: "c1", name: "id" }]),
      table("customer_current", [{ id: "c2", name: "id" }], { entityRef: "Customer" }),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    const pair = result.pairs.find((entry) => entry.left?.name === "Customer");
    expect(pair?.right?.name).toBe("customer_current");
    expect(pair?.matchedBy).toBe("reference");
  });

  it("reports an entity with no physical table", () => {
    const graph = graphOf(logicalModel, physicalModel, entity("Order", [{ id: "a1", name: "id" }]));
    const result = compareModels(graph, "retail_logical", "retail_warehouse");

    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({ kind: "onlyInLeft", object: "Order" });
  });

  it("reports a table that was never modelled", () => {
    const graph = graphOf(logicalModel, physicalModel, table("dim_junk", [{ id: "c1", name: "id" }]));
    const result = compareModels(graph, "retail_logical", "retail_warehouse");

    expect(result.summary.onlyInRight).toBe(1);
    expect(result.differences[0]?.message).toContain("only in retail_warehouse");
  });

  it("finds a column added straight to the warehouse, the classic drift", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "Email" }]),
      table("dim_customer", [
        { id: "c1", name: "email" },
        { id: "c2", name: "change_hash" },
      ]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    const drift = result.differences.find((d) => d.kind === "memberOnlyInRight");
    expect(drift?.member).toBe("change_hash");
  });

  it("finds an attribute that was never implemented", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [
        { id: "a1", name: "Email" },
        { id: "a2", name: "Loyalty Tier" },
      ]),
      table("dim_customer", [{ id: "c1", name: "email" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    const missing = result.differences.find((d) => d.kind === "memberOnlyInLeft");
    expect(missing?.member).toBe("Loyalty Tier");
  });

  it("does not report a type difference when only one side states a type", () => {
    // A logical attribute with no type and a typed column is not a conflict, and
    // reporting it would bury the real differences.
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "email" }]),
      table("dim_customer", [{ id: "c1", name: "email", dataType: "STRING" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    expect(result.differences.filter((d) => d.kind === "typeChanged")).toHaveLength(0);
  });

  it("reports a genuine type difference", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "spend", logicalType: "decimal" }]),
      table("dim_customer", [{ id: "c1", name: "spend", dataType: "STRING" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    const changed = result.differences.find((d) => d.kind === "typeChanged");
    expect(changed).toMatchObject({ member: "spend", left: "decimal", right: "STRING" });
  });

  it("reports a nullability difference", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "email", required: true }]),
      table("dim_customer", [{ id: "c1", name: "email", mode: "NULLABLE" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    expect(result.differences.find((d) => d.kind === "requiredChanged")).toMatchObject({
      left: "required",
      right: "optional",
    });
  });

  it("reports a primary key that differs between the tiers", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "customer_id" }], { primaryKey: ["customer_id"] }),
      table("dim_customer", [
        { id: "c1", name: "customer_id" },
        { id: "c2", name: "customer_key" },
      ], { primaryKey: ["customer_key"] }),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    expect(result.differences.some((d) => d.kind === "keyChanged")).toBe(true);
  });

  it("never matches one object twice", () => {
    // Two entities that normalise the same must not both claim the one table.
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "id" }]),
      entity("customer", [{ id: "a2", name: "id" }]),
      table("dim_customer", [{ id: "c1", name: "id" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    const matched = result.pairs.filter((pair) => pair.left && pair.right);
    expect(matched).toHaveLength(1);
    expect(result.summary.onlyInLeft).toBe(1);
  });

  it("compares two identical models as clean", () => {
    const graph = graphOf(
      logicalModel,
      physicalModel,
      entity("Customer", [{ id: "a1", name: "email", required: true }]),
      table("dim_customer", [{ id: "c1", name: "email", mode: "REQUIRED" }]),
    );

    const result = compareModels(graph, "retail_logical", "retail_warehouse");
    expect(result.differences).toEqual([]);
    expect(result.summary.matched).toBe(1);
  });
});
