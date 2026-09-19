import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject } from "@strata/metamodel";
import { parse } from "yaml";
import { generateOssie, ossieDatatype, UNASSIGNED_OWNER } from "./ossie.js";

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
  description: "The mart.",
  target: { project: "acme", dataset: "mart" },
};

const orders = {
  id: "tbl_orders",
  kind: "table",
  name: "fct_order",
  model: "warehouse",
  description: "Order header.",
  grain: "One row per order.",
  primaryKey: ["order_id"],
  columns: [
    { id: "c1", name: "order_id", dataType: "STRING", mode: "REQUIRED" },
    { id: "c2", name: "customer_id", dataType: "STRING", mode: "REQUIRED" },
    { id: "c3", name: "order_date", dataType: "DATE", mode: "REQUIRED" },
    { id: "c4", name: "order_total", dataType: "NUMERIC(18, 2)", mode: "REQUIRED" },
  ],
};

const customers = {
  id: "tbl_customers",
  kind: "table",
  name: "dim_customer",
  model: "warehouse",
  primaryKey: ["customer_id"],
  columns: [
    { id: "d1", name: "customer_id", dataType: "STRING", mode: "REQUIRED" },
    { id: "d2", name: "region", dataType: "STRING" },
  ],
};

const ordersToCustomer = {
  id: "rel_oc",
  kind: "relationship",
  name: "fct_order_dim_customer",
  model: "warehouse",
  tier: "physical",
  parent: { ref: "dim_customer", cardinality: "exactly-one", attributes: ["customer_id"] },
  child: { ref: "fct_order", cardinality: "zero-or-more", attributes: ["customer_id"] },
};

/** Parse the generated datasets file back into an object to assert on. */
function datasetsDoc(graph: ObjectGraph, modelName = "warehouse") {
  const { files } = generateOssie(graph, modelName);
  const file = files.find((f) => f.path.endsWith("datasets.generated.yaml"));
  if (!file) throw new Error("no datasets file was generated");
  return parse(file.contents) as {
    version: string;
    semantic_model: Array<{
      name: string;
      datasets: Array<Record<string, any>>;
      relationships?: Array<Record<string, any>>;
    }>;
  };
}

describe("ossieDatatype", () => {
  it("drops type parameters, because precision is a physical concern", () => {
    expect(ossieDatatype("NUMERIC(18, 2)")).toBe("Decimal");
    expect(ossieDatatype("STRING(50)")).toBe("String");
  });

  it("keeps TIMESTAMP and DATETIME distinct", () => {
    // BigQuery's TIMESTAMP is an absolute instant and DATETIME is a wall clock
    // with no zone. Collapsing them shifts a daily grain by hours.
    expect(ossieDatatype("TIMESTAMP")).toBe("DateTimeTz");
    expect(ossieDatatype("DATETIME")).toBe("DateTime");
  });

  it("maps every BigQuery integer spelling to Integer", () => {
    for (const t of ["INT64", "INTEGER", "INT", "SMALLINT", "BIGINT", "TINYINT", "BYTEINT"]) {
      expect(ossieDatatype(t)).toBe("Integer");
    }
  });

  it("falls back to Opaque for a type it cannot reason about", () => {
    // Readable as a dimension, refused as a measure, which is the safe default.
    for (const t of ["JSON", "GEOGRAPHY", "INTERVAL", "BYTES", "SOMETHING_NEW"]) {
      expect(ossieDatatype(t)).toBe("Opaque");
    }
  });
});

describe("generateOssie", () => {
  it("carries the primary key through, which is what the engine derives grain from", () => {
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    const fact = doc.semantic_model[0]!.datasets.find((d) => d.name === "fct_order")!;
    expect(fact.primary_key).toEqual(["order_id"]);
  });

  it("qualifies the source with the model's dataset", () => {
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    const fact = doc.semantic_model[0]!.datasets.find((d) => d.name === "fct_order")!;
    expect(fact.source).toBe("mart.fct_order");
  });

  it("writes the join from the many side to the one side", () => {
    // Ossie states a join as from/to and derives cardinality from whether `to`
    // is joined on its key. Strata's parent is the one side, so parent is `to`.
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    const rel = doc.semantic_model[0]!.relationships![0]!;
    expect(rel.from).toBe("fct_order");
    expect(rel.to).toBe("dim_customer");
    expect(rel.from_columns).toEqual(["customer_id"]);
    expect(rel.to_columns).toEqual(["customer_id"]);
  });

  it("marks groupable fields as dimensions", () => {
    // A field with no `dimension` block cannot be grouped by at all, so leaving
    // it off everything produces a model that validates and answers nothing.
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    const fact = doc.semantic_model[0]!.datasets.find((d) => d.name === "fct_order")!;
    const byName = new Map(fact.fields.map((f: any) => [f.name, f]));
    expect(byName.get("order_id")).toHaveProperty("dimension");
    expect(byName.get("order_date")).toHaveProperty("dimension");
    // Grouping by a money column yields one bucket per distinct price, which is
    // never a question anybody asked.
    expect(byName.get("order_total")).not.toHaveProperty("dimension");
  });

  it("does not repeat the grain when the description already states it", () => {
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    const fact = doc.semantic_model[0]!.datasets.find((d) => d.name === "fct_order")!;
    expect(fact.description).toBe("Order header. One row per order.");
  });

  it("generates no metrics, because what revenue means is not derivable from a schema", () => {
    const doc = datasetsDoc(graphOf(model, orders, customers, ordersToCustomer));
    expect(doc.semantic_model[0]).not.toHaveProperty("metrics");
  });

  it("refuses a model that is not physical", () => {
    const logical = { ...model, id: "mdl_l", name: "logical_model", tier: "logical" };
    expect(() => generateOssie(graphOf(logical), "logical_model")).toThrow(/physical/);
  });
});

describe("generateOssie warnings", () => {
  it("warns when a table has no primary key", () => {
    // Without one the engine cannot establish grain, so every join into the
    // table looks like it repeats rows and sums across it are refused.
    const noKey = { ...orders, id: "tbl_nokey", name: "fct_event", primaryKey: [] };
    const { warnings } = generateOssie(graphOf(model, noKey), "warehouse");
    expect(warnings.some((w) => /no primaryKey/.test(w.message))).toBe(true);
  });

  it("warns when declared cardinality disagrees with the key it joins on", () => {
    // This is the whole value of having both tools: Strata says one thing, the
    // engine derives another, and the modeller meets an unexplained refusal.
    const wrongKey = { ...customers, primaryKey: ["tenant_id", "customer_id"] };
    const { warnings } = generateOssie(graphOf(model, orders, wrongKey, ordersToCustomer), "warehouse");
    const found = warnings.find((w) => /exactly-one/.test(w.message));
    expect(found).toBeDefined();
    expect(found!.hint).toMatch(/refuse sums/);
  });

  it("stays quiet when cardinality and the primary key agree", () => {
    const { warnings } = generateOssie(graphOf(model, orders, customers, ordersToCustomer), "warehouse");
    expect(warnings.filter((w) => /cardinality|exactly-one/.test(w.message))).toHaveLength(0);
  });

  it("skips a REPEATED column and says so", () => {
    const withArray = {
      ...orders,
      id: "tbl_arr",
      name: "fct_arr",
      columns: [
        ...orders.columns,
        { id: "c9", name: "tags", dataType: "STRING", mode: "REPEATED" },
      ],
    };
    const { warnings } = generateOssie(graphOf(model, withArray), "warehouse");
    expect(warnings.some((w) => /REPEATED/.test(w.message))).toBe(true);

    const doc = datasetsDoc(graphOf(model, withArray));
    const names = doc.semantic_model[0]!.datasets[0]!.fields.map((f: any) => f.name);
    expect(names).not.toContain("tags");
  });

  it("flattens a STRUCT into one field per leaf", () => {
    const nested = {
      ...orders,
      id: "tbl_nested",
      name: "fct_nested",
      columns: [
        { id: "n0", name: "order_id", dataType: "STRING", mode: "REQUIRED" },
        {
          id: "n1",
          name: "shipping",
          dataType: "STRUCT",
          mode: "NULLABLE",
          fields: [{ id: "n2", name: "country", dataType: "STRING", mode: "NULLABLE" }],
        },
      ],
    };
    const doc = datasetsDoc(graphOf(model, nested));
    const field = doc.semantic_model[0]!.datasets[0]!.fields.find(
      (f: any) => f.name === "shipping_country",
    );
    expect(field).toBeDefined();
    // The expression keeps the dotted path, which is how BigQuery addresses it.
    expect(field.expression.dialects[0].expression).toBe("shipping.country");
  });
});

describe("the namespace manifest", () => {
  function manifestDoc(graph: ObjectGraph, options = {}) {
    const { files } = generateOssie(graph, "warehouse", options);
    const file = files.find((f) => f.path.endsWith("namespace.yaml"))!;
    return parse(file.contents) as Record<string, any>;
  }

  it("always names an owner, because a semantic workspace refuses a namespace without one", () => {
    const doc = manifestDoc(graphOf(model, orders));
    expect(doc.owners).toEqual([UNASSIGNED_OWNER]);
  });

  it("warns when it had to use the placeholder", () => {
    const { warnings } = generateOssie(graphOf(model, orders), "warehouse");
    expect(warnings.some((w) => w.message.includes(UNASSIGNED_OWNER))).toBe(true);
  });

  it("takes the owner from the Strata model when it has one", () => {
    const owned = { ...model, ownership: { owner: "@acme/sales-ops" } };
    const doc = manifestDoc(graphOf(owned, orders));
    expect(doc.owners).toEqual(["@acme/sales-ops"]);
  });

  it("exports nothing by default, so a team can restructure freely", () => {
    const doc = manifestDoc(graphOf(model, orders));
    expect(doc).not.toHaveProperty("exports");
  });
});
