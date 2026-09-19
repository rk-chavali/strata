import {
  CARDINALITY_NOTATION,
  isKind,
  parseObject,
  type AnyObject,
  type ObjectGraph,
  type Table,
} from "@strata/metamodel";
import { parseYamlFile, looksLikeModelObject, type LoadedWorkspace } from "@strata/storage";
import { generateAlter } from "@strata/ddl";
import { changedBetween, fileAtRevision, type FileChange } from "./git.js";
import { classificationCoverage, impact } from "@strata/query";
import type { IntegrationEvent } from "./integrations.js";

/**
 * What changed, computed once and rendered by every provider.
 *
 * The single most important decision here: **the summary is built once per event, not once per
 * provider.** Four providers each recomputing the diff would run the same git commands and the
 * same graph traversal four times, and, worse, could disagree with each other if the working
 * tree moved underneath them. A Slack message and a GitHub comment describing the same merge
 * differently is the kind of thing that destroys trust in the whole feature.
 *
 * The second decision: this describes **consequences, not a diff**. Anyone can read a YAML diff
 * on the pull request. What they cannot do is see that removing one column breaks three Dataform
 * models downstream, or that a type change needs a migration rather than a rebuild. That is the
 * part worth posting into a channel, and it is the part this assembles.
 */

/** One object the change touched. */
export interface ChangedObject {
  id: string;
  name: string;
  kind: string;
  /** The model it belongs to, when it belongs to one. Shared objects do not. */
  model?: string;
  change: FileChange;
  path: string;
}

/** Something downstream that this change reaches. */
export interface DownstreamEntry {
  /** The changed object the consequence flows from. */
  source: string;
  /** What depends on it. */
  dependent: string;
  severity: "breaks" | "rewrites" | "informational";
  reason: string;
}

/** The migration a change implies, when it implies one. */
export interface MigrationEntry {
  table: string;
  statements: string[];
  /**
   * True when BigQuery cannot do this in place.
   *
   * The single most consequential field on the summary: an in-place ALTER is a minute, and a
   * recreate is a backfill someone has to schedule.
   */
  requiresRecreate: boolean;
}

export interface ChangeSummary {
  event: IntegrationEvent;
  /** The workspace name, so a channel receiving several strata instances can tell them apart. */
  workspace: string;
  branch?: string;
  sha?: string;
  shortSha?: string;
  subject?: string;
  author?: string;
  /** ISO 8601. Formatting is the receiver's job, a Slack channel and a wiki want it differently. */
  date?: string;
  pullRequest?: number;
  pullRequestUrl?: string;
  objects: ChangedObject[];
  downstream: DownstreamEntry[];
  migration: MigrationEntry[];
  /** Validation errors, for the `validationFailed` event. */
  errors: { code: string; message: string; file?: string }[];
  counts: {
    added: number;
    removed: number;
    modified: number;
    /** Downstream dependents that would actually break. The number a reader should react to. */
    breaks: number;
  };
  /**
   * Classification coverage for each model the change touched.
   *
   * Here rather than left to the reviewer because governance is the question nobody remembers to
   * ask on a schema change, and it is exactly the moment to ask it: a table gains a column, the
   * column holds an email address, and nothing prompts anyone until an audit does. One line
   * saying coverage went from 92% to 87% is the whole intervention.
   *
   * Scoped to affected models, not the workspace. A number that never moves is a number people
   * stop reading.
   */
  governance: GovernanceEntry[];
  /**
   * A mermaid `erDiagram` of the tables the change touched, or absent when it touched none.
   *
   * Mermaid rather than a rendered image, because GitHub renders mermaid natively in a comment
   * and an image would need somewhere to be hosted. A picture in the review is the difference
   * between a reviewer who models for a living and one who does not, and the second is the
   * person this comment exists for.
   */
  erd?: string;
}

export interface GovernanceEntry {
  model: string;
  classified: number;
  total: number;
  /** Columns no pattern recognises either, so a human has to decide. The real backlog. */
  unrecognised: number;
}

export interface SummaryOptions {
  event: IntegrationEvent;
  /** The revision range to describe. Absent for events that are not about a diff. */
  range?: { from: string; to: string };
  branch?: string;
  sha?: string;
  subject?: string;
  author?: string;
  date?: string;
  pullRequest?: number;
  pullRequestUrl?: string;
  errors?: { code: string; message: string; file?: string }[];
}

/**
 * Build the summary.
 *
 * Never throws. A dispatcher that failed because the summary could not be built would turn a
 * cosmetic problem, one unresolvable object, a rewritten history, into a merge that reports
 * nothing at all. Every stage degrades to "less detail" rather than "no summary".
 */
export async function buildChangeSummary(
  workspace: LoadedWorkspace,
  options: SummaryOptions,
): Promise<ChangeSummary> {
  const objects: ChangedObject[] = [];
  const downstream: DownstreamEntry[] = [];
  const migration: MigrationEntry[] = [];

  if (options.range) {
    const changed = await changedBetween(workspace.root, options.range.from, options.range.to);

    for (const entry of changed) {
      /*
        Removed files are resolved out of history, not out of the current workspace.

        The object is gone from `filesByPath` by definition, that index describes the tree as it
        is now. Reading the file at the *old* revision is the only way to name what was deleted,
        and naming it is the whole point: "3 files changed" tells a reader nothing, "dropped
        `dim_customer`" tells them everything.
      */
      const found =
        entry.change === "removed"
          ? await objectsAtRevision(workspace.root, options.range.from, entry.path)
          : (workspace.filesByPath.get(entry.path) ?? []);

      for (const object of found) {
        objects.push({
          id: object.id,
          name: object.name,
          kind: object.kind,
          ...(modelOf(workspace.graph, object) ? { model: modelOf(workspace.graph, object) } : {}),
          change: entry.change,
          path: entry.path,
        });
      }
    }

    collectDownstream(workspace.graph, objects, downstream);
    await collectMigrations(workspace, options.range.from, objects, migration);
  }

  const erd = mermaidErd(workspace.graph, objects);

  return {
    governance: collectGovernance(workspace.graph, objects),
    ...(erd ? { erd } : {}),
    event: options.event,
    workspace: workspace.config.name,
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.sha ? { sha: options.sha, shortSha: options.sha.slice(0, 7) } : {}),
    ...(options.subject ? { subject: options.subject } : {}),
    ...(options.author ? { author: options.author } : {}),
    ...(options.date ? { date: options.date } : {}),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.pullRequestUrl ? { pullRequestUrl: options.pullRequestUrl } : {}),
    objects,
    downstream,
    migration,
    errors: options.errors ?? [],
    counts: {
      added: objects.filter((object) => object.change === "added").length,
      removed: objects.filter((object) => object.change === "removed").length,
      modified: objects.filter((object) => object.change === "modified").length,
      breaks: downstream.filter((entry) => entry.severity === "breaks").length,
    },
  };
}

/**
 * Classification coverage for every model the change touched.
 *
 * `classificationCoverage` is reused rather than counted here, because it already resolves the
 * inheritance chain column → domain → logical attribute. A second count that ignored inheritance
 * would report a lower number than the dictionary page for the same model, and two different
 * answers to "how much is classified" is worse than not measuring it.
 */
export function collectGovernance(graph: ObjectGraph, objects: ChangedObject[]): GovernanceEntry[] {
  const models = [...new Set(objects.map((object) => object.model).filter(Boolean))] as string[];

  return models
    .map((model) => {
      const report = classificationCoverage(graph, model);
      return { model, classified: report.classified, total: report.total, unrecognised: report.unrecognised };
    })
    // A model with no columns yet reports 0 of 0, which renders as a meaningless 0%.
    .filter((entry) => entry.total > 0)
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** How many tables the diagram will draw before it stops being readable. */
const ERD_TABLE_LIMIT = 12;

/**
 * A mermaid `erDiagram` of the tables this change touched.
 *
 * **Only the changed tables, plus the relationships between them.** The temptation is to include
 * neighbours for context, and it is the wrong call: a diagram of the whole model is the thing
 * the reviewer already cannot read, and drawing forty boxes to highlight two hides the two.
 *
 * Columns are capped and the table count is capped, because a mermaid block that fails to parse
 * renders as a wall of raw text in the comment, which is worse than no diagram at all.
 */
export function mermaidErd(graph: ObjectGraph, objects: ChangedObject[]): string | undefined {
  const tables = objects
    .filter((object) => object.kind === "table" && object.change !== "removed")
    .map((object) => graph.get(object.id)?.object)
    .filter((object): object is Table => Boolean(object) && isKind(object!, "table"))
    .slice(0, ERD_TABLE_LIMIT);

  if (tables.length === 0) return undefined;

  const included = new Set(tables.map((table) => table.id));
  const lines = ["erDiagram"];

  for (const table of tables) {
    lines.push(`  ${mermaidName(table.name)} {`);
    for (const column of table.columns.slice(0, 20)) {
      /*
        Mermaid's attribute grammar accepts only word characters in a type, so `NUMERIC(18, 2)`
        and `ARRAY<INT64>` both break the parse. Truncating at the first non-word character
        keeps `NUMERIC` and `ARRAY`, which is the part a reviewer reads anyway.
      */
      const type = (column.dataType.match(/^\w+/)?.[0] ?? "UNKNOWN").toUpperCase();
      const key = table.primaryKey.includes(column.name) ? " PK" : "";
      lines.push(`    ${type} ${mermaidName(column.name)}${key}`);
    }
    if (table.columns.length > 20) lines.push(`    STRING more_columns_omitted`);
    lines.push("  }");
  }

  for (const entry of graph.all()) {
    const relationship = entry.object;
    if (!isKind(relationship, "relationship")) continue;

    /*
      `resolve`, not `get`.

      A relationship end holds a *reference*, `dim_customer`, not an id, `tbl_dim_customer`, and
      may qualify it with a model. `get` keys on id alone, so it returns nothing for every
      relationship in a normal workspace and the diagram silently loses all its edges: boxes with
      no lines, which looks like a model with no relationships rather than a bug.
    */
    const context = relationship.model ? { model: relationship.model } : {};
    const parent = graph.resolve(relationship.parent.ref, context)?.target.object;
    const child = graph.resolve(relationship.child.ref, context)?.target.object;
    // Both ends must be drawn, or mermaid invents a box for the missing one and the diagram
    // silently grows past the limit this function exists to enforce.
    if (!parent || !child || !included.has(parent.id) || !included.has(child.id)) continue;

    const left = CARDINALITY_NOTATION[relationship.parent.cardinality];
    const right = mirrorGlyph(CARDINALITY_NOTATION[relationship.child.cardinality]);
    const label = relationship.child.attributes[0] ?? relationship.name;

    lines.push(
      `  ${mermaidName(parent.name)} ${left}--${right} ${mermaidName(child.name)} : "${mermaidName(label)}"`,
    );
  }

  return lines.join("\n");
}

/**
 * The right-hand crow's-foot glyph, mirrored from the left-hand form.
 *
 * `CARDINALITY_NOTATION` gives the left-hand spelling, `}o` for zero-or-more. Mermaid reads a
 * relationship left to right, so the same cardinality on the right is written `o{`: the
 * characters reverse *and* the brace flips. Reversing alone yields `o}`, which mermaid does not
 * recognise, and an unrecognised glyph fails the whole block rather than that one line, so every
 * diagram with a to-many relationship would have rendered as raw text.
 */
function mirrorGlyph(glyph: string): string {
  return [...glyph]
    .reverse()
    .map((character) => (character === "}" ? "{" : character === "{" ? "}" : character))
    .join("");
}

/** Mermaid identifiers are word characters only; anything else ends the token early. */
function mermaidName(value: string): string {
  return value.replace(/[^\w]/g, "_") || "unnamed";
}

/** Parse the objects a file held at a revision. */
async function objectsAtRevision(
  root: string,
  revision: string,
  path: string,
): Promise<AnyObject[]> {
  const text = await fileAtRevision(root, revision, path);
  if (text === undefined) return [];

  const parsed = parseYamlFile(text);
  const found: AnyObject[] = [];

  for (const doc of parsed.documents) {
    if (!looksLikeModelObject(doc.value)) continue;
    const result = parseObject(doc.value);
    // A historical revision may hold an object this version of strata no longer accepts. Skipping
    // it loses one line of the summary; throwing would lose the entire summary.
    if (result.object) found.push(result.object);
  }

  return found;
}

/** Which model an object belongs to, if any. */
function modelOf(graph: ObjectGraph, object: AnyObject): string | undefined {
  const loaded = graph.get(object.id);
  const model = (loaded?.object as { model?: string } | undefined)?.model;
  return typeof model === "string" ? model : undefined;
}

/**
 * Walk downstream from every changed object.
 *
 * Only from objects that still exist. `impact()` traverses the *current* graph, so a deleted
 * object has no node to start from, its dependents are found instead through the objects that
 * referenced it, which now carry stale references and surface as validation errors. Inventing a
 * traversal from a node that is gone would produce confident nonsense.
 */
function collectDownstream(
  graph: ObjectGraph,
  objects: readonly ChangedObject[],
  into: DownstreamEntry[],
): void {
  const seen = new Set<string>();

  for (const object of objects) {
    if (object.change === "removed") continue;

    const result = impact(graph, object.id);
    if (!result) continue;

    for (const entry of result.entries) {
      /*
        Deduplicated across sources.

        Two changed columns in one table reach the same downstream model, and reporting it twice
        would inflate the only number a reader is meant to react to.
      */
      const key = `${object.id}→${entry.objectId}:${entry.column ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      into.push({
        source: object.name,
        dependent: entry.column ? `${entry.objectName}.${entry.column}` : entry.objectName,
        severity: entry.severity,
        reason: entry.reason,
      });
    }
  }
}

/**
 * Generate the ALTER for every table that changed shape.
 *
 * Only for modified tables. An added table needs a `CREATE`, which the ordinary DDL generator
 * already produces, and a dropped table needs a decision rather than a script.
 */
async function collectMigrations(
  workspace: LoadedWorkspace,
  from: string,
  objects: readonly ChangedObject[],
  into: MigrationEntry[],
): Promise<void> {
  for (const changed of objects) {
    if (changed.change !== "modified") continue;

    const loaded = workspace.graph.get(changed.id);
    if (!loaded || !isKind(loaded.object, "table")) continue;
    const after = loaded.object;

    const previous = await objectsAtRevision(workspace.root, from, changed.path);
    const before = previous.find((object) => object.id === changed.id);
    if (!before || !isKind(before, "table")) continue;

    const script = generateAlter(before as Table, after, {
      qualifiedName: qualify(workspace.graph, after),
    });

    // A table whose YAML changed but whose *shape* did not, a description edit, a layout nudge
    //, produces no statements. Reporting it as a migration would cry wolf.
    if (script.changes.length === 0) continue;

    into.push({
      table: after.name,
      statements: script.statements,
      requiresRecreate: script.requiresRecreate,
    });
  }
}

/** `project.dataset.table`, falling back through the model's target to the bare name. */
function qualify(graph: ObjectGraph, table: Table): string {
  const model = table.model ? graph.modelNamed(table.model) : undefined;
  const target = (model as { target?: { project?: string; dataset?: string } } | undefined)?.target;

  return [table.project ?? target?.project, table.dataset ?? target?.dataset, table.name]
    .filter(Boolean)
    .join(".");
}

/**
 * The summary as a single line of prose.
 *
 * Shared by the webhook's Slack format and the delivery log, so the sentence a channel receives
 * and the sentence the UI shows are the same sentence, assembled once, here.
 */
export function summarySentence(summary: ChangeSummary): string {
  const { added, removed, modified, breaks } = summary.counts;

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (modified > 0) parts.push(`${modified} changed`);
  if (removed > 0) parts.push(`${removed} removed`);

  const what = parts.length > 0 ? parts.join(", ") : "no model objects touched";
  const consequence =
    breaks > 0
      ? `, ${breaks} downstream ${breaks === 1 ? "dependency breaks" : "dependencies break"}`
      : summary.migration.some((entry) => entry.requiresRecreate)
        ? ", needs a table rebuild"
        : summary.migration.length > 0
          ? ", needs a migration"
          : "";

  return `${what}${consequence}`;
}
