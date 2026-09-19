import { z } from "zod";
import { BaseObjectSchema, RefSchema } from "./common.js";

/**
 * Source-to-target mappings.
 *
 * This is the load-bearing object for pipeline generation. A mapping says "this
 * target table is built from these sources, column by column, using this load
 * strategy", and that is precisely enough information to emit Dataform SQLX.
 *
 * It is also how the three tiers connect in practice: a realistic warehouse is a
 * chain of physical models (staging, core, marts) descending from one logical
 * model, and the mappings between them are the actual deliverable. Model the
 * mappings and the pipelines become a byproduct rather than hand-written drift.
 */

export const LOAD_STRATEGIES = [
  /** Replace the target entirely on each run. */
  "full",
  /** Append new rows, no update. */
  "append",
  /** Insert new and update changed rows via MERGE. */
  "merge",
  /** Dimension overwrite in place, history is not kept. */
  "scd1",
  /** Dimension history via valid_from / valid_to / is_current rows. */
  "scd2",
  /** Dimension history via previous-value columns. */
  "scd3",
  /** Incremental fact load filtered on a watermark column. */
  "incremental",
  /**
   * A dated full copy of the source, one per run, partitioned on the snapshot date.
   *
   * The pattern people reach for when a source has no reliable change signal and no
   * usable watermark, a vendor extract, a system that mutates rows in place without
   * touching an `updated_at`. Instead of trying to detect change, keep every copy and let
   * the reader pick a date. Cheap to reason about, expensive to store, and correct when
   * the alternative is guessing.
   *
   * Distinct from `scd2`: SCD2 stores *transitions* and is exact about when a value
   * changed; a snapshot stores *observations* and can only tell you what was true on the
   * days you looked.
   */
  "snapshot",
  /** A declaration only, the table is produced outside this pipeline. */
  "declaration",
] as const;
export const LoadStrategySchema = z.enum(LOAD_STRATEGIES);
export type LoadStrategy = z.infer<typeof LoadStrategySchema>;

export const ColumnMappingSchema = z.object({
  /** Target column name, dotted for nested targets. */
  target: z.string().min(1),
  /** Source columns feeding this target, as `source_alias.column`. */
  sources: z.array(z.string()).default([]),
  /**
   * SQL expression producing the target value. When absent and exactly one
   * source is given, the mapping is a straight passthrough.
   */
  expression: z.string().optional(),
  /** Prose description of the business rule, for the mapping document. */
  rule: z.string().optional(),
  /**
   * For SCD2 dimensions: include this column in the change-detection hash.
   * Columns excluded here update in place without opening a new row version.
   */
  trackChanges: z.boolean().optional(),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

export const MappingSourceSchema = z.object({
  /** Table or entity this source refers to. */
  ref: RefSchema,
  /** Alias used in expressions and join conditions. */
  alias: z.string().min(1),
  /** How this source joins to the ones before it. First source needs no join. */
  join: z
    .object({
      type: z.enum(["inner", "left", "right", "full", "cross"]).default("left"),
      on: z.string().min(1),
    })
    .optional(),
  /** Row filter applied to this source. */
  filter: z.string().optional(),
});
export type MappingSource = z.infer<typeof MappingSourceSchema>;

/**
 * Dimensional modelling configuration.
 *
 * Hand-writing SCD2 merge logic is where data teams reliably lose weeks, and
 * where the bugs are subtle and expensive. Templating it from a declaration is
 * the highest-leverage generation this tool does.
 */
export const DimensionalConfigSchema = z.object({
  role: z.enum(["dimension", "fact", "bridge", "aggregate", "junk", "outrigger"]).optional(),

  /** Natural key columns from the source that identify the business entity. */
  businessKey: z.array(z.string()).default([]),
  /** Surrogate key column on the target. */
  surrogateKey: z.string().optional(),
  /**
   * How the surrogate key is produced. `hash` uses FARM_FINGERPRINT over the
   * business key, which is deterministic and therefore reproducible across
   * environments, usually what you want in BigQuery.
   */
  surrogateKeyStrategy: z.enum(["hash", "uuid", "rowNumber", "sourceProvided"]).default("hash"),

  /** SCD2 validity columns. */
  validFromColumn: z.string().optional(),
  validToColumn: z.string().optional(),
  currentFlagColumn: z.string().optional(),
  versionColumn: z.string().optional(),
  /** Column holding the change-detection hash. */
  hashColumn: z.string().optional(),

  /** Fact-specific: watermark column for incremental loads. */
  watermarkColumn: z.string().optional(),
  /**
   * The date each `snapshot` copy is stamped with, and partitioned on.
   *
   * Named rather than assumed, because it becomes part of the table's grain: every query
   * against a snapshot table has to filter on it, and a team that already calls it
   * `as_of_date` should not have to rename their column to satisfy the generator.
   */
  snapshotDateColumn: z.string().optional(),
  /** How far back to re-process on each incremental run, guarding late arrivals. */
  lookbackDays: z.number().int().nonnegative().optional(),

  /**
   * Dimension references this fact resolves to surrogate keys, as
   * `fact_column -> dimension_ref`.
   */
  dimensionLookups: z
    .array(
      z.object({
        column: z.string().min(1),
        dimension: RefSchema,
        /** Business key column on the fact used to look the dimension up. */
        sourceColumn: z.string().min(1),
        /** Surrogate key value used when the lookup misses. */
        unknownMemberKey: z.union([z.string(), z.number()]).optional(),
        /** Join on the dimension row valid at the fact's event time. */
        pointInTime: z.boolean().default(false),
      }),
    )
    .default([]),

  /**
   * Marks this dimension as conformed, meaning it is shared across marts. The
   * linter enforces that no mart forks a conformed dimension, which is the
   * governance rule dimensional warehouses most often violate.
   */
  conformed: z.boolean().optional(),
  /** Registry name a conformed dimension is registered under. */
  conformedAs: z.string().optional(),
});
export type DimensionalConfig = z.infer<typeof DimensionalConfigSchema>;

export const MappingSchema = BaseObjectSchema.extend({
  kind: z.literal("mapping"),

  /** The table (or logical entity) this mapping produces. */
  target: RefSchema,
  sources: z.array(MappingSourceSchema).default([]),

  loadStrategy: LoadStrategySchema.default("full"),
  columnMappings: z.array(ColumnMappingSchema).default([]),

  /** Filter applied after joins, as a SQL boolean expression. */
  having: z.string().optional(),
  /** GROUP BY columns, for aggregate targets. */
  groupBy: z.array(z.string()).default([]),
  /** Extra WHERE clause applied to the whole mapping. */
  where: z.string().optional(),

  dimensional: DimensionalConfigSchema.optional(),

  /**
   * Free SQL that replaces generated body entirely. An escape hatch for logic the
   * declarative form cannot express, we would rather users stay in the tool with
   * a hand-written query than leave it altogether.
   */
  customSql: z.string().optional(),

  /** Which layer transition this represents, e.g. `staging -> core`. */
  stage: z.string().optional(),
});
export type Mapping = z.infer<typeof MappingSchema>;

/** Column mappings that participate in SCD2 change detection. */
export function changeTrackedColumns(mapping: Mapping): string[] {
  const explicit = mapping.columnMappings.filter((cm) => cm.trackChanges === true);
  if (explicit.length > 0) return explicit.map((cm) => cm.target);

  // Default: everything except keys, surrogate keys and audit columns.
  const dim = mapping.dimensional;
  const excluded = new Set<string>(
    [
      ...(dim?.businessKey ?? []),
      dim?.surrogateKey,
      dim?.validFromColumn,
      dim?.validToColumn,
      dim?.currentFlagColumn,
      dim?.versionColumn,
      dim?.hashColumn,
    ].filter((v): v is string => Boolean(v)),
  );
  return mapping.columnMappings
    .filter((cm) => cm.trackChanges !== false && !excluded.has(cm.target))
    .map((cm) => cm.target);
}

/** True when the strategy keeps historical row versions. */
export function keepsHistory(strategy: LoadStrategy): boolean {
  return strategy === "scd2" || strategy === "scd3" || strategy === "append";
}
