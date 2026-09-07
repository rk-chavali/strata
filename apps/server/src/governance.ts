import type { ObjectGraph } from "@strata/metamodel";
import { coverage, type CoverageReport } from "@strata/ddl";
import { classificationCoverage, dictionaryView, suggestClassifications } from "@strata/query";

/**
 * The report a governance lead is actually asked for.
 *
 * Every number here already existed, and none of them were reachable in one place. Coverage was
 * computed for the dictionary page, classification suggestions for the insights route, ownership
 * inside the CODEOWNERS generator. A data officer asked "which fields hold personal data, who
 * owns them, and what is left to decide" and the honest answer was "open five pages and add up".
 *
 * **Assembly, not new measurement.** Each section delegates to the function that already owns
 * that question, for a reason this codebase has hit before: a second count of "how much is
 * classified" that ignored domain inheritance would disagree with the dictionary page, and two
 * different answers to one question is worse than not measuring it.
 *
 * **The register lists what is classified; the backlog lists what nobody can classify for you.**
 * The split is the whole point. An unclassified column that `suggestClassifications` recognises
 * is not work, it is a button press. What no pattern recognises is the actual queue, and it is
 * the only number that tells a lead how long this will take.
 */

export interface RegisterEntry {
  model: string;
  object: string;
  field: string;
  sensitivity?: string;
  categories: string[];
  /** The domain the classification came from, when the column did not set it itself. */
  inheritedFrom?: string;
}

export interface BacklogEntry {
  model: string;
  object: string;
  field: string;
  type: string;
}

export interface ModelCoverage {
  model: string;
  classified: number;
  total: number;
  /** Columns no pattern recognises. The real queue. */
  unrecognised: number;
}

export interface GovernanceReport {
  /** Workspace-wide ownership, description and classification percentages. */
  estate: CoverageReport;
  models: ModelCoverage[];
  /** Every field carrying a classification, direct or inherited. */
  register: RegisterEntry[];
  /** Unclassified fields that no pattern recognises, so a human has to decide. */
  backlog: BacklogEntry[];
  /** How many suggestions are waiting, which the insights page can apply in bulk. */
  suggestions: number;
  /** Both lists are capped; true when there was more. */
  truncated: boolean;
  generatedAt: string;
}

/**
 * How many rows either list carries.
 *
 * A register of ten thousand columns is not a report, it is an export, and rendering it would
 * lock the page. The cap is reported rather than hidden so a reader knows to use the download.
 */
const LIMIT = 500;

export function governanceReport(graph: ObjectGraph): GovernanceReport {
  const register: RegisterEntry[] = [];
  const backlog: BacklogEntry[] = [];
  const models: ModelCoverage[] = [];

  /*
    Suggestions are counted once for the workspace rather than per model.

    `suggestClassifications` walks the whole graph for an unfiltered call, so asking it per model
    would be one full traversal per model to produce numbers that sum to this one.
  */
  const suggestions = suggestClassifications(graph);
  const suggested = new Set(suggestions.map((entry) => `${entry.objectId}.${entry.path}`));

  for (const loaded of graph.models()) {
    const model = loaded.object.name;

    /*
      Gated on the number that gets *reported*, not on the dictionary's row count.

      They disagree, and the first version got it wrong. `dictionaryView` returns a row per
      logical attribute as well as per physical column, so a logical model has rows while
      `classificationCoverage`, which counts table columns only, reports zero of zero. Gating on
      the dictionary therefore admitted the logical model and then rendered `0 / 0`, which the
      markdown turned into `NaN%`.
    */
    const summary = classificationCoverage(graph, model);
    if (summary.total === 0) continue;

    const view = dictionaryView(graph, model);
    models.push({
      model,
      classified: summary.classified,
      total: summary.total,
      unrecognised: summary.unrecognised,
    });

    for (const row of view.rows) {
      const sensitivity = row.sensitivity ?? row.inherited?.sensitivity;
      const categories = row.categories.length > 0 ? row.categories : (row.inherited?.categories ?? []);

      if (sensitivity || categories.length > 0) {
        register.push({
          model,
          object: row.objectName,
          field: row.path,
          ...(sensitivity ? { sensitivity } : {}),
          categories,
          // Named so a lead can fix one domain rather than forty columns.
          ...(!row.sensitivity && row.inherited ? { inheritedFrom: row.inherited.from } : {}),
        });
        continue;
      }

      // Unclassified. Only a backlog item when nothing can propose a value for it.
      if (!suggested.has(`${row.objectId}.${row.path}`)) {
        backlog.push({ model, object: row.objectName, field: row.path, type: row.type });
      }
    }
  }

  return {
    estate: coverage(graph),
    models: models.sort((a, b) => a.model.localeCompare(b.model)),
    register: register.slice(0, LIMIT),
    backlog: backlog.slice(0, LIMIT),
    suggestions: suggestions.length,
    truncated: register.length > LIMIT || backlog.length > LIMIT,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The same report as a markdown document.
 *
 * Exists because a compliance officer wants a *file*: something to attach to a ticket, paste into
 * a review, or keep as evidence of where the estate stood on a date. A screenshot of a web page
 * is not that, and asking them to take one is how a governance feature stops being used.
 *
 * Markdown rather than PDF or XLSX: it renders in every wiki and pull request, it diffs, and it
 * needs no dependency. The estate percentages come first because that is the only part most
 * readers will read.
 */
export function renderGovernanceMarkdown(report: GovernanceReport, workspace: string): string {
  const lines: string[] = [
    `# Governance report: ${workspace}`,
    "",
    `Generated ${report.generatedAt}.`,
    "",
    "## The estate",
    "",
    "| Measure | Covered | Share |",
    "|---|---|---|",
    `| Objects with an owner | ${report.estate.withOwner} / ${report.estate.objects} | ${report.estate.percentages.owned}% |`,
    `| Objects with a description | ${report.estate.withDescription} / ${report.estate.objects} | ${report.estate.percentages.described}% |`,
    `| Columns with a description | ${report.estate.columnsWithDescription} / ${report.estate.columns} | ${report.estate.percentages.columnsDescribed}% |`,
    `| Sensitive columns classified | ${report.estate.sensitiveClassified} / ${report.estate.sensitiveColumns} | ${report.estate.percentages.sensitiveClassified}% |`,
    "",
  ];

  if (report.models.length > 0) {
    lines.push("## By model", "", "| Model | Classified | Needs a decision |", "|---|---|---|");
    for (const entry of report.models) {
      const share = Math.round((entry.classified / entry.total) * 100);
      lines.push(`| ${entry.model} | ${entry.classified} / ${entry.total} (${share}%) | ${entry.unrecognised} |`);
    }
    lines.push("");
  }

  lines.push(
    "## Classified fields",
    "",
    report.register.length === 0
      ? "Nothing in this workspace carries a classification yet."
      : "| Model | Object | Field | Sensitivity | Categories | Inherited from |",
  );

  if (report.register.length > 0) {
    lines.push("|---|---|---|---|---|---|");
    for (const entry of report.register) {
      lines.push(
        `| ${entry.model} | ${entry.object} | ${entry.field} | ${entry.sensitivity ?? ""} | ` +
          `${entry.categories.join(", ")} | ${entry.inheritedFrom ?? ""} |`,
      );
    }
  }
  lines.push("");

  lines.push(
    "## Needs a decision",
    "",
    `${report.backlog.length} field(s) carry no classification and no rule recognises them. ` +
      `A further ${report.suggestions} have a suggestion waiting that can be applied in bulk.`,
    "",
  );

  if (report.backlog.length > 0) {
    lines.push("| Model | Object | Field | Type |", "|---|---|---|---|");
    for (const entry of report.backlog) {
      lines.push(`| ${entry.model} | ${entry.object} | ${entry.field} | ${entry.type} |`);
    }
    lines.push("");
  }

  if (report.truncated) {
    lines.push(`> Lists are capped at ${LIMIT} rows. Query the API for the full set.`, "");
  }

  return lines.join("\n");
}
