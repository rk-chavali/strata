import {
  qualifiedTableName,
  type Classification,
  type Column,
  type Model,
  type ObjectGraph,
  type Table,
} from "@strata/metamodel";
import {
  effectiveClassification,
  resolvePolicyTag,
  type ResolvedTag,
  type Taxonomy,
} from "./taxonomy.js";

/**
 * BigQuery DDL generation.
 *
 * The handoff: the modelling team owns the model, this emits `CREATE TABLE`, and the
 * pipeline team translates it into whatever Dataform needs. Everything written is a
 * *new file*, nothing here ever edits something a human wrote, which is what makes
 * the whole thing safe to run unattended.
 *
 * Deliberately not clever. DDL is a deterministic projection of the model, and an
 * "intelligent" generator that occasionally guesses differently is worse than a dumb
 * one you can predict.
 */

export interface DdlOptions {
  /** Emit `CREATE OR REPLACE` rather than `CREATE TABLE IF NOT EXISTS`. */
  orReplace?: boolean;
  /** Project to qualify names with, overriding the model's target. */
  project?: string;
  /** Dataset to qualify names with, overriding each table's own. */
  dataset?: string;
  /** Include a header comment naming the source model. Default true. */
  header?: boolean;
  /** Emit policy tag bindings for classified columns. Default true. */
  policyTags?: boolean;
  /**
   * Maps a classification to a Dataplex policy tag resource.
   *
   * Without this, a column classified `confidential / pii` produces no tag at all: nothing
   * about the word "pii" implies `projects/p/locations/eu/taxonomies/1/policyTags/2`, and
   * only your Data Catalog knows that string. Declared in `strata.config.yaml` so it is
   * versioned and reviewable like the rest of the model.
   */
  taxonomy?: Taxonomy;
  /**
   * Resolves what a column inherits from its domain and logical attribute.
   *
   * Supplied by `generateModelDdl`, which has the graph. Absent when a single table is
   * rendered on its own, in which case only the column's own classification is visible.
   */
  resolveClassification?: (column: Column) => Classification | undefined;
}

export interface GeneratedFile {
  /** Path relative to the output folder. */
  path: string;
  contents: string;
  /** The object this file was generated from. */
  objectId: string;
  kind: "table" | "policyTags" | "index";
}

const INDENT = "  ";

/** Quote an identifier only when BigQuery needs it. */
function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

/**
 * Backtick-quote a fully qualified name.
 *
 * Not optional: GCP project ids almost always contain hyphens, and BigQuery parses an
 * unquoted `acme-analytics-prod.dataset.table` as subtraction. Getting this wrong
 * produces DDL that looks right and fails on every real project.
 */
function qualified(name: string): string {
  return name.includes(".") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `\`${name}\`` : name;
}

/** Escape a string literal for a BigQuery `OPTIONS` clause. */
function literal(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Render a column, recursing into STRUCT fields.
 *
 * `REPEATED` becomes `ARRAY<...>` and `REQUIRED` becomes `NOT NULL`, because that is
 * how BigQuery spells them in DDL even though the API calls them modes.
 */
export function renderColumn(column: Column, depth = 1): string {
  const pad = INDENT.repeat(depth);
  const nested = column.fields?.length
    ? `STRUCT<\n${column.fields.map((field) => renderColumn(field, depth + 1)).join(",\n")}\n${pad}>`
    : column.dataType;

  const type = column.mode === "REPEATED" ? `ARRAY<${nested}>` : nested;
  const parts = [`${pad}${ident(column.name)} ${type}`];

  // Only REQUIRED yields NOT NULL. A REPEATED column is never null in BigQuery, it is
  // empty, and BigQuery rejects NOT NULL on one outright, so the mode check is doing
  // real work rather than merely tidying.
  if (column.mode === "REQUIRED") parts.push("NOT NULL");
  if (column.defaultValueExpression) parts.push(`DEFAULT ${column.defaultValueExpression}`);

  const options: string[] = [];
  if (column.description) options.push(`description = ${literal(column.description)}`);
  if (options.length > 0) parts.push(`OPTIONS(${options.join(", ")})`);

  return parts.join(" ");
}

function renderPartitioning(table: Table): string | undefined {
  const partitioning = table.partitioning;
  if (!partitioning) return undefined;

  if (partitioning.type === "integerRange") {
    return `PARTITION BY RANGE_BUCKET(${ident(partitioning.field)}, GENERATE_ARRAY(${partitioning.start}, ${partitioning.end}, ${partitioning.interval}))`;
  }

  // Ingestion-time partitioning has no column; BigQuery exposes it as _PARTITIONDATE.
  if (!partitioning.field) return "PARTITION BY _PARTITIONDATE";

  const column = ident(partitioning.field);
  switch (partitioning.granularity) {
    case "HOUR":
    case "MONTH":
    case "YEAR":
      return `PARTITION BY ${partitioning.granularity}(${column})`;
    default:
      // DAY is the default granularity and BigQuery rejects DAY(...) on a DATE column,
      // so the bare column is the only form that works for every temporal type.
      return `PARTITION BY ${column}`;
  }
}

function renderTableOptions(table: Table): string[] {
  const options: string[] = [];
  if (table.description) options.push(`description = ${literal(table.description)}`);
  if (table.options.friendlyName) options.push(`friendly_name = ${literal(table.options.friendlyName)}`);
  if (table.options.expirationDays !== undefined) {
    options.push(
      `partition_expiration_days = ${table.options.expirationDays}`,
    );
  }
  if (table.partitioning?.requireFilter) options.push("require_partition_filter = TRUE");
  if (table.options.kmsKeyName) options.push(`kms_key_name = ${literal(table.options.kmsKeyName)}`);

  const labels = Object.entries(table.options.labels);
  if (labels.length > 0) {
    options.push(`labels = [${labels.map(([k, v]) => `(${literal(k)}, ${literal(v)})`).join(", ")}]`);
  }
  return options;
}

/**
 * Primary and foreign keys.
 *
 * BigQuery accepts these but does not enforce them, hence `NOT ENFORCED`, which is
 * mandatory. They still matter: the optimiser uses them, and they document intent that
 * the generated assertions then actually check.
 */
function renderConstraints(table: Table, graph: ObjectGraph, defaults: { project?: string; dataset?: string }): string[] {
  const constraints: string[] = [];

  if (table.primaryKey.length > 0) {
    constraints.push(
      `${INDENT}PRIMARY KEY (${table.primaryKey.map(ident).join(", ")}) NOT ENFORCED`,
    );
  }

  for (const fk of table.foreignKeys) {
    const resolved = graph.resolve(fk.references.table, { model: table.model, kind: "table" });
    const parent = resolved?.target.object.kind === "table" ? (resolved.target.object as Table) : undefined;
    const parentName = parent ? qualifiedTableName(parent, defaults) : fk.references.table;

    constraints.push(
      `${INDENT}CONSTRAINT ${ident(fk.name)} FOREIGN KEY (${fk.columns.map(ident).join(", ")}) ` +
        `REFERENCES ${qualified(parentName)} (${fk.references.columns.map(ident).join(", ")}) NOT ENFORCED`,
    );
  }

  return constraints;
}

/** Generate the `CREATE TABLE` (or view) statement for one table. */
export function generateTableDdl(
  table: Table,
  graph: ObjectGraph,
  model: Model | undefined,
  options: DdlOptions = {},
): string {
  const defaults = {
    project: options.project ?? model?.target?.project,
    dataset: options.dataset ?? model?.target?.dataset,
  };
  const name = qualifiedTableName(table, defaults);
  const quoted = qualified(name);

  const lines: string[] = [];

  if (options.header !== false) {
    lines.push(`-- Generated from the ${table.model ?? "unknown"} model. Do not edit by hand;`);
    lines.push(`-- change the model and regenerate, so the two cannot drift apart.`);
    if (table.description) lines.push(`-- ${table.description.split("\n")[0]}`);
    lines.push("");
  }

  if (table.objectType === "view" || table.objectType === "materializedView") {
    const keyword = table.objectType === "view" ? "VIEW" : "MATERIALIZED VIEW";
    const verb = options.orReplace ? `CREATE OR REPLACE ${keyword}` : `CREATE ${keyword} IF NOT EXISTS`;
    lines.push(`${verb} ${quoted}`);

    const viewOptions = renderTableOptions(table);
    if (viewOptions.length > 0) lines.push(`OPTIONS(\n${viewOptions.map((o) => INDENT + o).join(",\n")}\n)`);
    lines.push("AS");
    lines.push(
      table.viewQuery?.trim() ??
        `-- No viewQuery on the model. Add one, or let the mapping generate it.\nSELECT 1`,
    );
    return `${lines.join("\n")};\n`;
  }

  const verb = options.orReplace ? "CREATE OR REPLACE TABLE" : "CREATE TABLE IF NOT EXISTS";
  const body = [
    ...table.columns.map((column) => renderColumn(column)),
    ...renderConstraints(table, graph, defaults),
  ];

  lines.push(`${verb} ${quoted} (`);
  lines.push(body.join(",\n"));
  lines.push(")");

  const partition = renderPartitioning(table);
  if (partition) lines.push(partition);
  if (table.clustering.length > 0) {
    lines.push(`CLUSTER BY ${table.clustering.map(ident).join(", ")}`);
  }

  const tableOptions = renderTableOptions(table);
  if (tableOptions.length > 0) {
    lines.push(`OPTIONS(\n${tableOptions.map((o) => INDENT + o).join(",\n")}\n)`);
  }

  return `${lines.join("\n")};\n`;
}

/**
 * Policy tag bindings for classified columns.
 *
 * Emitted separately from the table DDL because they are applied by a different role, * a data steward with Data Catalog permissions, not whoever runs migrations, and
 * because the taxonomy must exist before they can run.
 */
export function generatePolicyTagDdl(
  table: Table,
  model: Model | undefined,
  options: DdlOptions = {},
): string | undefined {
  const defaults = {
    project: options.project ?? model?.target?.project,
    dataset: options.dataset ?? model?.target?.dataset,
  };
  const name = qualifiedTableName(table, defaults);

  /*
    Resolve first, then filter.

    The previous version filtered on `policyTag ?? policyTagName` being present on the column
    itself, which meant a column classified `confidential / pii`, the ordinary case, and the
    one the dictionary makes easy to create, was skipped entirely. Every classified column is
    now considered, and the taxonomy decides whether it yields a tag.
  */
  const resolveFor = (column: Column): Classification | undefined =>
    options.resolveClassification?.(column) ?? column.classification;

  const tagged = table.columns
    .map((column) => ({ column, tag: resolvePolicyTag(resolveFor(column), options.taxonomy) }))
    .filter((entry): entry is { column: Column; tag: ResolvedTag } => Boolean(entry.tag));

  if (tagged.length === 0) return undefined;

  const lines = [
    `-- Column-level security for ${name}.`,
    `-- Apply with a principal that holds Data Catalog permissions; the taxonomy must`,
    `-- already exist. Column names carrying a policyTagName rather than a full resource`,
    `-- path are left as TODO, since only your Data Catalog knows the resource id.`,
    "",
  ];

  for (const { column, tag } of tagged) {
    const classification = resolveFor(column);
    const categories = classification?.categories?.join(", ");
    lines.push(`-- ${column.name}${categories ? ` (${categories})` : ""}`);

    // Say why the tag was chosen. A steward reviewing this file needs to know whether it
    // came from the column, from a category rule, or from a blanket sensitivity mapping.
    if (tag.source !== "column") {
      lines.push(`-- matched ${tag.source} \`${tag.matched}\` in the configured taxonomy`);
    }

    if (tag.unresolved) {
      lines.push(`-- TODO: resolve taxonomy "${tag.tag}" to a policy tag resource id`);
      lines.push(
        `-- ALTER TABLE \`${name}\` ALTER COLUMN ${ident(column.name)} SET OPTIONS (policy_tags = ["projects/…/policyTags/…"]);`,
      );
    } else {
      lines.push(
        `ALTER TABLE \`${name}\` ALTER COLUMN ${ident(column.name)} SET OPTIONS (policy_tags = [${literal(tag.tag)}]);`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface GenerateOptions extends DdlOptions {
  /**
   * Where files go **relative to the output folder**, not the repo root, the caller
   * supplies the folder, so including it here would double it up.
   *
   * `{dataset}`, `{name}` and `{layer}` are substituted, which is how a team that keeps
   * DDL grouped by dataset gets exactly that shape.
   */
  pathTemplate?: string;
  policyTagPathTemplate?: string;
  /** Emit a single index file listing everything generated. Default true. */
  index?: boolean;
  /** Distinguishes the index when several models write into one folder. */
  indexSuffix?: string;
}

/** Generate every file for one physical model. */
export function generateModelDdl(
  graph: ObjectGraph,
  modelName: string,
  options: GenerateOptions = {},
): GeneratedFile[] {
  const model = graph.modelNamed(modelName);
  if (!model) throw new Error(`no model named \`${modelName}\``);
  if (model.tier !== "physical") {
    throw new Error(`\`${modelName}\` is a ${model.tier} model; DDL is only generated from physical models`);
  }

  const tablePath = options.pathTemplate ?? "{dataset}/{name}.sql";
  const policyPath = options.policyTagPathTemplate ?? "policy_tags/{name}.sql";
  const files: GeneratedFile[] = [];

  const tables = graph
    .inModel(modelName)
    .filter((entry) => entry.object.kind === "table")
    .map((entry) => entry.object as Table)
    // Declarations describe tables owned by someone else's pipeline, so generating
    // DDL for them would be claiming ownership we do not have.
    .filter((table) => table.dataform.type !== "declaration")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const table of tables) {
    const dataset = table.dataset ?? model.target?.dataset ?? "default";
    files.push({
      path: render(tablePath, { dataset, name: table.name, layer: table.layer ?? "" }),
      contents: generateTableDdl(table, graph, model, options),
      objectId: table.id,
      kind: "table",
    });

    if (options.policyTags !== false) {
      /*
        The resolver is bound here because this is the only layer holding the graph. It is
        what makes classifying a logical attribute once reach every physical column that
        implements it, the reason the logical tier exists at all.
      */
      const policy = generatePolicyTagDdl(table, model, {
        ...options,
        resolveClassification: (column) => effectiveClassification(column, graph, modelName),
      });
      if (policy) {
        files.push({
          path: render(policyPath, { dataset, name: table.name, layer: table.layer ?? "" }),
          contents: policy,
          objectId: table.id,
          kind: "policyTags",
        });
      }
    }
  }

  /**
   * Swap the filename portion of the table path for the index's own name.
   *
   * Was `tablePath.replace(/\{name\}[^\/]*$/, indexName)`, which is the same thing and is
   * quadratic on a path that has no match: an anchored `[^\/]*$` is retried from every position.
   * The path comes from `strata.config.yaml`, which arrives by pull request.
   *
   * Deliberately identical in behaviour, including the awkward part: `replace` with a
   * non-global pattern takes the *first* match, so this is the first `{name}` in the final
   * segment rather than the last, and a path with no `{name}` in that segment is left alone.
   */
  function indexPathFrom(path: string, indexName: string): string {
    const slash = path.lastIndexOf("/");
    const directory = slash === -1 ? "" : path.slice(0, slash + 1);
    const filename = path.slice(slash + 1);

    const marker = filename.indexOf("{name}");
    return marker === -1 ? path : directory + filename.slice(0, marker) + indexName;
  }

  if (options.index !== false && files.length > 0) {
    /**
     * One index per model, named after it once there is more than one.
     *
     * Table paths are keyed by dataset, so they never collide between models, but the
     * index is not, and two physical models both produced `DDL/README.md`. The preview
     * listed the same path twice and the second write silently replaced the first.
     */
    const indexName = options.indexSuffix ? `README.${options.indexSuffix}.md` : "README.md";
    files.push({
      path: render(indexPathFrom(tablePath, indexName), { dataset: "", name: "", layer: "" }),
      contents: buildIndex(modelName, tables, files),
      objectId: model.id,
      kind: "index",
    });
  }

  return files;
}

/**
 * An index file, so anyone opening the folder knows what they are looking at.
 *
 * Generated output that does not explain where it came from invites someone to edit it
 * by hand, and then the model and the DDL disagree with nobody noticing.
 */
function buildIndex(modelName: string, tables: Table[], files: GeneratedFile[]): string {
  const lines = [
    `# ${modelName}, generated DDL`,
    "",
    "Generated from the data model. **Do not edit these files by hand**, change the",
    "model and regenerate, or the two will drift apart with nothing to detect it.",
    "",
    `${tables.length} table(s), ${files.filter((f) => f.kind === "policyTags").length} with column-level security.`,
    "",
    "| Table | Layer | Partitioned by | Clustered by |",
    "| --- | --- | --- | --- |",
  ];

  for (const table of tables) {
    const partition = table.partitioning
      ? table.partitioning.type === "time"
        ? (table.partitioning.field ?? "_PARTITIONDATE")
        : table.partitioning.field
      : "-";
    lines.push(
      `| \`${table.name}\` | ${table.layer ?? "-"} | ${partition} | ${table.clustering.join(", ") || "-"} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function render(template: string, variables: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => variables[key] ?? "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\//, "");
}
