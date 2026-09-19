import { emptyModel, type SourceColumn, type SourceEntity, type SourceModel, type SourceRelationship } from "./ir.js";

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

/** One row of `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`: a constrained column, primary or foreign. */
export interface BigQueryKeyRow {
  table_name: string;
  column_name: string;
  /** BigQuery names a primary key constraint `<table>.pk$`. Anything else is a foreign key. */
  constraint_name?: string | null;
  /** What orders a compound key. Without it a two-column key pairs arbitrarily. */
  ordinal_position?: number | string | null;
}

/**
 * One row of `INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE`: what a constraint points at.
 *
 * Kept separate from `BigQueryKeyRow` rather than joined in SQL. Joining the two views on
 * `constraint_name` multiplies a two-column key into four rows, and a reader that believed the
 * result would report a compound key as each column twice.
 */
export interface BigQueryConstraintRow {
  constraint_name: string;
  /** The referenced table, for a foreign key. */
  table_name: string;
  column_name?: string | null;
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

/** BigQuery names a primary key constraint `<table>.pk$`. Everything else is a foreign key. */
function isPrimaryKeyConstraint(constraint: string | undefined): boolean {
  return !constraint || /\bpk\$?$/i.test(constraint);
}

/**
 * Each table's declared primary key, in the order the columns were declared.
 *
 * Ordered rather than a set, because the order is what pairs a compound foreign key with what it
 * points at. `INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE` records no ordinal position, so the
 * referenced table's own key is the only thing that says which column matches which.
 */
function primaryKeysOf(keys: readonly BigQueryKeyRow[]): Map<string, string[]> {
  const out = new Map<string, { column: string; at: number }[]>();

  for (const row of keys) {
    const table = text(row.table_name);
    const column = text(row.column_name);
    if (!table || !column) continue;

    // Treating a foreign key or a uniqueness constraint as the primary key would be wrong in a
    // way that silently changes the grain.
    if (!isPrimaryKeyConstraint(text(row.constraint_name))) continue;

    const bucket = out.get(table.toLowerCase()) ?? [];
    if (!bucket.some((entry) => entry.column === column.toLowerCase())) {
      bucket.push({ column: column.toLowerCase(), at: ordinal(row.ordinal_position) });
    }
    out.set(table.toLowerCase(), bucket);
  }

  return new Map(
    [...out].map(([table, entries]) => [
      table,
      entries.sort((a, b) => a.at - b.at).map((entry) => entry.column),
    ]),
  );
}

/**
 * Declared foreign keys, as relationships.
 *
 * This is the half the importer used to throw away, and the cost of that was not obvious. A model
 * imported without it has primary keys and no joins, which looks complete: every table is there,
 * every column is there, and the diagram is a field of islands nobody reads as an error. What it
 * costs downstream is the whole point of the thing. truegrain derives grain from the primary key
 * and derives joins from the relationships, so a model with no relationships cannot be told that
 * joining `order_lines` repeats every `orders` row, and a sum over it is silently inflated.
 *
 * The pairing is the part to get right. `KEY_COLUMN_USAGE` orders the referencing columns;
 * `CONSTRAINT_COLUMN_USAGE` names the referenced table but records no ordinal, so its rows cannot
 * be zipped against the first list. BigQuery requires a foreign key to reference the parent's
 * primary key, so that key, in its own declared order, is the pairing. When the two do not agree
 * the relationship is reported and left out: a join with its columns crossed runs, returns rows,
 * and returns the wrong ones, which is worse than no join at all.
 */
function foreignKeysOf(
  keys: readonly BigQueryKeyRow[],
  constraints: readonly BigQueryConstraintRow[],
  primaryKeys: Map<string, string[]>,
): { relationships: SourceRelationship[]; unpaired: string[] } {
  const referencedTable = new Map<string, string>();
  for (const row of constraints) {
    const constraint = text(row.constraint_name);
    const table = text(row.table_name);
    if (constraint && table && !referencedTable.has(constraint)) referencedTable.set(constraint, table);
  }

  const byConstraint = new Map<string, { table: string; column: string; at: number }[]>();
  for (const row of keys) {
    const constraint = text(row.constraint_name);
    const table = text(row.table_name);
    const column = text(row.column_name);
    if (!constraint || !table || !column || isPrimaryKeyConstraint(constraint)) continue;

    const bucket = byConstraint.get(constraint) ?? [];
    bucket.push({ table, column, at: ordinal(row.ordinal_position) });
    byConstraint.set(constraint, bucket);
  }

  const relationships: SourceRelationship[] = [];
  const unpaired: string[] = [];

  for (const [constraint, rows] of [...byConstraint].sort(([a], [b]) => a.localeCompare(b))) {
    const parent = referencedTable.get(constraint);
    if (!parent) continue;

    const ordered = [...rows].sort((a, b) => a.at - b.at);
    const child = ordered[0]!.table;
    const childColumns = ordered.map((row) => row.column);
    const parentColumns = primaryKeys.get(parent.toLowerCase()) ?? [];

    if (parentColumns.length !== childColumns.length) {
      unpaired.push(constraint);
      continue;
    }

    const childKey = primaryKeys.get(child.toLowerCase()) ?? [];
    relationships.push({
      name: constraint.includes(".") ? constraint.slice(constraint.indexOf(".") + 1) : constraint,
      parent,
      child,
      // The child holds the foreign key, so the child is the many side.
      cardinality: "many-to-one",
      // Identifying when the foreign key is part of the child's own key, which is what makes
      // `order_lines` a child of `orders` rather than merely a table pointing at it.
      identifying:
        childKey.length > 0 && childColumns.every((column) => childKey.includes(column.toLowerCase())),
      parentColumns,
      childColumns,
    });
  }

  return { relationships, unpaired };
}

export function readBigQuery(
  columns: readonly BigQueryColumnRow[],
  keys: readonly BigQueryKeyRow[] = [],
  constraints: readonly BigQueryConstraintRow[] = [],
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
  const primaryKeys = primaryKeysOf(keys);

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

      if (pk?.includes(name.toLowerCase())) column.isPrimaryKey = true;

      const description = text(row.description);
      if (description) column.description = description;

      if (isNested(dataType)) nested += 1;

      entity.columns.push(column);
    }

    model.entities.push(entity);
  }

  const known = new Set(byTable.keys());
  const { relationships, unpaired } = foreignKeysOf(keys, constraints, primaryKeys);
  for (const relationship of relationships) {
    // A key pointing outside what was imported has nothing to attach to, and a relationship
    // naming an entity that is not here fails validation with a message about the wrong thing.
    if (!known.has(relationship.parent.toLowerCase()) || !known.has(relationship.child.toLowerCase())) {
      continue;
    }
    model.relationships.push(relationship);
  }

  if (unpaired.length > 0) {
    model.diagnostics.push({
      severity: "warning",
      code: "import/unpairableForeignKey",
      message:
        `${unpaired.join(", ")} could not be paired with the referenced table's primary key, so ` +
        "the relationship was left out. Draw it by hand: a join with its columns crossed runs " +
        "and returns the wrong rows.",
    });
  }

  if (model.relationships.length === 0 && model.entities.length > 1) {
    model.diagnostics.push({
      severity: "warning",
      code: "import/noRelationships",
      message:
        "no foreign keys are declared in this dataset, so nothing can be joined. Draw the " +
        "relationships before generating, or a downstream engine cannot tell that a join " +
        "repeats rows and inflates a sum.",
    });
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
    SELECT table_name, column_name, constraint_name, ordinal_position
    FROM \`${dataset}\`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    ORDER BY constraint_name, ordinal_position
  `.trim();
}

/**
 * What each constraint points at.
 *
 * A second query rather than a join onto `keysQuery`. `CONSTRAINT_COLUMN_USAGE` has one row per
 * referenced column and no ordinal position, so joining the two views on `constraint_name` turns
 * a two-column key into four rows: the referencing columns are each repeated once per referenced
 * column. The reader pairs them instead, using the referenced table's own key order.
 */
export function constraintsQuery(dataset: string): string {
  return `
    SELECT constraint_name, table_name, column_name
    FROM \`${dataset}\`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
    ORDER BY constraint_name
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
