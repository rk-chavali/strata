import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import { dictionaryView } from "@strata/query";
import { updateMember } from "./edit.js";

/**
 * The dictionary and the member patch, tested against real files.
 *
 * Lives with the server rather than with `@strata/query`, where `dictionaryView` now is, because it
 * tests the *round trip*: what the grid renders, and what `updateMember` writes back. Splitting
 * it along the package boundary would leave the interesting half, that the two agree, untested
 * on either side.
 *
 * Both exist to serve one screen, and the screen's whole promise is that what it shows is
 * what is on disk. So these tests read the YAML back rather than asserting on the returned
 * object: the interesting failures are all serialisation failures, an empty string written
 * where a key should have been deleted, a classification stub left behind after the last
 * category was unticked, a nested STRUCT field silently addressed as a top-level column.
 *
 * The fixture is deliberately awkward: a nested STRUCT, a classified domain that two
 * columns inherit from, a `REPEATED` column, and a column that is part of the primary key.
 * Each is a place the grid can lie.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function read(relative: string): Promise<string> {
  return readFile(join(root, relative), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-dictionary-"));

  await write(
    "strata.config.yaml",
    `version: 1
name: test-models
roots:
  - "."
layout:
  preset: by-model-and-kind
  slugStyle: snake
`,
  );

  await write(
    "models/warehouse/model.yaml",
    `id: model_warehouse
kind: model
name: warehouse
tier: physical
namespace: sales
`,
  );

  // A classified domain, so inheritance has something to inherit.
  await write(
    "shared/domains/email.yaml",
    `id: dom_email
kind: domain
name: email
logicalType: string
physicalType: STRING
classification:
  sensitivity: confidential
  categories:
    - pii
    - contact
`,
  );

  await write(
    "models/warehouse/tables/dim_customer.yaml",
    `id: table_dim_customer
kind: table
name: dim_customer
model: warehouse
dataset: sales_mart
layer: mart
columns:
  - id: col_key
    name: customer_key
    dataType: INT64
    mode: REQUIRED
  - id: col_email
    name: email_address
    dataType: STRING
    mode: NULLABLE
    domain: email
  - id: col_alt_email
    name: alt_email
    dataType: STRING
    mode: NULLABLE
    domain: email
  - id: col_tags
    name: labels
    dataType: STRING
    mode: REPEATED
  - id: col_address
    name: address
    dataType: STRUCT
    mode: NULLABLE
    fields:
      - id: col_postcode
        name: postcode
        dataType: STRING
        mode: NULLABLE
      - id: col_city
        name: city
        dataType: STRING
        mode: NULLABLE
primaryKey:
  - customer_key
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dictionaryView", () => {
  it("lists every column including nested STRUCT fields, depth-first", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    expect(view.rows.map((row) => row.path)).toEqual([
      "customer_key",
      "email_address",
      "alt_email",
      "labels",
      "address",
      // Depth-first: the STRUCT's fields follow it immediately rather than being appended
      // after every top-level column, which is what indentation alone could not rescue.
      "address.postcode",
      "address.city",
    ]);
  });

  it("reports the nesting depth so the client can indent without re-parsing paths", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    const postcode = view.rows.find((row) => row.path === "address.postcode");
    expect(postcode?.depth).toBe(1);
    expect(view.rows.find((row) => row.path === "address")?.depth).toBe(0);
  });

  it("marks only top-level columns as primary keys", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    expect(view.rows.find((row) => row.path === "customer_key")?.isPrimaryKey).toBe(true);
    // The guard that matters: a STRUCT field whose leaf name collides with a key column
    // must not be reported as a key.
    expect(view.rows.find((row) => row.path === "address.postcode")?.isPrimaryKey).toBe(false);
  });

  it("reads REQUIRED as required and REPEATED as not required", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    expect(view.rows.find((row) => row.path === "customer_key")?.required).toBe(true);
    expect(view.rows.find((row) => row.path === "labels")?.required).toBe(false);
  });

  it("reports classification inherited from a domain separately from classification set on the column", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");
    const email = view.rows.find((row) => row.path === "email_address");

    // Nothing is set on the column itself…
    expect(email?.sensitivity).toBeUndefined();
    expect(email?.categories).toEqual([]);

    // …but the domain lends it one, and the row says where from. Merging these into one
    // field is what would make the grid's editable cell silently write an override.
    expect(email?.inherited).toEqual({
      from: "email",
      sensitivity: "confidential",
      categories: ["pii", "contact"],
    });
  });

  it("counts inherited classification towards coverage", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    // `email_address` and `alt_email` are governed through the domain; nothing else is.
    // Without this, a model typed entirely through a governed library reports 0% and reads
    // as ungoverned.
    expect(view.classified).toBe(2);
    expect(view.total).toBe(7);
  });

  it("carries the closed vocabularies so the client never hardcodes them", async () => {
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "warehouse");

    expect(view.sensitivityLevels).toContain("confidential");
    expect(view.categories).toContain("pii");
  });

  it("returns no rows for a model with no tables or entities", async () => {
    await write(
      "models/empty/model.yaml",
      `id: model_empty
kind: model
name: empty
tier: physical
`,
    );
    const workspace = await loadWorkspace(root);
    const view = dictionaryView(workspace.graph, "empty");

    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
  });
});

describe("updateMember annotations", () => {
  it("writes a description to the addressed column", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "email_address",
      description: "Primary contact address.",
    });

    expect(await read("models/warehouse/tables/dim_customer.yaml")).toContain(
      "description: Primary contact address.",
    );
  });

  it("deletes the description key rather than writing an empty string", async () => {
    let workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "email_address",
      description: "Temporary.",
    });

    workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "email_address",
      description: null,
    });

    const yaml = await read("models/warehouse/tables/dim_customer.yaml");
    expect(yaml).not.toContain("Temporary.");
    // `description: ""` parses and means nothing, but it would show up in every diff.
    expect(yaml).not.toContain('description: ""');
  });

  it("addresses a nested STRUCT field by its dotted path", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "address.postcode",
      description: "Outward and inward code.",
    });

    const yaml = await read("models/warehouse/tables/dim_customer.yaml");
    const view = dictionaryView((await loadWorkspace(root)).graph, "warehouse");

    expect(view.rows.find((row) => row.path === "address.postcode")?.description).toBe(
      "Outward and inward code.",
    );
    // The sibling must be untouched, a resolver that matched on leaf name alone would
    // have written this onto `address` or onto `city`.
    expect(view.rows.find((row) => row.path === "address.city")?.description).toBeUndefined();
    expect(yaml).toContain("Outward and inward code.");
  });

  it("sets sensitivity and categories on the column itself, leaving the domain alone", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "alt_email",
      classification: { sensitivity: "restricted", categories: ["pii"] },
    });

    const view = dictionaryView((await loadWorkspace(root)).graph, "warehouse");
    const alt = view.rows.find((row) => row.path === "alt_email");

    expect(alt?.sensitivity).toBe("restricted");
    expect(alt?.categories).toEqual(["pii"]);
    // Overriding one column must not touch the shared domain, or every column typed
    // `email` would move with it.
    expect(await read("shared/domains/email.yaml")).toContain("sensitivity: confidential");
    expect(view.rows.find((row) => row.path === "email_address")?.sensitivity).toBeUndefined();
  });

  it("merges into an existing classification rather than replacing it", async () => {
    let workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "alt_email",
      classification: { categories: ["pii"] },
    });

    workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "alt_email",
      classification: { sensitivity: "restricted" },
    });

    const view = dictionaryView((await loadWorkspace(root)).graph, "warehouse");
    const alt = view.rows.find((row) => row.path === "alt_email");

    // Setting the sensitivity must not wipe the categories: the grid sends one cell at a
    // time, so a replace would make the second edit undo the first.
    expect(alt?.sensitivity).toBe("restricted");
    expect(alt?.categories).toEqual(["pii"]);
  });

  it("drops the classification entirely when the last value is cleared", async () => {
    let workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "alt_email",
      classification: { sensitivity: "restricted", categories: ["pii"] },
    });

    workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "alt_email",
      classification: { sensitivity: null, categories: [] },
    });

    const yaml = await read("models/warehouse/tables/dim_customer.yaml");
    const view = dictionaryView((await loadWorkspace(root)).graph, "warehouse");

    // An empty `classification: {}` parses, means nothing, and counts as "classified" in
    // the coverage report, quietly inflating the number that exists to show gaps.
    expect(yaml).not.toContain("classification:");
    expect(view.classified).toBe(2);
    expect(view.rows.find((row) => row.path === "alt_email")?.inherited?.sensitivity).toBe(
      "confidential",
    );
  });

  it("toggles requiredness between REQUIRED and NULLABLE", async () => {
    let workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", { path: "email_address", required: true });
    expect(dictionaryView((await loadWorkspace(root)).graph, "warehouse").rows.find((row) => row.path === "email_address")?.required).toBe(true);

    workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", { path: "email_address", required: false });
    expect(dictionaryView((await loadWorkspace(root)).graph, "warehouse").rows.find((row) => row.path === "email_address")?.required).toBe(false);
  });

  it("leaves a REPEATED column's mode alone", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", { path: "labels", required: true });

    // Mapping requiredness onto REPEATED would turn an array column into a scalar, a
    // silent, breaking schema change from a checkbox.
    expect(await read("models/warehouse/tables/dim_customer.yaml")).toContain("mode: REPEATED");
  });

  it("still renames and retypes, and keeps the primary key list in step", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "customer_key",
      name: "customer_sk",
      type: "STRING",
    });

    const yaml = await read("models/warehouse/tables/dim_customer.yaml");
    expect(yaml).toContain("name: customer_sk");
    expect(yaml).toContain("dataType: STRING");
    // The regression the grid could easily introduce: a rename that leaves `primaryKey`
    // pointing at a column that no longer exists.
    expect(yaml).toContain("- customer_sk");
    expect(yaml).not.toMatch(/- customer_key$/m);
  });

  it("leaves the model valid after an edit", async () => {
    const workspace = await loadWorkspace(root);
    await updateMember(workspace, "table_dim_customer", {
      path: "email_address",
      description: "Contact address.",
      classification: { sensitivity: "restricted", categories: ["pii"] },
      required: true,
    });

    // The acceptance test: reload from disk and assert the workspace still parses clean
    // with nothing orphaned. Anything the patch corrupted shows up here.
    const reloaded = await loadWorkspace(root);
    expect(reloaded.diagnostics).toEqual([]);
    expect(reloaded.graph.orphans()).toEqual([]);
  });
});
