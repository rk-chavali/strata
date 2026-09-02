import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject } from "@strata/metamodel";
import { generateDocs } from "./docs.js";

/**
 * The dictionary as a document.
 *
 * These tests care about two things a generator gets wrong quietly: **escaping**, because
 * descriptions are free text and a stray `<` or `|` silently eats the rest of a table; and
 * **reproducibility**, because a document that changes when the model did not is one people
 * stop reading the diff of.
 */

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

function fixture(): ObjectGraph {
  const graph = new ObjectGraph();

  graph.add(
    obj({
      id: "dom_email",
      kind: "domain",
      name: "email",
      logicalType: "string",
      classification: { sensitivity: "confidential", categories: ["pii"] },
    }),
  );

  graph.add(
    obj({
      id: "mdl_wh",
      kind: "model",
      name: "warehouse",
      tier: "physical",
      namespace: "sales",
      description: "The mart.",
      target: { project: "proj", dataset: "mart" },
    }),
  );

  graph.add(
    obj({
      id: "tbl_c",
      kind: "table",
      name: "dim_customer",
      model: "warehouse",
      dataset: "mart",
      layer: "mart",
      grain: "One row per customer per period of validity.",
      description: "Customers <b>and</b> their | history",
      columns: [
        { id: "c1", name: "customer_key", dataType: "INT64", mode: "REQUIRED" },
        { id: "c2", name: "email_address", dataType: "STRING", domain: "email" },
        {
          id: "c3",
          name: "address",
          dataType: "STRUCT",
          fields: [
            {
              id: "c4",
              name: "postcode",
              dataType: "STRING",
              // A pipe and an ampersand in one field description: the first breaks a markdown
              // table cell, the second breaks HTML.
              description: "Outward & inward | e.g. SW1A 1AA",
            },
          ],
        },
      ],
      primaryKey: ["customer_key"],
    }),
  );

  return graph;
}

describe("generateDocs markdown", () => {
  it("writes one file per model, named after it", () => {
    const files = generateDocs(fixture(), { format: "markdown" });
    expect(files.map((file) => file.path)).toEqual(["warehouse.md"]);
  });

  it("omits the index for a single model", () => {
    // An index linking to one page is noise, and one model is how most workspaces start.
    const files = generateDocs(fixture(), { format: "markdown" });
    expect(files.some((file) => file.path.startsWith("index"))).toBe(false);
  });

  it("writes an index once there is more than one model", () => {
    const graph = fixture();
    graph.add(obj({ id: "mdl_l", kind: "model", name: "logical", tier: "logical" }));

    const files = generateDocs(graph, { format: "markdown" });
    expect(files.some((file) => file.path === "index.md")).toBe(true);
  });

  it("includes the model's grain, dataset and layer", () => {
    const [file] = generateDocs(fixture(), { format: "markdown" });
    expect(file!.contents).toContain("One row per customer per period of validity.");
    expect(file!.contents).toContain("dataset `mart`");
  });

  it("escapes a pipe in a field description so the table survives it", () => {
    const [file] = generateDocs(fixture(), { format: "markdown" });

    // An unescaped `|` in a cell ends the cell early, shifting every column after it, the
    // table still renders, which is why this is easy to ship broken.
    expect(file!.contents).toContain(String.raw`Outward & inward \| e.g. SW1A 1AA`);
  });

  it("leaves a pipe alone in prose, where it is an ordinary character", () => {
    const [file] = generateDocs(fixture(), { format: "markdown" });

    // The object's own description is a paragraph, not a cell. Escaping there would leak a
    // stray backslash into readable prose.
    expect(file!.contents).toContain("Customers <b>and</b> their | history");
  });

  it("indents nested STRUCT fields with non-breaking spaces", () => {
    const [file] = generateDocs(fixture(), { format: "markdown" });

    // A markdown cell collapses ordinary leading whitespace, so `postcode` would render flush
    // with its parent and read as a sibling column.
    expect(file!.contents).toMatch(/&nbsp;.*`postcode`/);
  });

  it("resolves classification inherited from a domain", () => {
    const [file] = generateDocs(fixture(), { format: "markdown" });

    // `email_address` sets nothing itself. A document that reported it unclassified would
    // disagree with the policy tags the generator actually emits.
    expect(file!.contents).toContain("confidential");
    // One of four: only `email_address` is classified, and it inherits from its domain.
    expect(file!.contents).toContain("**Classified fields**: 1 of 4");
  });

  it("can leave governance out", () => {
    const [file] = generateDocs(fixture(), { format: "markdown", governance: false });
    expect(file!.contents).not.toContain("Sensitivity");
  });

  it("is reproducible when no timestamp is supplied", () => {
    const first = generateDocs(fixture(), { format: "markdown" })[0]!.contents;
    const second = generateDocs(fixture(), { format: "markdown" })[0]!.contents;

    // Byte-identical, so committing the output produces a diff only when the model changed.
    expect(first).toBe(second);
  });

  it("stamps a supplied date rather than reading the clock", () => {
    const [file] = generateDocs(fixture(), { format: "markdown", generatedAt: "2026-01-01" });
    expect(file!.contents).toContain("2026-01-01");
  });

  it("rejects a model that does not exist", () => {
    expect(() => generateDocs(fixture(), { format: "markdown", model: "nope" })).toThrow(/no model/);
  });
});

describe("generateDocs html", () => {
  it("produces a self-contained document with no external requests", () => {
    const [file] = generateDocs(fixture(), { format: "html" });
    const html = file!.contents;

    expect(html.startsWith("<!doctype html>")).toBe(true);
    // A document that fetches a stylesheet renders unstyled from a file:// URL or behind a
    // proxy, which is exactly where these get opened.
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/<script/);
  });

  it("escapes markup in a description instead of rendering it", () => {
    const [file] = generateDocs(fixture(), { format: "html" });

    // The description contains `<b>`. Rendering it would let model content inject markup into
    // the document, and an unclosed tag would swallow the rest of the table.
    expect(file!.contents).toContain("&lt;b&gt;and&lt;/b&gt;");
    expect(file!.contents).not.toContain("their <b>and</b>");
  });

  it("escapes an ampersand in a nested field description", () => {
    const [file] = generateDocs(fixture(), { format: "html" });
    expect(file!.contents).toContain("Outward &amp; inward");
    // The markdown escape must not leak into HTML, where a pipe is an ordinary character.
    expect(file!.contents).not.toContain(String.raw`\|`);
  });

  it("contains no unpaired surrogates", () => {
    const [file] = generateDocs(fixture(), { format: "html" });

    // The document uses em dashes and arrows. A lone surrogate here would break writing the
    // file to disk entirely, and the failure surfaces far from its cause.
    for (const character of file!.contents) {
      const code = character.charCodeAt(0);
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it("links every object from the contents list", () => {
    const [file] = generateDocs(fixture(), { format: "html" });
    expect(file!.contents).toContain('href="#dim-customer"');
    expect(file!.contents).toContain('id="dim-customer"');
  });
});
