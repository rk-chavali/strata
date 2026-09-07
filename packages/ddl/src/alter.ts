import { walkColumns, type Column, type Table } from "@strata/metamodel";

/**
 * The DDL that migrates one table's shape into another's.
 *
 * This is the second half of a compare: the first tells you two things differ, this tells you
 * what to run. It is also what makes a model authoritative rather than decorative, a model you
 * cannot deploy from is documentation.
 *
 * **The whole difficulty is that BigQuery's `ALTER TABLE` is narrow.** It will add a column and
 * drop one; it will widen a type but never narrow it; it will drop `NOT NULL` but never add it;
 * and it will not touch partitioning or clustering at all. A generator that emitted the obvious
 * statement for every difference would produce scripts that fail halfway, leaving a table
 * half-migrated, which is worse than refusing, because the operator now has to work out what
 * did and did not run.
 *
 * So every change is classified before anything is emitted:
 *
 *   - `supported`, a statement BigQuery will accept.
 *   - `recreate`, impossible in place. Emitted as a comment explaining why, never as SQL.
 *   - `lossy`, accepted, but data may be lost. Emitted, commented, and flagged.
 *
 * Nothing in the `recreate` class is ever emitted as runnable SQL. A migration you must not run
 * unattended should not look like one you can.
 */

export type ChangeSeverity = "supported" | "lossy" | "recreate";

export interface AlterChange {
  /** Stable machine-readable code, e.g. `column/add` or `partitioning/changed`. */
  code: string;
  severity: ChangeSeverity;
  /** Dotted column path when the change is below table level. */
  column?: string;
  /** One sentence for a person. */
  message: string;
  /** The statement to run. Absent for `recreate`, where there is nothing safe to run. */
  sql?: string;
}

export interface AlterScript {
  table: string;
  changes: AlterChange[];
  /** The runnable statements, in dependency order. Empty when everything needs a recreate. */
  statements: string[];
  /** True when any change cannot be done in place, the table must be rebuilt. */
  requiresRecreate: boolean;
}

/**
 * Type conversions BigQuery will perform in place.
 *
 * Only widening, and only these pairs, the list is BigQuery's, not ours, and it is short. Any
 * other change of type needs the table rebuilt, which is why the default is to refuse.
 *
 * Keyed `from -> to`. `NUMERIC -> BIGNUMERIC` widens precision; the reverse does not exist.
 */
const WIDENING: Record<string, readonly string[]> = {
  INT64: ["NUMERIC", "BIGNUMERIC", "FLOAT64"],
  NUMERIC: ["BIGNUMERIC", "FLOAT64"],
  BIGNUMERIC: ["FLOAT64"],
  DATE: ["DATETIME"],
  DATETIME: ["TIMESTAMP"],
};

/** The parameterless head of a type: `NUMERIC(18, 2)` → `NUMERIC`. */
function baseType(dataType: string): string {
  const at = dataType.indexOf("(");
  return (at === -1 ? dataType : dataType.slice(0, at)).trim().toUpperCase();
}

/** Whether BigQuery will convert `from` to `to` with an `ALTER COLUMN SET DATA TYPE`. */
export function isWidening(from: string, to: string): boolean {
  const left = baseType(from);
  const right = baseType(to);
  if (left === right) {
    /**
     * Same base type, different parameters.
     *
     * `NUMERIC(9, 2)` to `NUMERIC(18, 2)` is a widening BigQuery allows; the reverse is not.
     * Comparing the parameters properly means parsing them, and precision alone is not enough, * scale has to grow too, or the same number no longer fits.
     */
     return widerParameters(from, to);
  }
  return (WIDENING[left] ?? []).includes(right);
}

/** `NUMERIC(9, 2)` → `[9, 2]`. Undefined when the type carries no parameters. */
function parameters(dataType: string): [number, number] | undefined {
  const match = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(dataType);
  if (!match) return undefined;
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

function widerParameters(from: string, to: string): boolean {
  const before = parameters(from);
  const after = parameters(to);

  // No parameters on either side means the types are identical, which is not a change at all.
  if (!before && !after) return false;
  // Adding parameters to an unparameterised type narrows it: `NUMERIC` holds more than
  // `NUMERIC(9, 2)`.
  if (!before) return false;
  // Removing them widens to the type's full range.
  if (!after) return true;

  const [precisionBefore, scaleBefore] = before;
  const [precisionAfter, scaleAfter] = after;

  /**
   * Both the integer part and the scale must grow, or at least not shrink.
   *
   * `NUMERIC(9, 2)` to `NUMERIC(10, 4)` looks wider, the precision went up, but the integer
   * digits went from 7 to 6, so `12345678.90` no longer fits. Comparing precision alone would
   * call that a widening and generate a statement BigQuery rejects.
   */
  return (
    precisionAfter - scaleAfter >= precisionBefore - scaleBefore && scaleAfter >= scaleBefore
  );
}

export interface AlterOptions {
  /** Fully qualified name to use in the statements, e.g. `proj.dataset.table`. */
  qualifiedName: string;
  /**
   * Emit `DROP COLUMN` for columns absent from the target.
   *
   * Off by default, and that default is the important one: a column missing from the model is
   * far more often a model that has not caught up than a column somebody wants deleted, and
   * `DROP COLUMN` is irreversible. Dropping is opt-in per migration.
   */
  dropColumns?: boolean;
}

/**
 * Compare two versions of a table and produce the migration.
 *
 * `from` is the current shape, typically what the warehouse has, and `to` is the desired one,
 * from the model. Column identity is by name: BigQuery has no column ids, so a rename is
 * indistinguishable from a drop plus an add and is reported as both. That is the honest reading,
 * and the alternative, guessing at renames from type similarity, would occasionally emit a
 * `RENAME COLUMN` that silently discarded a real column's data.
 */
export function generateAlter(from: Table, to: Table, options: AlterOptions): AlterScript {
  const changes: AlterChange[] = [];
  const name = quoted(options.qualifiedName);

  const before = flatten(from);
  const after = flatten(to);

  // ------------------------------------------------------------ columns

  for (const [path, column] of after) {
    const existing = before.get(path);

    if (!existing) {
      if (path.includes(".")) {
        /**
         * A new field inside a STRUCT.
         *
         * BigQuery cannot add one: `ALTER TABLE ADD COLUMN` only takes a top-level column, and a
         * struct's shape is part of its column's type. Changing it means setting the whole
         * column's data type, which is not a widening, which means a rebuild.
         */
        changes.push({
          code: "field/add",
          severity: "recreate",
          column: path,
          message: `\`${path}\` is a new field inside a STRUCT. BigQuery cannot add a field to an existing STRUCT column in place, the table must be rebuilt.`,
        });
        continue;
      }

      /**
       * A new required column cannot be added.
       *
       * BigQuery rejects `ADD COLUMN ... NOT NULL` because the existing rows would violate it
       * immediately. Emitting it nullable and noting the discrepancy is the useful thing: the
       * column arrives, and the operator is told the constraint did not.
       */
      if (column.mode === "REQUIRED") {
        changes.push({
          code: "column/addRequired",
          severity: "lossy",
          column: path,
          message: `\`${path}\` is REQUIRED in the model, but BigQuery cannot add a NOT NULL column to a table that already has rows. Added as NULLABLE, backfill it, then add the constraint by rebuilding.`,
          sql: `ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS ${columnClause({ ...column, mode: "NULLABLE" })};`,
        });
        continue;
      }

      changes.push({
        code: "column/add",
        severity: "supported",
        column: path,
        message: `Add \`${path}\`.`,
        sql: `ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS ${columnClause(column)};`,
      });
      continue;
    }

    // ---------------------------------------------------------- type

    if (normaliseType(existing) !== normaliseType(column)) {
      if (existing.mode === "REPEATED" || column.mode === "REPEATED") {
        changes.push({
          code: "column/repeatedChanged",
          severity: "recreate",
          column: path,
          message: `\`${path}\` changes between a repeated and a non-repeated type (${describe(existing)} → ${describe(column)}). BigQuery cannot alter that in place.`,
        });
      } else if (isWidening(existing.dataType, column.dataType)) {
        changes.push({
          code: "column/widen",
          severity: "supported",
          column: path,
          message: `Widen \`${path}\` from ${existing.dataType} to ${column.dataType}.`,
          sql: `ALTER TABLE ${name} ALTER COLUMN ${ident(path)} SET DATA TYPE ${column.dataType};`,
        });
      } else {
        changes.push({
          code: "column/typeChanged",
          severity: "recreate",
          column: path,
          message: `\`${path}\` changes from ${describe(existing)} to ${describe(column)}, which is not a widening BigQuery permits. The table must be rebuilt, or the column copied through a new one.`,
        });
      }
    }

    // ---------------------------------------------------------- nullability

    if (existing.mode !== column.mode && existing.mode !== "REPEATED" && column.mode !== "REPEATED") {
      if (existing.mode === "REQUIRED" && column.mode === "NULLABLE") {
        changes.push({
          code: "column/dropNotNull",
          severity: "supported",
          column: path,
          message: `\`${path}\` becomes nullable.`,
          sql: `ALTER TABLE ${name} ALTER COLUMN ${ident(path)} DROP NOT NULL;`,
        });
      } else {
        /**
         * Making an existing column `NOT NULL` is not expressible.
         *
         * BigQuery has no `SET NOT NULL`. The only route is a rebuild, and it will fail unless
         * every existing row already has a value, which is worth saying, because "add the
         * constraint" and "backfill the data" are two jobs and only one of them is DDL.
         */
        changes.push({
          code: "column/addNotNull",
          severity: "recreate",
          column: path,
          message: `\`${path}\` becomes REQUIRED. BigQuery has no way to add NOT NULL to an existing column, rebuild the table, and only after confirming no row holds a NULL.`,
        });
      }
    }

    // ---------------------------------------------------------- description

    if ((existing.description ?? "") !== (column.description ?? "")) {
      changes.push({
        code: "column/description",
        severity: "supported",
        column: path,
        message: `Update the description of \`${path}\`.`,
        sql: `ALTER TABLE ${name} ALTER COLUMN ${ident(path)} SET OPTIONS(description = ${literal(column.description ?? "")});`,
      });
    }
  }

  // ---------------------------------------------------------- dropped columns

  for (const [path, column] of before) {
    if (after.has(path)) continue;
    if (path.includes(".")) {
      changes.push({
        code: "field/drop",
        severity: "recreate",
        column: path,
        message: `\`${path}\` is a STRUCT field the model no longer has. BigQuery cannot remove a field from a STRUCT in place, the table must be rebuilt.`,
      });
      continue;
    }

    changes.push({
      code: "column/drop",
      severity: "lossy",
      column: path,
      message: options.dropColumns
        ? `Drop \`${path}\` (${describe(column)}). Its data is deleted and cannot be recovered.`
        : `\`${path}\` exists in the warehouse but not the model. Not dropped, enable column drops if that is what you intend.`,
      ...(options.dropColumns
        ? { sql: `ALTER TABLE ${name} DROP COLUMN IF EXISTS ${ident(path)};` }
        : {}),
    });
  }

  // ---------------------------------------------------------- table shape

  if (partitioningKey(from) !== partitioningKey(to)) {
    changes.push({
      code: "partitioning/changed",
      severity: "recreate",
      message: `Partitioning changes from ${partitioningKey(from) || "none"} to ${partitioningKey(to) || "none"}. BigQuery cannot repartition a table in place, recreate it with \`CREATE OR REPLACE TABLE ... AS SELECT\`.`,
    });
  }

  if (from.clustering.join(",") !== to.clustering.join(",")) {
    /**
     * Clustering is the one shape change BigQuery *can* alter.
     *
     * `SET OPTIONS(clustering_fields = ...)` re-clusters going forward without rewriting what is
     * already stored, so it is supported but only fully effective for new data.
     */
    changes.push({
      code: "clustering/changed",
      severity: to.clustering.length > 0 ? "supported" : "recreate",
      message:
        to.clustering.length > 0
          ? `Re-cluster on ${to.clustering.join(", ")}. Existing storage is not rewritten, so the benefit applies to data written from now on.`
          : `Clustering is removed. BigQuery cannot un-cluster a table in place, recreate it.`,
      ...(to.clustering.length > 0
        ? {
            sql: `ALTER TABLE ${name} SET OPTIONS(clustering_fields = [${to.clustering
              .map((column) => literal(column))
              .join(", ")}]);`,
          }
        : {}),
    });
  }

  if ((from.description ?? "") !== (to.description ?? "")) {
    changes.push({
      code: "table/description",
      severity: "supported",
      message: "Update the table description.",
      sql: `ALTER TABLE ${name} SET OPTIONS(description = ${literal(to.description ?? "")});`,
    });
  }

  if (from.primaryKey.join(",") !== to.primaryKey.join(",")) {
    /**
     * Primary keys are declarative in BigQuery, so this is cheap, but it is still two
     * statements, and dropping must come first or adding collides with the existing one.
     */
    const statements: string[] = [];
    if (from.primaryKey.length > 0) statements.push(`ALTER TABLE ${name} DROP PRIMARY KEY IF EXISTS;`);
    if (to.primaryKey.length > 0) {
      statements.push(
        `ALTER TABLE ${name} ADD PRIMARY KEY (${to.primaryKey.map(ident).join(", ")}) NOT ENFORCED;`,
      );
    }

    changes.push({
      code: "primaryKey/changed",
      severity: "supported",
      message:
        to.primaryKey.length > 0
          ? `Declare the primary key as (${to.primaryKey.join(", ")}). BigQuery does not enforce it, the generated assertion is what does.`
          : "Remove the declared primary key.",
      sql: statements.join("\n"),
    });
  }

  const statements = changes
    .filter((change) => change.sql)
    .map((change) => change.sql as string);

  return {
    table: options.qualifiedName,
    changes,
    statements,
    requiresRecreate: changes.some((change) => change.severity === "recreate"),
  };
}

/**
 * The migration as a runnable script, with everything unsupported spelled out in comments.
 *
 * The comments are not decoration. A script that silently omitted the eight changes BigQuery
 * cannot make would look like a complete migration and leave the table wrong, so what was left
 * out is stated in the file that gets run.
 */
export function renderAlterScript(script: AlterScript): string {
  const lines: string[] = [`-- Migration for ${script.table}`];

  const blocked = script.changes.filter((change) => change.severity === "recreate");
  const lossy = script.changes.filter((change) => change.severity === "lossy");

  if (script.changes.length === 0) {
    lines.push("-- No differences. Nothing to run.");
    return `${lines.join("\n")}\n`;
  }

  if (blocked.length > 0) {
    lines.push(
      "--",
      `-- ${blocked.length} change(s) CANNOT be applied in place and are not included below.`,
      "-- This table needs rebuilding: CREATE OR REPLACE TABLE ... AS SELECT, then re-point readers.",
      "--",
    );
    for (const change of blocked) lines.push(`--   [${change.code}] ${change.message}`);
    lines.push("--");
  }

  if (lossy.length > 0) {
    lines.push("--", "-- Review these before running:", "--");
    for (const change of lossy) lines.push(`--   [${change.code}] ${change.message}`);
    lines.push("--");
  }

  if (script.statements.length === 0) {
    lines.push("", "-- Nothing here can be run as an ALTER. See the notes above.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  for (const change of script.changes) {
    if (!change.sql) continue;
    lines.push(`-- ${change.message}`, change.sql, "");
  }

  /*
    Trailing blank lines are trimmed by scanning, not by `/\n+$/`.

    An anchored `+` retries from every position, so trimming a long run of newlines that does not
    match is quadratic rather than linear. The content here is generated from model files that
    arrive by pull request, so the length is not ours to bound.
  */
  const joined = lines.join("\n");
  let end = joined.length;
  while (end > 0 && joined.charCodeAt(end - 1) === 10) end -= 1;
  return `${joined.slice(0, end)}\n`;
}

// ---------------------------------------------------------------- helpers

/** Every column by dotted path, so nested fields are compared as well as top-level ones. */
function flatten(table: Table): Map<string, Column> {
  const map = new Map<string, Column>();
  for (const { column, path } of walkColumns(table.columns)) map.set(path, column);
  return map;
}

/**
 * A comparable form of a column's type.
 *
 * Case and whitespace inside parameters vary between what a person typed and what BigQuery
 * reports, `NUMERIC(18,2)` against `NUMERIC(18, 2)`, and treating those as a difference would
 * generate an `ALTER` for every column on every run.
 */
function normaliseType(column: Column): string {
  return column.dataType.replace(/\s+/g, "").toUpperCase();
}

function describe(column: Column): string {
  return column.mode === "REPEATED" ? `ARRAY<${column.dataType}>` : column.dataType;
}

/** A single string identifying a partitioning scheme, for equality only. */
function partitioningKey(table: Table): string {
  const partitioning = table.partitioning;
  if (!partitioning) return "";
  if (partitioning.type === "integerRange") {
    return `range(${partitioning.field},${partitioning.start},${partitioning.end},${partitioning.interval})`;
  }
  return `time(${partitioning.field ?? "_PARTITIONDATE"},${partitioning.granularity})`;
}

/** `name TYPE [NOT NULL] [OPTIONS(...)]` for an ADD COLUMN clause. */
function columnClause(column: Column): string {
  const nested = column.fields?.length
    ? `STRUCT<${column.fields.map(inlineColumn).join(", ")}>`
    : column.dataType;
  const type = column.mode === "REPEATED" ? `ARRAY<${nested}>` : nested;

  const parts = [`${ident(column.name)} ${type}`];
  if (column.mode === "REQUIRED") parts.push("NOT NULL");
  if (column.defaultValueExpression) parts.push(`DEFAULT ${column.defaultValueExpression}`);
  if (column.description) parts.push(`OPTIONS(description = ${literal(column.description)})`);
  return parts.join(" ");
}

function inlineColumn(column: Column): string {
  const nested = column.fields?.length
    ? `STRUCT<${column.fields.map(inlineColumn).join(", ")}>`
    : column.dataType;
  return `${ident(column.name)} ${column.mode === "REPEATED" ? `ARRAY<${nested}>` : nested}`;
}

/**
 * Quote an identifier path.
 *
 * A dotted path names a field inside a STRUCT, and each segment is quoted separately, * `` `outer`.`inner` ``, because quoting the whole thing would name a column that literally
 * contains a dot.
 */
function ident(path: string): string {
  return path
    .split(".")
    .map((segment) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? segment : `\`${segment}\``))
    .join(".");
}

function quoted(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
