import { isKind, type ObjectGraph, type Mapping, type Table } from "@strata/metamodel";

/**
 * BigQuery cost advice, read off the model.
 *
 * The premise: this tool already knows the shape of every table *and* which pipelines read it, so
 * it can answer a question nobody else in the stack is positioned to answer, "which table is
 * about to cost real money, and why". A warehouse bill is dominated by full scans of large
 * unpartitioned tables, and that is a property of the model, visible before a single byte is
 * processed.
 *
 * This is deliberately advice, not validation. Every finding here is a *judgement about cost*,
 * and cost is contextual: a 400-row dimension needs no partition, and telling someone to add one
 * would be noise that teaches them to ignore the whole feature. So every rule below is gated on
 * evidence from the model rather than fired on every table, and each finding carries the reason
 * so it can be argued with.
 *
 * Nothing here queries BigQuery. It is static analysis, instant and free, and it runs on a model
 * that has never been deployed.
 */

export type AdviceSeverity =
  /** Costs money now, or will fail outright. */
  | "high"
  /** Worth doing, no urgency. */
  | "medium"
  /** A remark. */
  | "low";

export interface Advice {
  code: string;
  severity: AdviceSeverity;
  objectId: string;
  objectName: string;
  model?: string;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do about it. Absent when the answer is a judgement call rather than an action. */
  suggestion?: string;
  /** How many pipelines read this table. The multiplier on any scan cost. */
  readers?: number;
}

/** BigQuery partitions on these column types, and integer ranges. Nothing else is eligible. */
const TIME_TYPES = new Set(["DATE", "TIMESTAMP", "DATETIME"]);

/** BigQuery's hard limit. A fifth clustering column is a rejected DDL statement, not a warning. */
const MAX_CLUSTERING = 4;

/**
 * Tables big enough for partitioning to matter, by naming convention.
 *
 * Convention rather than row counts because the model has no row counts, it describes a schema,
 * not a database. `fct_`/`fact_` and `raw_`/`stg_` are the two families that grow without bound
 * in every warehouse this tool is aimed at; a `dim_` table usually does not, which is exactly why
 * suggesting a partition on every table would be noise.
 */
function looksLarge(name: string): boolean {
  return /^(fct|fact|raw|stg|staging|events?|log)[_.]/i.test(name);
}

function timeColumns(table: Table): string[] {
  return table.columns
    .filter((column) => TIME_TYPES.has((column.dataType ?? "").toUpperCase()))
    .map((column) => column.name);
}

/** How many mappings write to, or read from, each table. */
function readerCounts(graph: ObjectGraph): Map<string, number> {
  const counts = new Map<string, number>();

  for (const entry of graph.all()) {
    if (!isKind(entry.object, "mapping")) continue;
    const mapping = entry.object as Mapping;

    for (const source of mapping.sources ?? []) {
      const resolved = graph.resolve(source.ref, mapping.model ? { model: mapping.model } : {});
      const id = resolved?.target.object.id;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Every cost finding in the workspace, worst first.
 *
 * Ordered by severity then by reader count, because the thing worth fixing first is the expensive
 * table that the most pipelines scan, not the first one alphabetically.
 */
export function advise(graph: ObjectGraph, model?: string): Advice[] {
  const readers = readerCounts(graph);
  const findings: Advice[] = [];

  const tables = (model ? graph.inModel(model) : graph.all())
    .filter((entry) => isKind(entry.object, "table"))
    .map((entry) => entry.object as Table);

  for (const table of tables) {
    const reads = readers.get(table.id) ?? 0;
    const base = {
      objectId: table.id,
      objectName: table.name,
      ...(table.model ? { model: table.model } : {}),
      ...(reads > 0 ? { readers: reads } : {}),
    };

    // ---------------------------------------------------------- hard limits

    if (table.clustering.length > MAX_CLUSTERING) {
      /*
        Not advice, this DDL will be rejected.

        Included here rather than in validation because it is discovered by the same pass and an
        operator reading cost advice about clustering should not have to look somewhere else to
        learn that their clustering is invalid.
      */
      findings.push({
        ...base,
        code: "cost/tooManyClusteringColumns",
        severity: "high",
        message: `\`${table.name}\` declares ${table.clustering.length} clustering columns; BigQuery allows at most ${MAX_CLUSTERING}.`,
        suggestion: `Keep the ${MAX_CLUSTERING} most selective, in the order queries filter on them.`,
      });
    }

    // ---------------------------------------------------------- partitioning

    const partitionable = timeColumns(table);

    if (!table.partitioning && looksLarge(table.name)) {
      if (partitionable.length > 0) {
        findings.push({
          ...base,
          /*
            Severity rises with readership.

            An unpartitioned table nothing reads costs storage. One that four pipelines scan costs
            four full scans per run, which is the difference between a tidy-up and a bill.
          */
          severity: reads >= 2 ? "high" : "medium",
          code: "cost/noPartition",
          message:
            `\`${table.name}\` has no partitioning` +
            (reads > 0
              ? `, and ${reads} pipeline${reads === 1 ? " reads" : "s read"} it in full.`
              : "."),
          suggestion: `Partition by \`${partitionable[0]}\`, every query filtering on it then scans one partition instead of the table.`,
        });
      } else {
        findings.push({
          ...base,
          code: "cost/noPartitionCandidate",
          severity: "low",
          message: `\`${table.name}\` looks like a growing table but has no DATE, TIMESTAMP or DATETIME column to partition on.`,
          suggestion:
            "Add an ingestion or event timestamp, or partition by integer range on a bucketing key.",
        });
      }
    }

    /*
      `requireFilter` is the cheapest guard in BigQuery.

      A partition nobody filters on is a partition that does not save anything: the query scans
      every one. Requiring the filter converts a silent bill into a failed query, which is the
      error everybody wants, it fails in development rather than in the invoice.
    */
    if (table.partitioning && !table.partitioning.requireFilter && looksLarge(table.name)) {
      findings.push({
        ...base,
        code: "cost/partitionFilterNotRequired",
        severity: reads >= 2 ? "medium" : "low",
        message: `\`${table.name}\` is partitioned but does not require a partition filter, so a query that omits one scans everything.`,
        suggestion: "Set `partitioning.requireFilter: true`.",
      });
    }

    // ---------------------------------------------------------- clustering

    /*
      A fact with foreign keys and no clustering.

      Facts are joined and filtered on their keys, which is precisely what clustering accelerates,
      and the model already states which columns those are. Only suggested when the table has keys
      to cluster *on*, a suggestion that cannot be acted on is worse than silence.
    */
    const foreignKeyColumns = (table.foreignKeys ?? []).flatMap((key) => key.columns ?? []);

    if (
      table.clustering.length === 0 &&
      foreignKeyColumns.length > 0 &&
      looksLarge(table.name)
    ) {
      findings.push({
        ...base,
        code: "cost/noClustering",
        severity: "medium",
        message: `\`${table.name}\` joins on ${foreignKeyColumns.length} foreign key column(s) but is not clustered.`,
        suggestion: `Cluster by ${foreignKeyColumns
          .slice(0, MAX_CLUSTERING)
          .map((column) => `\`${column}\``)
          .join(", ")}, the columns queries filter and join on.`,
      });
    }

    /*
      Clustering on the partition column is close to pointless.

      The partition already segregates those values, so clustering repeats work the partition has
      done and spends one of only four clustering slots doing it.
    */
    const partitionField =
      table.partitioning && "field" in table.partitioning ? table.partitioning.field : undefined;

    if (partitionField && table.clustering.includes(partitionField)) {
      findings.push({
        ...base,
        code: "cost/clusteringOnPartitionColumn",
        severity: "low",
        message: `\`${table.name}\` clusters by \`${partitionField}\`, which is already its partition column.`,
        suggestion: `Spend that clustering slot on a column queries filter on *within* a partition.`,
      });
    }
  }

  const rank: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.readers ?? 0) - (a.readers ?? 0),
  );
}

/** Counts by severity, so a page can lead with the number that matters. */
export function adviceSummary(findings: readonly Advice[]): Record<AdviceSeverity, number> {
  const counts: Record<AdviceSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
