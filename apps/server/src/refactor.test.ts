import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import {
  renameModel,
  renameNamespace,
  setModelNamespace,
  updateModelSettings,
} from "./refactor.js";

/**
 * Rename is tested against real files, because moving files is what it does.
 *
 * The interesting failures of this module are all filesystem failures, the old directory
 * left behind, the child written to the new path while its `model:` field still names the
 * old one, the config not following. A fixture in memory would exercise none of that; it
 * would assert that the plan looks right, which is the same assumption the implementation
 * already makes.
 *
 * The fixture is deliberately the awkward shape rather than the easy one: two tiers, a
 * `derivedFrom` chain, a qualified cross-model reference, and a `dataform` block in the
 * config naming a model. Each of those is a place a rename can leak.
 */

let root: string;

const CONFIG = `version: 1
name: test-models

# A comment, which must survive a rename that edits this file.
roots:
  - "."

layout:
  preset: by-model-and-kind
  slugStyle: snake

dataform:
  - name: analytics
    models:
      - warehouse
`;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-refactor-"));
  await write("strata.config.yaml", CONFIG);

  await write(
    "models/core/model.yaml",
    `id: model_core
kind: model
name: core
tier: logical
namespace: sales
`,
  );

  await write(
    "models/core/entities/customer.yaml",
    `id: entity_customer
kind: entity
name: Customer
model: core
attributes:
  - id: attr_customer_id
    name: customer_id
    logicalType: string
primaryKey:
  - customer_id
`,
  );

  await write(
    "models/warehouse/model.yaml",
    `id: model_warehouse
kind: model
name: warehouse
tier: physical
namespace: sales
derivedFrom: core
`,
  );

  // The cross-model reference: qualified with the logical model's name.
  await write(
    "models/warehouse/tables/dim_customer.yaml",
    `id: table_dim_customer
kind: table
name: dim_customer
model: warehouse
entityRef: core:Customer
columns:
  - id: col_customer_key
    name: customer_key
    dataType: STRING
    attributeRef: core:Customer.customer_id
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function read(relative: string): Promise<string> {
  return readFile(join(root, relative), "utf8");
}

describe("renameModel", () => {
  it("moves the model's own file and leaves nothing at the old path", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    expect(existsSync(join(root, "models/core_logical/model.yaml"))).toBe(true);
    expect(existsSync(join(root, "models/core/model.yaml"))).toBe(false);
  });

  it("moves every object that belongs to the model, not just the model object", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    /**
     * The failure this guards against is the subtle one. Writing only the renamed model
     * object leaves `models/core/entities/customer.yaml` exactly where it was, with a
     * `model: core` field naming something that no longer exists, an orphan, which
     * `ObjectGraph.orphans()` reports but nothing prevents.
     */
    expect(existsSync(join(root, "models/core_logical/entities/customer.yaml"))).toBe(true);
    expect(existsSync(join(root, "models/core/entities/customer.yaml"))).toBe(false);
    expect(await read("models/core_logical/entities/customer.yaml")).toContain("model: core_logical");
  });

  it("prunes the emptied directory rather than leaving a husk", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");
    expect(existsSync(join(root, "models/core"))).toBe(false);
  });

  it("records the old name so references in commits we do not control still resolve", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");
    expect(await read("models/core_logical/model.yaml")).toContain("- core");
  });

  it("follows the name into another model's derivedFrom", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    /**
     * `derivedFrom` on a model holds a *bare* model name, so the qualifier rewrite, which
     * only fires on a `name:` prefix, cannot reach it. It has to be named explicitly, and
     * this is the test that says so.
     */
    expect(await read("models/warehouse/model.yaml")).toContain("derivedFrom: core_logical");
  });

  it("requalifies cross-model references", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    const table = await read("models/warehouse/tables/dim_customer.yaml");
    expect(table).toContain("entityRef: core_logical:Customer");
    expect(table).toContain("attributeRef: core_logical:Customer.customer_id");
    expect(table).not.toContain("core:Customer");
  });

  it("leaves the renamed model loadable with no diagnostics", async () => {
    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    /**
     * The real acceptance test. Every assertion above checks one symptom; this one checks
     * the property that actually matters, that after the rename the repo still parses,
     * still resolves, and reports nothing wrong.
     */
    const reloaded = await loadWorkspace(root);
    expect(reloaded.diagnostics).toEqual([]);
    expect(reloaded.graph.orphans()).toEqual([]);
    expect(reloaded.graph.modelNamed("core_logical")).toBeDefined();
    expect(reloaded.graph.modelNamed("core")).toBeUndefined();
  });

  it("updates strata.config.yaml and keeps its comments", async () => {
    const workspace = await loadWorkspace(root);
    const result = await renameModel(workspace, "model_warehouse", "mart");

    const config = await read("strata.config.yaml");
    expect(config).toContain("- mart");
    expect(config).not.toContain("- warehouse");
    expect(config).toContain("# A comment, which must survive a rename that edits this file.");
    expect(result.configChanged).toBe(true);
  });

  it("leaves the config alone when no connection names the model", async () => {
    const workspace = await loadWorkspace(root);
    const before = await read("strata.config.yaml");
    const result = await renameModel(workspace, "model_core", "core_logical");

    expect(result.configChanged).toBe(false);
    expect(await read("strata.config.yaml")).toBe(before);
  });

  it("does not touch files belonging to models it was not asked about", async () => {
    /**
     * Scope. `planWrites` plans the whole repo, so applying it wholesale would relocate
     * any file sitting outside its canonical position for unrelated reasons, turning
     * "rename a model" into "reorganise the repository" and burying the rename in a diff
     * nobody can review. This file is deliberately in the wrong place and must stay there.
     */
    await write(
      "somewhere/odd/note.yaml",
      `id: term_sku
kind: glossaryTerm
name: SKU
definition: Stock keeping unit.
`,
    );

    const workspace = await loadWorkspace(root);
    await renameModel(workspace, "model_core", "core_logical");

    expect(existsSync(join(root, "somewhere/odd/note.yaml"))).toBe(true);
  });

  it("refuses a name another model already has", async () => {
    const workspace = await loadWorkspace(root);
    await expect(renameModel(workspace, "model_core", "warehouse")).rejects.toThrow(/already exists/);
  });

  it("refuses an empty name", async () => {
    const workspace = await loadWorkspace(root);
    await expect(renameModel(workspace, "model_core", "   ")).rejects.toThrow(/needs a name/);
  });

  it("is a no-op when the name is unchanged", async () => {
    const workspace = await loadWorkspace(root);
    const result = await renameModel(workspace, "model_core", "core");
    expect(result.objectsChanged).toBe(0);
    expect(result.written).toEqual([]);
  });

  it("rejects an id that is not a model", async () => {
    const workspace = await loadWorkspace(root);
    await expect(renameModel(workspace, "entity_customer", "Client")).rejects.toThrow(/no model/);
  });
});

describe("setModelNamespace", () => {
  it("changes the domain without moving files under a model-keyed layout", async () => {
    const workspace = await loadWorkspace(root);
    await setModelNamespace(workspace, "model_core", "retail");

    /**
     * `by-model-and-kind` does not mention `{namespace}`, so the domain is pure metadata
     * here and nothing should move. The same call under `by-namespace` moves every file in
     * the model, which is the case the next test covers.
     */
    expect(existsSync(join(root, "models/core/model.yaml"))).toBe(true);
    expect(await read("models/core/model.yaml")).toContain("namespace: retail");
  });

  it("moves every file when the layout is keyed on the domain", async () => {
    await write("strata.config.yaml", CONFIG.replace("by-model-and-kind", "by-namespace"));

    // Put the fixture where `by-namespace` expects it, so the move is the only change.
    const workspace = await loadWorkspace(root);
    await setModelNamespace(workspace, "model_core", "retail");

    const reloaded = await loadWorkspace(root);
    expect(reloaded.diagnostics).toEqual([]);
    expect(reloaded.graph.modelNamed("core")?.namespace).toBe("retail");

    // Its files now live under the new domain, and its entity came along.
    const paths = [...reloaded.pathById.values()];
    expect(paths.some((path) => path.includes("retail") && path.includes("customer"))).toBe(true);
  });

  it("clears the domain by removing the key, not by writing a null", async () => {
    const workspace = await loadWorkspace(root);
    await setModelNamespace(workspace, "model_core", "");

    const file = await read("models/core/model.yaml");
    expect(file).not.toContain("namespace");
    expect((await loadWorkspace(root)).graph.modelNamed("core")?.namespace).toBeUndefined();
  });

  it("is a no-op when the domain is unchanged", async () => {
    const workspace = await loadWorkspace(root);
    const result = await setModelNamespace(workspace, "model_core", "sales");
    expect(result.objectsChanged).toBe(0);
  });
});

describe("updateModelSettings", () => {
  it("renames and re-domains in a single pass", async () => {
    const workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", {
      name: "core_logical",
      namespace: "retail",
    });

    const reloaded = await loadWorkspace(root);
    const model = reloaded.graph.modelNamed("core_logical");
    expect(model?.namespace).toBe("retail");
    expect(reloaded.diagnostics).toEqual([]);
    expect(reloaded.graph.orphans()).toEqual([]);

    // And the rename still propagated, which is the thing composition could have lost.
    expect(await read("models/warehouse/model.yaml")).toContain("derivedFrom: core_logical");
  });

  it("writes tags sorted and de-duplicated", async () => {
    const workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", {
      tags: ["  gold ", "Curated", "gold", "", "audited"],
    });

    const model = (await loadWorkspace(root)).graph.modelNamed("core");
    expect(model?.tags).toEqual(["audited", "Curated", "gold"]);
  });

  it("removes a cleared description rather than writing an empty one", async () => {
    let workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", { description: "The logical layer." });
    expect(await read("models/core/model.yaml")).toContain("description: The logical layer.");

    workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", { description: "" });
    expect(await read("models/core/model.yaml")).not.toContain("description");
  });

  it("leaves fields the patch does not mention alone", async () => {
    let workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", {
      description: "Kept.",
      tags: ["gold"],
    });

    workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", { displayName: "Core (logical)" });

    const model = (await loadWorkspace(root)).graph.modelNamed("core");
    expect(model?.description).toBe("Kept.");
    expect(model?.tags).toEqual(["gold"]);
    expect(model?.displayName).toBe("Core (logical)");
  });

  it("refuses a lifecycle state that is not one", async () => {
    const workspace = await loadWorkspace(root);
    await expect(
      updateModelSettings(workspace, "model_core", {
        lifecycle: "nearly_done" as never,
      }),
    ).rejects.toThrow(/not a lifecycle state/);
  });

  it("refuses a name another model already has", async () => {
    const workspace = await loadWorkspace(root);
    await expect(
      updateModelSettings(workspace, "model_core", { name: "warehouse" }),
    ).rejects.toThrow(/already exists/);
  });

  it("allows a case-only rename of the model's own name", async () => {
    /**
     * `Core` is not taken by anything but `core` itself, so the clash check must exclude
     * the subject. A naive case-insensitive comparison against every model including this
     * one would make a capitalisation fix impossible.
     */
    const workspace = await loadWorkspace(root);
    await updateModelSettings(workspace, "model_core", { name: "Core" });
    expect((await loadWorkspace(root)).graph.modelNamed("Core")?.name).toBe("Core");
  });
});

describe("renameNamespace", () => {
  it("moves every model in the domain in one pass", async () => {
    const workspace = await loadWorkspace(root);
    const { models } = await renameNamespace(workspace, "sales", "retail");

    expect(models.sort()).toEqual(["core", "warehouse"]);

    const reloaded = await loadWorkspace(root);
    expect(reloaded.graph.modelNamed("core")?.namespace).toBe("retail");
    expect(reloaded.graph.modelNamed("warehouse")?.namespace).toBe("retail");
    expect(reloaded.diagnostics).toEqual([]);
  });

  it("reports a domain nobody is in rather than silently succeeding", async () => {
    const workspace = await loadWorkspace(root);
    await expect(renameNamespace(workspace, "finance", "retail")).rejects.toThrow(/no models/);
  });

  it("refuses an empty domain name", async () => {
    const workspace = await loadWorkspace(root);
    await expect(renameNamespace(workspace, "sales", "  ")).rejects.toThrow(/needs a name/);
  });
});
