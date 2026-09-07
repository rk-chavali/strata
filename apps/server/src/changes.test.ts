import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ObjectGraph, parseObject } from "@strata/metamodel";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { collectGovernance, mermaidErd, type ChangedObject } from "./changes.js";

/**
 * The two parts of the review comment that are computed rather than copied.
 *
 * Run against `examples/quickstart` rather than a hand-written fixture, deliberately. The
 * interesting failures in both functions are about *resolution*, a relationship end naming an
 * object by name instead of id, a classification inherited through a domain rather than set on
 * the column, and a fixture written to match the code would express whatever misunderstanding
 * the code already has. The example workspace is shipped in the image and checked by CI, so it
 * is the closest thing to a real customer repository this suite can reach.
 */

const QUICKSTART = join(import.meta.dirname, "..", "..", "..", "examples", "quickstart");

let workspace: LoadedWorkspace;

beforeAll(async () => {
  workspace = await loadWorkspace(QUICKSTART);
});

/** The changed-object record the summary builder would produce for a named object. */
function changed(name: string, change: ChangedObject["change"] = "modified"): ChangedObject {
  const found = workspace.graph.all().find((entry) => entry.object.name === name);
  if (!found) throw new Error(`the quickstart example has no object named ${name}`);

  return {
    id: found.object.id,
    name: found.object.name,
    kind: found.object.kind,
    ...((found.object as { model?: string }).model ? { model: (found.object as { model?: string }).model! } : {}),
    change,
    path: workspace.pathById.get(found.object.id) ?? "unknown.yaml",
  };
}

describe("mermaidErd", () => {
  it("draws a box per changed table, with primary keys marked", () => {
    const erd = mermaidErd(workspace.graph, [changed("dim_customer")]);

    expect(erd).toContain("erDiagram");
    expect(erd).toContain("dim_customer {");
    expect(erd).toContain("STRING customer_id PK");
  });

  it("draws the relationship between two changed tables", () => {
    /*
      The regression this catches is the one that actually happened while writing it: a
      relationship end holds `dim_customer`, a *name*, and looking it up by id returns nothing.
      The diagram then renders boxes with no lines, which reads as "this model has no
      relationships" rather than as a bug, so nothing would ever have reported it.
    */
    const erd = mermaidErd(workspace.graph, [changed("dim_customer"), changed("fct_order")]);

    expect(erd).toMatch(/dim_customer \|\|--o\{ fct_order/);
  });

  it("omits a relationship when only one of its ends is in the diagram", () => {
    // Otherwise mermaid invents a box for the absent end and the table cap stops meaning anything.
    const erd = mermaidErd(workspace.graph, [changed("dim_customer")]);
    expect(erd).not.toContain("fct_order");
  });

  it("reduces a parameterised type to something mermaid can parse", () => {
    /*
      Synthetic rather than from the example, because the example happens to use only simple
      types today and a test that depends on that passes vacuously the moment someone simplifies
      it further. These are the shapes that actually break: `NUMERIC(18, 2)` and `ARRAY<INT64>`
      each end the attribute token early, and an unparseable line fails the whole mermaid block,
      which GitHub then renders as a wall of raw text.
    */
    // Through `parseObject` rather than a cast, so the object carries the same schema defaults a
    // real one loaded from YAML would. A hand-built literal is missing them and crashes the graph.
    const parsed = parseObject({
      id: "tbl_awkward",
      kind: "table",
      name: "fct_awkward",
      model: "synthetic",
      objectType: "table",
      primaryKey: ["id"],
      columns: [
        { id: "c1", name: "id", dataType: "STRING", mode: "REQUIRED" },
        { id: "c2", name: "amount", dataType: "NUMERIC(18, 2)", mode: "NULLABLE" },
        { id: "c3", name: "tags", dataType: "ARRAY<INT64>", mode: "REPEATED" },
        { id: "c4", name: "address", dataType: "STRUCT<line1 STRING>", mode: "NULLABLE" },
      ],
    });
    if (!parsed.object) throw new Error(`fixture did not parse: ${JSON.stringify(parsed.issues)}`);

    const graph = new ObjectGraph();
    graph.add(parsed.object);

    const erd =
      mermaidErd(graph, [
        { id: "tbl_awkward", name: "fct_awkward", kind: "table", model: "synthetic", change: "modified", path: "a.yaml" },
      ]) ?? "";

    expect(erd).toContain("NUMERIC amount");
    expect(erd).toContain("ARRAY tags");
    expect(erd).toContain("STRUCT address");

    // Every attribute line must lead with a bare word, or the block does not parse.
    for (const line of erd.split("\n").filter((text: string) => /^ {4}\w/.test(text))) {
      expect(line.trim().split(/\s+/)[0], `type token in: ${line}`).toMatch(/^\w+$/);
    }
  });

  it("returns nothing when the change touched no tables", () => {
    expect(mermaidErd(workspace.graph, [])).toBeUndefined();
    expect(mermaidErd(workspace.graph, [changed("Customer")])).toBeUndefined();
  });

  it("ignores a removed table, which has no shape left to draw", () => {
    expect(mermaidErd(workspace.graph, [changed("dim_customer", "removed")])).toBeUndefined();
  });
});

describe("collectGovernance", () => {
  it("reports coverage for the model a changed object belongs to", () => {
    const [entry, ...rest] = collectGovernance(workspace.graph, [changed("dim_customer")]);

    expect(rest).toHaveLength(0);
    expect(entry?.model).toBe("shop_warehouse");
    expect(entry?.total).toBeGreaterThan(0);
    // dim_customer.email_address carries a pii classification, so this cannot be zero.
    expect(entry?.classified).toBeGreaterThan(0);
  });

  it("reports each affected model once, however many of its objects changed", () => {
    const entries = collectGovernance(workspace.graph, [
      changed("dim_customer"),
      changed("fct_order"),
    ]);

    expect(entries.map((entry: { model: string }) => entry.model)).toEqual(["shop_warehouse"]);
  });

  it("omits a model with no columns rather than reporting it as 0%", () => {
    // A conceptual model has concepts, not columns. 0 of 0 renders as a meaningless 0%.
    expect(collectGovernance(workspace.graph, [changed("Customer")])).toEqual([]);
  });
});
