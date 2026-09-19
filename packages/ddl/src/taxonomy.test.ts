import { describe, expect, it } from "vitest";
import { ObjectGraph, parseObject, type AnyObject, type Classification, type Column } from "@strata/metamodel";
import { effectiveClassification, resolvePolicyTag, type Taxonomy } from "./taxonomy.js";

/**
 * The link between a classification and a BigQuery policy tag.
 *
 * The bug this module exists to fix was silent: a column classified `confidential / pii`
 * generated no policy tag at all, because the emitter keyed off a tag being named on the
 * column. Every test here is a way that can go wrong again, a resolution that guesses, a
 * merge that drops a field, or an inheritance hop that is not followed.
 */

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

const TAXONOMY: Taxonomy = {
  byCategory: { pii: "tags/pii", financial: "tags/financial" },
  bySensitivity: { restricted: "tags/restricted" },
  byName: { "pii/contact": "tags/contact" },
};

describe("resolvePolicyTag", () => {
  it("returns nothing when there is no classification", () => {
    expect(resolvePolicyTag(undefined, TAXONOMY)).toBeUndefined();
  });

  it("returns nothing when the classification matches no rule", () => {
    // `internal` is not in the taxonomy. Inventing a tag would apply column-level security
    // nobody asked for, which is worse than applying none.
    expect(resolvePolicyTag({ sensitivity: "internal", categories: [] }, TAXONOMY)).toBeUndefined();
  });

  it("prefers an explicit resource id on the column over anything in the taxonomy", () => {
    const result = resolvePolicyTag(
      { policyTag: "tags/explicit", categories: ["pii"], sensitivity: "restricted" },
      TAXONOMY,
    );

    // A column that names its own tag has made a decision; the taxonomy must not override it.
    expect(result).toEqual({ tag: "tags/explicit", source: "column" });
  });

  it("resolves a logical taxonomy name through byName, not byCategory", () => {
    const result = resolvePolicyTag({ policyTagName: "pii/contact", categories: [] }, TAXONOMY);
    expect(result?.tag).toBe("tags/contact");
  });

  it("reports an unresolvable taxonomy name rather than dropping it", () => {
    const result = resolvePolicyTag({ policyTagName: "unknown/node", categories: [] }, TAXONOMY);

    // The generator turns this into a TODO. Emitting nothing would leave a column the
    // modeller explicitly marked sensitive with no protection and no trace of the intent.
    expect(result?.unresolved).toBe(true);
    expect(result?.tag).toBe("unknown/node");
  });

  it("matches a category before a sensitivity", () => {
    const result = resolvePolicyTag(
      { categories: ["pii"], sensitivity: "restricted" },
      TAXONOMY,
    );

    // A category says what the data *is*; a sensitivity only says how carefully to treat it.
    expect(result).toEqual({ tag: "tags/pii", source: "category", matched: "pii" });
  });

  it("falls back to sensitivity when no category matches", () => {
    const result = resolvePolicyTag({ categories: ["demographic"], sensitivity: "restricted" }, TAXONOMY);
    expect(result).toEqual({ tag: "tags/restricted", source: "sensitivity", matched: "restricted" });
  });

  it("resolves nothing when no taxonomy is configured", () => {
    // The whole feature is opt-in: a workspace that has declared no mapping gets the old
    // behaviour rather than a guess.
    expect(resolvePolicyTag({ categories: ["pii"] } as Classification, undefined)).toBeUndefined();
  });
});

describe("effectiveClassification", () => {
  /** column → domain, column → attribute → domain: every inheritance hop in one graph. */
  function graphFixture(): ObjectGraph {
    const graph = new ObjectGraph();

    graph.add(
      obj({
        id: "dom_email",
        kind: "domain",
        name: "email",
        logicalType: "string",
        classification: { sensitivity: "confidential", categories: ["pii", "contact"] },
      }),
    );

    graph.add(
      obj({
        id: "dom_money",
        kind: "domain",
        name: "money",
        logicalType: "decimal",
        classification: { categories: ["financial"] },
      }),
    );

    graph.add(obj({ id: "mdl_l", kind: "model", name: "logical", tier: "logical" }));
    graph.add(
      obj({
        id: "ent_c",
        kind: "entity",
        name: "Customer",
        model: "logical",
        attributes: [
          {
            id: "a1",
            name: "customer_id",
            logicalType: "string",
            classification: { sensitivity: "restricted", categories: ["pii"] },
          },
          // Classified only through its own domain, the second hop.
          { id: "a2", name: "lifetime_value", domain: "money" },
        ],
      }),
    );

    graph.add(obj({ id: "mdl_p", kind: "model", name: "wh", tier: "physical" }));
    return graph;
  }

  const column = (patch: Record<string, unknown>): Column =>
    ({ id: "c", name: "c", dataType: "STRING", mode: "NULLABLE", tags: [], properties: [], previousNames: [], ...patch }) as unknown as Column;

  it("returns nothing for an unclassified column with no inheritance", () => {
    expect(effectiveClassification(column({}), graphFixture(), "wh")).toBeUndefined();
  });

  it("reads the column's own classification", () => {
    const result = effectiveClassification(
      column({ classification: { sensitivity: "internal", categories: [] } }),
      graphFixture(),
      "wh",
    );
    expect(result?.sensitivity).toBe("internal");
  });

  it("inherits from the column's domain", () => {
    const result = effectiveClassification(column({ domain: "email" }), graphFixture(), "wh");

    expect(result?.sensitivity).toBe("confidential");
    expect(result?.categories).toEqual(["pii", "contact"]);
  });

  it("inherits from the logical attribute the column implements", () => {
    // This is the hop that makes the logical tier worth having: classify once, upstream, and
    // every physical column that implements it is protected.
    const result = effectiveClassification(
      column({ attributeRef: "logical:Customer.customer_id" }),
      graphFixture(),
      "wh",
    );

    expect(result?.sensitivity).toBe("restricted");
    expect(result?.categories).toEqual(["pii"]);
  });

  it("follows column to attribute to domain", () => {
    const result = effectiveClassification(
      column({ attributeRef: "logical:Customer.lifetime_value" }),
      graphFixture(),
      "wh",
    );

    // Stopping at the attribute would find nothing on it and report the column unclassified,
    // even though the type library governs it.
    expect(result?.categories).toEqual(["financial"]);
  });

  it("lets the column override an inherited sensitivity", () => {
    const result = effectiveClassification(
      column({ domain: "email", classification: { sensitivity: "restricted", categories: [] } }),
      graphFixture(),
      "wh",
    );
    expect(result?.sensitivity).toBe("restricted");
  });

  it("merges field by field rather than taking whichever object came first", () => {
    const result = effectiveClassification(
      column({ domain: "email", classification: { sensitivity: "restricted", categories: [] } }),
      graphFixture(),
      "wh",
    );

    /*
      The column sets only a sensitivity. Taking its whole object would drop the domain's
      categories, and the categories are what decide whether a policy tag gets applied, so
      the failure would be a silently *unprotected* column.
    */
    expect(result?.categories).toEqual(["pii", "contact"]);
  });

  it("unions categories from every layer", () => {
    const result = effectiveClassification(
      column({ domain: "email", classification: { categories: ["financial"] } }),
      graphFixture(),
      "wh",
    );

    expect([...(result?.categories ?? [])].sort()).toEqual(["contact", "financial", "pii"]);
  });

  it("survives a reference that resolves to nothing", () => {
    // A dangling `attributeRef` is a validation error reported elsewhere; generation must not
    // throw over it, or one bad reference stops the whole warehouse from being generated.
    expect(() =>
      effectiveClassification(column({ attributeRef: "logical:Nope.missing" }), graphFixture(), "wh"),
    ).not.toThrow();
  });
});

describe("classification to policy tag, end to end", () => {
  it("turns a classification inherited from a logical attribute into a real tag", () => {
    const graph = new ObjectGraph();
    graph.add(obj({ id: "mdl_l", kind: "model", name: "logical", tier: "logical" }));
    graph.add(
      obj({
        id: "ent_c",
        kind: "entity",
        name: "Customer",
        model: "logical",
        attributes: [
          { id: "a1", name: "email", logicalType: "string", classification: { categories: ["pii"] } },
        ],
      }),
    );

    const col = {
      id: "c",
      name: "email_address",
      dataType: "STRING",
      mode: "NULLABLE",
      attributeRef: "logical:Customer.email",
      tags: [],
      properties: {},
      previousNames: [],
    } as unknown as Column;

    const effective = effectiveClassification(col, graph, "wh");
    const tag = resolvePolicyTag(effective, TAXONOMY);

    // The whole point of the slice: one classification on the logical side, a real tag on the
    // physical column, with no per-column annotation in between.
    expect(tag?.tag).toBe("tags/pii");
    expect(tag?.source).toBe("category");
  });
});
