import { describe, expect, it } from "vitest";
import { ObjectGraph } from "./graph.js";
import { parseObject, type AnyObject } from "./object.js";

/** Parse a raw object literal the way the loader would, failing loudly if invalid. */
function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function graphOf(...inputs: Record<string, unknown>[]): ObjectGraph {
  return ObjectGraph.from(inputs.map((i) => ({ object: obj(i) })));
}

const coreLogical = { id: "mdl_core", kind: "model", name: "core", tier: "logical" };
const corePhysical = {
  id: "mdl_wh",
  kind: "model",
  name: "warehouse",
  tier: "physical",
  target: { project: "acme", dataset: "core" },
};

describe("ObjectGraph.resolve", () => {
  it("resolves an unqualified name within the same model", () => {
    const graph = graphOf(coreLogical, {
      id: "ent_1",
      kind: "entity",
      name: "Customer",
      model: "core",
    });
    const resolved = graph.resolve("Customer", { model: "core" });
    expect(resolved?.target.object.id).toBe("ent_1");
    expect(resolved?.memberPath).toBeUndefined();
  });

  it("resolves a model-qualified name", () => {
    const graph = graphOf(
      coreLogical,
      corePhysical,
      { id: "ent_1", kind: "entity", name: "Customer", model: "core" },
      { id: "tbl_1", kind: "table", name: "Customer", model: "warehouse" },
    );
    expect(graph.resolve("core:Customer")?.target.object.id).toBe("ent_1");
    expect(graph.resolve("warehouse:Customer")?.target.object.id).toBe("tbl_1");
  });

  it("splits a trailing member path off the object name", () => {
    const graph = graphOf(coreLogical, {
      id: "ent_1",
      kind: "entity",
      name: "Customer",
      model: "core",
      attributes: [{ id: "att_1", name: "customer_id", logicalType: "string", required: true }],
      primaryKey: ["customer_id"],
    });
    const resolved = graph.resolve("Customer.customer_id", { model: "core" });
    expect(resolved?.target.object.id).toBe("ent_1");
    expect(resolved?.memberPath).toBe("customer_id");
    expect(graph.resolveAttribute("Customer.customer_id", { model: "core" })?.id).toBe("att_1");
  });

  it("prefers the longest name match, so dataset-qualified tables beat member access", () => {
    // `analytics.dim_customer` is shaped exactly like a member access. The table
    // name must win, because that is what the user meant.
    const graph = graphOf(corePhysical, {
      id: "tbl_1",
      kind: "table",
      name: "analytics.dim_customer",
      model: "warehouse",
      columns: [{ id: "col_1", name: "customer_key", dataType: "INT64" }],
    });
    const resolved = graph.resolve("analytics.dim_customer", { model: "warehouse" });
    expect(resolved?.target.object.id).toBe("tbl_1");
    expect(resolved?.memberPath).toBeUndefined();
  });

  it("resolves nested columns through a dotted member path", () => {
    const graph = graphOf(corePhysical, {
      id: "tbl_1",
      kind: "table",
      name: "orders",
      model: "warehouse",
      columns: [
        {
          id: "col_1",
          name: "address",
          dataType: "STRUCT",
          fields: [{ id: "col_2", name: "postcode", dataType: "STRING" }],
        },
      ],
    });
    expect(graph.resolveColumn("orders.address.postcode", { model: "warehouse" })?.id).toBe("col_2");
  });

  it("falls back to a previous name and flags the reference as stale", () => {
    const graph = graphOf(coreLogical, {
      id: "ent_1",
      kind: "entity",
      name: "Party",
      model: "core",
      previousNames: ["Customer"],
    });
    const resolved = graph.resolve("Customer", { model: "core" });
    expect(resolved?.target.object.id).toBe("ent_1");
    expect(resolved?.viaPreviousName).toBe(true);
  });

  it("finds workspace-scoped objects without a model qualifier", () => {
    const graph = graphOf(coreLogical, {
      id: "dom_1",
      kind: "domain",
      name: "money",
      logicalType: "decimal",
    });
    expect(graph.resolve("money", { model: "core" })?.target.object.id).toBe("dom_1");
  });

  it("resolves a shareable object that opted into a model, both ways", () => {
    // A team may keep its glossary with the conceptual model instead of sharing it
    // workspace-wide. Both the qualified and the bare reference must work.
    const graph = graphOf(coreLogical, {
      id: "term_1",
      kind: "glossaryTerm",
      name: "Customer",
      model: "core",
      definition: "Someone who buys things.",
    });
    expect(graph.resolve("core:Customer")?.target.object.id).toBe("term_1");
    expect(graph.resolve("Customer")?.target.object.id).toBe("term_1");
    expect(graph.resolve("Customer", { model: "core" })?.target.object.id).toBe("term_1");
  });

  it("returns undefined rather than guessing when nothing matches", () => {
    const graph = graphOf(coreLogical);
    expect(graph.resolve("Nope", { model: "core" })).toBeUndefined();
    expect(graph.resolve("   ")).toBeUndefined();
  });

  it("reports objects that name a model which does not exist", () => {
    const graph = graphOf(coreLogical, {
      id: "ent_1",
      kind: "entity",
      name: "Customer",
      model: "does_not_exist",
    });
    expect(graph.orphans().map((o) => o.object.id)).toEqual(["ent_1"]);
  });
});

describe("ObjectGraph indexing", () => {
  it("reports the tier of an object via its model", () => {
    const graph = graphOf(coreLogical, { id: "ent_1", kind: "entity", name: "Customer", model: "core" });
    expect(graph.tierOf(obj({ id: "ent_1", kind: "entity", name: "Customer", model: "core" }))).toBe("logical");
  });

  it("lists members of a model without including the model object", () => {
    const graph = graphOf(
      coreLogical,
      { id: "ent_1", kind: "entity", name: "Customer", model: "core" },
      { id: "ent_2", kind: "entity", name: "Order", model: "core" },
    );
    expect(graph.inModel("core").map((e) => e.object.id).sort()).toEqual(["ent_1", "ent_2"]);
  });
});
