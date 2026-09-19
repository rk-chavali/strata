import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ObjectGraph, parseObject } from "@strata/metamodel";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { governanceReport, renderGovernanceMarkdown } from "./governance.js";

/**
 * The governance report, against the shipped example.
 *
 * Real workspace rather than a fixture, for the reason `changes.test.ts` gives: the interesting
 * behaviour is *resolution*. `dim_customer.email_address` carries a pii classification directly,
 * and the quickstart also defines an `email_address` domain, so the register has to distinguish a
 * column that classified itself from one that inherited. A fixture written to match the code
 * would encode whatever the code already believes about that.
 */

const QUICKSTART = join(import.meta.dirname, "..", "..", "..", "examples", "quickstart");

let workspace: LoadedWorkspace;

beforeAll(async () => {
  workspace = await loadWorkspace(QUICKSTART);
});

/**
 * A one-model, one-table graph with the given columns.
 *
 * Through `parseObject` rather than a cast, so the objects carry the schema defaults a real load
 * would apply; a hand-built literal is missing them and crashes the graph on `add`.
 */
function tableGraph(columns: { id: string; name: string; dataType: string; mode: string }[]): ObjectGraph {
  const graph = new ObjectGraph();

  for (const input of [
    { id: "mdl_synthetic", kind: "model", name: "synthetic", tier: "physical" },
    { id: "tbl_synthetic", kind: "table", name: "fct_synthetic", model: "synthetic", objectType: "table", primaryKey: [], columns },
  ]) {
    const parsed = parseObject(input);
    if (!parsed.object) throw new Error(`fixture did not parse: ${JSON.stringify(parsed.issues)}`);
    graph.add(parsed.object);
  }

  return graph;
}

describe("governanceReport", () => {
  it("reports the estate, not just one model", () => {
    const report = governanceReport(workspace.graph);

    expect(report.estate.objects).toBeGreaterThan(0);
    expect(report.estate.columns).toBeGreaterThan(0);
    expect(report.estate.percentages.described).toBeGreaterThanOrEqual(0);
    expect(report.estate.percentages.described).toBeLessThanOrEqual(100);
  });

  it("lists every classified field in the register", () => {
    const report = governanceReport(workspace.graph);
    const email = report.register.find((entry) => entry.field === "email_address");

    expect(email, "dim_customer.email_address is classified in the example").toBeDefined();
    expect(email?.categories).toContain("pii");
  });

  it("keeps classified fields out of the backlog and vice versa", () => {
    /*
      The two lists answer opposite questions, and a field in both would make the totals lie.
      Worth asserting rather than assuming: the register branch `continue`s, and someone tidying
      that away would produce a report where the backlog silently included classified columns.
    */
    const report = governanceReport(workspace.graph);
    const key = (e: { model: string; object: string; field: string }) => `${e.model}/${e.object}/${e.field}`;

    const registered = new Set(report.register.map(key));
    const overlap = report.backlog.filter((entry) => registered.has(key(entry)));

    expect(overlap).toEqual([]);
  });

  it("agrees with the coverage function about how much is left to decide", () => {
    /*
      The cross-check that matters. This module counts dictionary rows; `classificationCoverage`
      counts table columns. They are different traversals of the same question, and if they ever
      disagree then the report and the dictionary page show a lead two different numbers for
      "what is left", which is worse than not measuring it.
    */
    const report = governanceReport(workspace.graph);
    const expected = report.models.reduce((sum, entry) => sum + entry.unrecognised, 0);

    expect(report.backlog).toHaveLength(expected);
  });

  it("excludes a field a rule can already classify from the backlog", () => {
    /*
      The point of the split: a column something recognises is a button press, not a decision, and
      counting it as outstanding work overstates the queue a lead plans with.

      Synthetic, because the quickstart happens to trip no pattern at all. Asserting this against
      the example would pass vacuously today and keep passing if the exclusion were deleted.
    */
    const graph = tableGraph([
      { id: "c1", name: "phone", dataType: "STRING", mode: "NULLABLE" },
      { id: "c2", name: "widget_count", dataType: "INT64", mode: "NULLABLE" },
    ]);

    const report = governanceReport(graph);
    const fields = report.backlog.map((entry) => entry.field);

    /*
      `phone`, not `phone_number`. The pattern is `\bphone\b` and `_` is a word character, so the
      boundary never matches inside `phone_number` and the more natural-looking fixture would
      have proved nothing.
    */
    expect(report.suggestions).toBeGreaterThan(0);
    expect(fields).not.toContain("phone");
    // Nothing recognises this one, so it is genuinely someone's call.
    expect(fields).toContain("widget_count");
  });

  it("skips models that have no columns rather than reporting them as 0%", () => {
    const report = governanceReport(workspace.graph);
    // The conceptual and logical models have no columns; only the warehouse should appear.
    expect(report.models.map((entry) => entry.model)).toEqual(["shop_warehouse"]);
  });
});

describe("renderGovernanceMarkdown", () => {
  it("leads with the estate percentages, which is all most readers read", () => {
    const markdown = renderGovernanceMarkdown(governanceReport(workspace.graph), "shop");

    expect(markdown).toContain("# Governance report: shop");
    expect(markdown.indexOf("## The estate")).toBeLessThan(markdown.indexOf("## Classified fields"));
  });

  it("names the outstanding decisions separately from the suggestions", () => {
    const report = governanceReport(workspace.graph);
    const markdown = renderGovernanceMarkdown(report, "shop");

    expect(markdown).toContain("## Needs a decision");
    expect(markdown).toContain(`A further ${report.suggestions} have a suggestion waiting`);
  });

  it("says so plainly when nothing is classified, rather than printing an empty table", () => {
    const empty = {
      ...governanceReport(workspace.graph),
      register: [],
    };
    const markdown = renderGovernanceMarkdown(empty, "shop");

    expect(markdown).toContain("Nothing in this workspace carries a classification yet.");
    expect(markdown).not.toContain("| Model | Object | Field | Sensitivity |");
  });
});
