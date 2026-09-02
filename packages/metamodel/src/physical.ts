import { z } from "zod";
import {
  BaseObjectSchema,
  ClassificationSchema,
  type Classification,
  IdSchema,
  RefSchema,
} from "./common.js";

export const COLUMN_MODES = ["NULLABLE", "REQUIRED", "REPEATED"] as const;
export type ColumnMode = (typeof COLUMN_MODES)[number];

/**
 * A physical column.
 *
 * Columns nest: `STRUCT` columns carry `fields`, and `REPEATED` mode makes them
 * arrays. Modelling nested and repeated data properly is table stakes for
 * BigQuery and is exactly what relational-heritage tools get wrong, so it is
 * built into the shape here rather than approximated with flattened names.
 */
export interface Column {
  id: string;
  name: string;
  description?: string;
  /** Warehouse-native type, e.g. `STRING`, `NUMERIC(18, 2)`, `STRUCT`, `ARRAY<INT64>`. */
  dataType: string;
  mode: ColumnMode;
  /** Child fields for `STRUCT` / `RECORD` types. */
  fields?: Column[];
  /** Domain this column inherits its type and constraints from. */
  domain?: string;
  classification?: Classification;
  defaultValueExpression?: string;
  collation?: string;
  roundingMode?: string;
  /** Trace back to the logical attribute this column implements. */
  attributeRef?: string;
  tags: string[];
  properties: Record<string, unknown>;
  previousNames: string[];
}

export const ColumnSchema: z.ZodType<Column, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    dataType: z.string().min(1),
    mode: z.enum(COLUMN_MODES).default("NULLABLE"),
    fields: z.array(ColumnSchema).optional(),
    domain: RefSchema.optional(),
    classification: ClassificationSchema.optional(),
    defaultValueExpression: z.string().optional(),
    collation: z.string().optional(),
    roundingMode: z.string().optional(),
    attributeRef: RefSchema.optional(),
    tags: z.array(z.string()).default([]),
    properties: z.record(z.unknown()).default({}),
    previousNames: z.array(z.string()).default([]),
  }),
);

export const PartitioningSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("time"),
    /**
     * Column to partition by. Omit for ingestion-time partitioning, which
     * BigQuery exposes as the pseudo-column `_PARTITIONTIME`.
     */
    field: z.string().optional(),
    granularity: z.enum(["HOUR", "DAY", "MONTH", "YEAR"]).default("DAY"),
    expirationDays: z.number().positive().optional(),
    /**
     * Reject queries that do not filter on the partition column. Strongly
     * recommended for large facts, it is the single cheapest guard against
     * runaway scan costs.
     */
    requireFilter: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("integerRange"),
    field: z.string().min(1),
    start: z.number().int(),
    end: z.number().int(),
    interval: z.number().int().positive(),
    requireFilter: z.boolean().default(false),
  }),
]);
export type Partitioning = z.infer<typeof PartitioningSchema>;

/**
 * BigQuery does not enforce primary or foreign keys, they are declarative only.
 * That makes the model the only place the intent is recorded, and it is why we
 * compile these declarations into Dataform assertions: the model states the
 * rule, the assertion enforces it.
 */
export const ForeignKeySchema = z.object({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).min(1),
  references: z.object({
    table: RefSchema,
    columns: z.array(z.string().min(1)).min(1),
  }),
  /** Generate a referential-integrity assertion for this key. */
  assert: z.boolean().default(true),
  description: z.string().optional(),
});
export type ForeignKey = z.infer<typeof ForeignKeySchema>;

export const TableOptionsSchema = z.object({
  friendlyName: z.string().optional(),
  labels: z.record(z.string()).default({}),
  expirationDays: z.number().positive().optional(),
  kmsKeyName: z.string().optional(),
  /** Materialized view staleness tolerance, e.g. `INTERVAL 4 HOUR`. */
  maxStaleness: z.string().optional(),
  enableRefresh: z.boolean().optional(),
  refreshIntervalMinutes: z.number().positive().optional(),
});
export type TableOptions = z.infer<typeof TableOptionsSchema>;

export const DATAFORM_TYPES = [
  "table",
  "view",
  "incremental",
  "declaration",
  "operations",
  "assertion",
] as const;

/**
 * Generation hints for Dataform. Kept on the model, and therefore in git and
 * under review, rather than living as untracked settings in the tool.
 */
export const DataformConfigSchema = z.object({
  type: z.enum(DATAFORM_TYPES).optional(),
  tags: z.array(z.string()).default([]),
  disabled: z.boolean().optional(),
  /** Refuse to rebuild from scratch in production. */
  protected: z.boolean().optional(),
  /** Merge key for incremental models. */
  uniqueKey: z.array(z.string()).default([]),
  dependencies: z.array(RefSchema).default([]),
  preOperations: z.array(z.string()).default([]),
  postOperations: z.array(z.string()).default([]),
  /**
   * Path of the generated file relative to the Dataform repo root. When absent,
   * it is derived from the Dataform connection's own path template.
   */
  path: z.string().optional(),
});
export type DataformConfig = z.infer<typeof DataformConfigSchema>;

/**
 * A physical table, view or materialized view.
 *
 * `layer` is a free-form string rather than an enum on purpose: every
 * organisation names its warehouse layers differently (raw/staging/core/mart,
 * bronze/silver/gold, l0/l1/l2) and hard-coding ours would be the wrong kind of
 * opinion.
 */
export const TableSchema = BaseObjectSchema.extend({
  kind: z.literal("table"),

  project: z.string().optional(),
  /** Falls back to the model's default dataset when omitted. */
  dataset: z.string().optional(),
  objectType: z
    .enum(["table", "view", "materializedView", "external", "snapshot"])
    .default("table"),
  layer: z.string().optional(),
  subjectArea: RefSchema.optional(),

  /**
   * What one row of this table means.
   *
   * The single most useful sentence anyone can write about a table, and the one nobody
   * writes: "one row per customer per period of validity" answers most of the questions a
   * downstream analyst would otherwise ask in Slack.
   *
   * Added late, and the omission was silent in the worst way. The properties panel has
   * offered a Grain field all along, but the schema had no such key, so zod stripped it on
   * every save and the text vanished with no error. A field the form accepts and the schema
   * discards is worse than no field.
   */
  grain: z.string().optional(),

  columns: z.array(ColumnSchema).default([]),

  primaryKey: z.array(z.string()).default([]),
  uniqueKeys: z
    .array(
      z.object({
        name: z.string().min(1),
        columns: z.array(z.string().min(1)).min(1),
        assert: z.boolean().default(true),
      }),
    )
    .default([]),
  foreignKeys: z.array(ForeignKeySchema).default([]),

  partitioning: PartitioningSchema.optional(),
  /** BigQuery permits at most four clustering columns, order significant. */
  clustering: z.array(z.string()).default([]),

  options: TableOptionsSchema.default({}),

  /** SQL body for views and materialized views. */
  viewQuery: z.string().optional(),

  externalConfig: z
    .object({
      sourceFormat: z.string(),
      sourceUris: z.array(z.string()).default([]),
      autodetect: z.boolean().optional(),
      hivePartitioningMode: z.string().optional(),
      connectionId: z.string().optional(),
    })
    .optional(),

  dataform: DataformConfigSchema.default({}),

  /** Trace back to the logical entity this table implements. */
  entityRef: RefSchema.optional(),
});
export type Table = z.infer<typeof TableSchema>;

/** Fully qualified BigQuery name, using the model defaults passed in. */
export function qualifiedTableName(
  table: Table,
  defaults: { project?: string; dataset?: string } = {},
): string {
  const project = table.project ?? defaults.project;
  const dataset = table.dataset ?? defaults.dataset;
  const parts = [project, dataset, table.name].filter((p): p is string => Boolean(p));
  return parts.join(".");
}

/** Depth-first walk over a column tree, yielding each column with its dotted path. */
export function* walkColumns(
  columns: readonly Column[],
  prefix = "",
): Generator<{ column: Column; path: string; depth: number }> {
  for (const column of columns) {
    const path = prefix ? `${prefix}.${column.name}` : column.name;
    yield { column, path, depth: prefix ? prefix.split(".").length : 0 };
    if (column.fields?.length) {
      yield* walkColumns(column.fields, path);
    }
  }
}

/** Resolve a possibly-nested column by dotted path, e.g. `address.postcode`. */
export function findColumn(table: Table, path: string): Column | undefined {
  const segments = path.split(".");
  let pool: readonly Column[] | undefined = table.columns;
  let found: Column | undefined;
  for (const segment of segments) {
    if (!pool) return undefined;
    const lower = segment.toLowerCase();
    found = pool.find((c) => c.name.toLowerCase() === lower);
    if (!found) return undefined;
    pool = found.fields;
  }
  return found;
}
