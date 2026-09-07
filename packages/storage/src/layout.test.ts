import { describe, expect, it } from "vitest";
import { parseObject, type AnyObject } from "@strata/metamodel";
import { LayoutConfigSchema, PRESET_TEMPLATES, type LayoutPreset } from "./config.js";
import { LayoutEngine, pluralKind, renderTemplate, slugify } from "./layout.js";

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function engineFor(preset: LayoutPreset, overrides: Record<string, string> = {}): LayoutEngine {
  return new LayoutEngine(LayoutConfigSchema.parse({ preset, templates: overrides }));
}

const table = obj({
  id: "tbl_1",
  kind: "table",
  name: "dim_customer",
  model: "warehouse",
  layer: "mart",
  columns: [{ id: "c1", name: "id", dataType: "INT64" }],
});

const entity = obj({ id: "ent_1", kind: "entity", name: "Customer Account", model: "core" });
const domain = obj({ id: "dom_1", kind: "domain", name: "money", logicalType: "decimal" });
const diagram = obj({ id: "dgm_1", kind: "diagram", name: "Sales Overview", model: "core" });

describe("renderTemplate", () => {
  it("substitutes variables", () => {
    expect(renderTemplate("models/{model}/{name}.yaml", { model: "core", name: "customer" })).toBe(
      "models/core/customer.yaml",
    );
  });

  it("collapses a path segment whose variable is empty", () => {
    // A table with no layer must not produce `models/core//dim.yaml`.
    expect(renderTemplate("models/{model}/{layer}/{name}.yaml", { model: "core", layer: "", name: "dim" })).toBe(
      "models/core/dim.yaml",
    );
  });

  it("tidies separators orphaned by an empty variable", () => {
    expect(renderTemplate("models/{model}_{layer}/{name}.yaml", { model: "core", layer: "", name: "dim" })).toBe(
      "models/core/dim.yaml",
    );
  });

  it("never leaves a file with no name", () => {
    expect(renderTemplate("models/{model}/{name}.yaml", { model: "core", name: "", id: "tbl_9" })).toBe(
      "models/core/tbl_9.yaml",
    );
  });

  it("ignores unknown variables rather than leaving braces in a path", () => {
    expect(renderTemplate("models/{nope}/{name}.yaml", { name: "x" })).toBe("models/x.yaml");
  });
});

describe("slugify", () => {
  it("snake-cases by default", () => {
    expect(slugify("Customer Account", "snake")).toBe("customer_account");
    expect(slugify("dimCustomer", "snake")).toBe("dim_customer");
  });

  it("kebab-cases when asked", () => {
    expect(slugify("Customer Account", "kebab")).toBe("customer-account");
  });

  it("neutralises characters that would change the path shape", () => {
    // A physical table may legitimately be named `analytics.dim_customer`; the dot
    // must not become a directory boundary.
    expect(slugify("analytics.dim_customer", "snake")).toBe("analytics_dim_customer");
    expect(slugify("a/b", "snake")).toBe("a_b");
    expect(slugify("a:b", "preserve")).toBe("a_b");
  });
});

describe("pluralKind", () => {
  it("handles irregular plurals", () => {
    expect(pluralKind("entity")).toBe("entities");
    expect(pluralKind("glossaryTerm")).toBe("glossary");
    expect(pluralKind("subjectArea")).toBe("subject_areas");
  });

  it("adds a trailing s to regular kinds, snake-cased", () => {
    expect(pluralKind("table")).toBe("tables");
    expect(pluralKind("namingStandard")).toBe("naming_standards");
  });
});

describe("LayoutEngine presets", () => {
  it("groups by model and kind by default", () => {
    expect(engineFor("by-model-and-kind").pathFor(table, { layer: "mart" })).toBe(
      "models/warehouse/tables/dim_customer.yaml",
    );
    expect(engineFor("by-model-and-kind").pathFor(entity)).toBe("models/core/entities/customer_account.yaml");
  });

  it("flattens everything into one directory", () => {
    expect(engineFor("flat").pathFor(table)).toBe("models/dim_customer.yaml");
  });

  it("groups by warehouse layer", () => {
    expect(engineFor("by-layer").pathFor(table, { layer: "mart" })).toBe(
      "models/warehouse/mart/tables/dim_customer.yaml",
    );
  });

  it("groups by subject area, falling back gracefully when there is none", () => {
    const engine = engineFor("by-subject-area");
    expect(engine.pathFor(entity, { subjectArea: "Sales" })).toBe("models/core/sales/customer_account.yaml");
    expect(engine.pathFor(entity)).toBe("models/core/customer_account.yaml");
  });

  it("puts every object of a model in one file for single-file-per-model", () => {
    expect(engineFor("single-file-per-model").pathFor(table)).toBe("models/warehouse.yaml");
    expect(engineFor("single-file-per-model").pathFor(entity)).toBe("models/core.yaml");
  });

  it("routes workspace-scoped objects to the shared template", () => {
    expect(engineFor("by-model-and-kind").pathFor(domain)).toBe("shared/domains/money.yaml");
  });

  it("always gives a diagram its own file, distinct from any semantic object", () => {
    /*
     * The invariant is that dragging a box can never show up in a semantic diff, which
     * requires diagrams to be *separate files*, not to sit under a particular root.
     *
     * `by-namespace` deliberately nests diagrams inside the domain folder
     * (models/retail/physical/diagrams/…) so that one CODEOWNERS line can own everything
     * a domain team is responsible for. That is a better trade than keeping diagrams in
     * a sibling tree, and it does not weaken the invariant.
     */
    for (const preset of Object.keys(PRESET_TEMPLATES) as Exclude<LayoutPreset, "custom">[]) {
      const engine = engineFor(preset);
      const diagramPath = engine.pathFor(diagram);

      expect(diagramPath, `preset ${preset}`).toMatch(/diagram/);
      // Never collides with a semantic object, whatever the preset.
      expect(diagramPath).not.toBe(engine.pathFor(entity, { subjectArea: "Sales" }));
      expect(diagramPath).not.toBe(engine.pathFor(table, { layer: "mart" }));
      expect(diagramPath).not.toBe(engine.pathFor(domain));
    }
  });

  it("groups a whole domain under one folder for by-namespace", () => {
    // One folder per business domain is what makes an ownership rule in CODEOWNERS a
    // single line rather than an enumeration of every model.
    const engine = engineFor("by-namespace");
    const context = { namespace: "retail" };

    expect(engine.pathFor(table, { ...context, tier: "physical", layer: "mart" })).toBe(
      "models/retail/physical/tables/dim_customer.yaml",
    );
    expect(engine.pathFor(entity, { ...context, tier: "logical" })).toBe(
      "models/retail/logical/entities/customer_account.yaml",
    );
    expect(engine.pathFor(diagram, { ...context, tier: "logical" })).toBe(
      "models/retail/logical/diagrams/sales_overview.diagram.yaml",
    );
  });

  it("gives the model object a home that is not models/<model>/models/", () => {
    const model = obj({ id: "mdl_1", kind: "model", name: "warehouse", tier: "physical" });
    expect(engineFor("by-model-and-kind").pathFor(model)).toBe("models/warehouse/model.yaml");
    expect(engineFor("by-kind").pathFor(model)).toBe("models/warehouse.yaml");
    expect(engineFor("by-layer").pathFor(model)).toBe("models/warehouse/model.yaml");
    expect(engineFor("single-file-per-model").pathFor(model)).toBe("models/warehouse.yaml");
  });

  it("lets a per-kind override beat the preset", () => {
    const engine = engineFor("by-model-and-kind", { table: "warehouse/{layer}/{name}.yaml" });
    expect(engine.pathFor(table, { layer: "mart" })).toBe("warehouse/mart/dim_customer.yaml");
    // Other kinds still follow the preset.
    expect(engine.pathFor(entity)).toBe("models/core/entities/customer_account.yaml");
  });
});
