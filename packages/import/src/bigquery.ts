import { emptyModel, type SourceColumn, type SourceEntity, type SourceModel } from "./ir.js";

/**
 * Read a live BigQuery dataset, via `INFORMATION_SCHEMA`.
 *
 * **The feature the README listed as not built, assembled from parts that already were.** Three
 * readers already turn something into a `SourceModel`, and `mapToObjects` already turns that into
 * objects, with preview, collision detection, diagnostics and propose-as-a-pull-request behind
 * it. None of that needed changing. Reverse engineering a warehouse was never a subsystem, it was
 * a fourth reader nobody had written, and the "not built" label made it look like far more.
 *
 * **Pure, and takes rows rather than credentials.** The other three readers take text and make no
 * network call, which is what makes them testable without a fixture server. This one keeps that
 * property: the caller runs the query and hands over the rows. The query itself belongs on the
 * server, where a service account and a token exchange already exist, so nothing here has to know
 * how Google authenticates and this package gains no dependency.
 *
 * **What it deliberately does not do.** `INFORMATION_SCHEMA.COLUMNS` reports top-level columns
 * only, and gives a nested column's shape as a type string, `STRUCT<id INT64, name STRING>`,
 * rather than as a tree. That string is carried through verbatim, which is correct BigQuery and
 * round-trips into DDL, but it is not the same as the `fields` tree the metamodel can hold. The
 * difference is reported rather than papered over, on the same reasoning the lineage view reports
 * `customSql` as opaque: a gap that looks like an answer is worse than one that admits itself.
 */

/** One row of `INFORMATION_SCHEMA.COLUMNS`, joined to `TABLES` for the table's own metadata. */
export interface BigQueryColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  /** `YES` or `NO`, as BigQuery spells it. */
  is_nullable?: string | null;
  ordinal_position?: number | string | null;
  /** The dataset. `table_schema` is the standard's name for it. */
  table_schema?: string | null;
  /** `BASE TABLE`, `VIEW`, `MATERIALIZED VIEW`, `EXTERNAL`. */
  table_type?: string | null;
  description?: string | null;
  table_description?: string | null;
}

/** One row of `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`, for declared primary keys. */
export interface BigQueryKeyRow {
  table_name: string;
  column_name: string;
  /** BigQuery names a primary key constraint `<table>.pk$`. */
  constraint_name?: string | null;
}

export interface BigQueryReadOptions {
  /** Dataset the rows came from, used to name the model when the rows do not say. */
  dataset?: string;
}

/** BigQuery spells absence several ways depending on how the row arrived. */
function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ordinal(value: unknown): number {
  const parsed = Number(value);
  // Unordered rows sort last rather than first, so a missing ordinal cannot silently
  // reorder the columns of a table whose other rows are numbered correctly.
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

/** True for a type whose shape `INFORMATION_SCHEMA.COLUMNS` reports as a string, not a tree. */
function isNested(dataType: string): boolean {
  return /^(struct|array|record)\s*[<(]/i.test(dataType.trim());
}

export function readBigQuery(
  columns: readonly BigQueryColumnRow[],
  keys: readonly BigQueryKeyRow[] = [],
  options: BigQueryReadOptions = {},
): SourceModel {
  const model = emptyModel("bigquery");
  // A warehouse read back is a physical model by definition: these are real tables with real
  // warehouse types, and classifying them as logical would discard the types on the way in.
  model.tier = "physical";
  if (options.dataset) model.name = options.dataset;

  /*
    Primary keys first, so a column can be marked as it is built.

    Declared rather than enforced, in BigQuery's own words, which is exactly why reading them
    matters: the declaration is the only record that the intent ever existed, and it is the thing
    this tool turns into an assertion. Dropping it on import would lose the one piece of
    information the warehouse cannot enforce for itself.
  */
  const primaryKeys = new Map<string, Set<string>>();
  for (const row of keys) {
    const table = text(row.table_name);
    const column = text(row.column_name);
    if (!table || !column) continue;

    // BigQuery names the primary key constraint `<table>.pk$`. Anything else is a foreign key or
    // a uniqueness constraint, and treating those as the primary key would be wrong in a way that
    // silently changes the grain.
    const constraint = text(row.constraint_name);
    if (constraint && !/\bpk\$?$/i.test(constraint)) continue;

    const bucket = primaryKeys.get(table.toLowerCase());
    if (bucket) bucket.add(column.toLowerCase());
    else primaryKeys.set(table.toLowerCase(), new Set([column.toLowerCase()]));
  }

  const byTable = new Map<string, { entity: SourceEntity; rows: BigQueryColumnRow[] }>();
  let skipped = 0;

  for (const row of columns) {
    const tableName = text(row.table_name);
    const columnName = text(row.column_name);

    if (!tableName || !columnName) {
      skipped += 1;
      continue;
    }

    const key = tableName.toLowerCase();
    let entry = byTable.get(key);
    if (!entry) {
      const entity: SourceEntity = { name: tableName, columns: [] };
      const dataset = text(row.table_schema) ?? options.dataset;
      if (dataset) entity.schema = dataset;
      const description = text(row.table_description);
      if (description) entity.description = description;

      entry = { entity, rows: [] };
      byTable.set(key, entry);
    }
    entry.rows.push(row);
  }

  if (byTable.size === 0) {
    model.diagnostics.push({
      severity: "error",
      code: "import/emptyDataset",
      message: options.dataset
        ? `\`${options.dataset}\` returned no columns. It may be empty, or the credential may not be able to see it.`
        : "the query returned no columns",
    });
    return model;
  }

  let nested = 0;
  const views: string[] = [];

  for (const { entity, rows } of byTable.values()) {
    const pk = primaryKeys.get(entity.name.toLowerCase());

    // A view's own columns are worth importing; the fact that it is a view is worth saying.
    const tableType = rows.map((row) => text(row.table_type)).find(Boolean);
    if (tableType && !/^base table$/i.test(tableType)) views.push(`${entity.name} (${tableType})`);

    for (const row of [...rows].sort((a, b) => ordinal(a.ordinal_position) - ordinal(b.ordinal_position))) {
      const name = text(row.column_name)!;
      const dataType = text(row.data_type) ?? "STRING";

      const column: SourceColumn = { name, type: dataType };

      /*
        `is_nullable` is `NO` for a required column. Tested for explicitly rather than by
        truthiness, because the string `"NO"` is truthy and the obvious mistake here inverts every
        nullability in the warehouse without failing anything.
      */
      const nullable = text(row.is_nullable);
      if (nullable) column.required = /^no$/i.test(nullable);

      if (pk?.has(name.toLowerCase())) column.isPrimaryKey = true;

      const description = text(row.description);
      if (description) column.description = description;

      if (isNested(dataType)) nested += 1;

      entity.columns.push(column);
    }

    model.entities.push(entity);
  }

  if (skipped > 0) {
    model.diagnostics.push({
      severity: "warning",
      code: "import/rowIncomplete",
      message: `${skipped} row(s) had no table or column name and were ignored`,
    });
  }

  if (nested > 0) {
    model.diagnostics.push({
      severity: "info",
      code: "import/nestedAsType",
      message:
        `${nested} nested column(s) were imported with their full type text, e.g. ` +
        "`STRUCT<...>`, rather than as a field tree. The type is correct and generates valid " +
        "DDL; editing the individual fields in the UI will not work until they are expanded.",
    });
  }

  if (views.length > 0) {
    model.diagnostics.push({
      severity: "info",
      code: "import/viewAsTable",
      message:
        `imported as tables, because the importer does not carry a view's query: ${views.join(", ")}. ` +
        "Set the object type and add the SQL afterwards if you need them to regenerate.",
    });
  }

  return model;
}

/**
 * The query behind the reader.
 *
 * Here rather than on the server because it is part of what this reader *is*: change the shape of
 * the projection and `BigQueryColumnRow` changes with it, and keeping the two together means
 * they cannot drift apart across a package boundary.
 *
 * Region-qualified, because `INFORMATION_SCHEMA` is per region and a dataset in `EU` is invisible
 * to a query that does not say so. The dataset is interpolated into a query string, so it is
 * validated by the caller before it gets here: see `assertDatasetId`.
 */
export function columnsQuery(dataset: string): string {
  return `
    SELECT
      c.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.ordinal_position,
      c.table_schema,
      t.table_type,
      f.description        AS description,
      o.option_value       AS table_description
    FROM \`${dataset}\`.INFORMATION_SCHEMA.COLUMNS AS c
    LEFT JOIN \`${dataset}\`.INFORMATION_SCHEMA.TABLES AS t
      ON t.table_name = c.table_name
    LEFT JOIN \`${dataset}\`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS AS f
      ON f.table_name = c.table_name AND f.field_path = c.column_name
    LEFT JOIN \`${dataset}\`.INFORMATION_SCHEMA.TABLE_OPTIONS AS o
      ON o.table_name = c.table_name AND o.option_name = 'description'
    ORDER BY c.table_name, c.ordinal_position
  `.trim();
}

/** Declared primary keys. Separate because not every project has the constraint views. */
export function keysQuery(dataset: string): string {
  return `
    SELECT table_name, column_name, constraint_name
    FROM \`${dataset}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    ORDER BY table_name, ordinal_position
  `.trim();
}

/**
 * Refuse anything that is not a plain dataset identifier.
 *
 * The dataset reaches a query as text, so this is the trust boundary, and BigQuery's own
 * quoting is not a defence: a backtick in the value closes the one this builds. Google's rules
 * for a dataset id are letters, digits and underscores, optionally qualified by a project, whose
 * ids additionally allow hyphens. Nothing legitimate needs a character outside that, so an
 * allowlist costs no real input and a denylist would be a guess.
 */
export function assertDatasetId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_]+)?$/.test(trimmed)) {
    throw new Error(
      "a dataset is `dataset` or `project.dataset`, using letters, digits, underscores and hyphens only",
    );
  }
  return trimmed;
}
