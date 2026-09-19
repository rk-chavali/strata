import { stringify } from "yaml";
import type { Column, Model, ObjectGraph, Relationship, Table } from "@strata/metamodel";
import type { GeneratedFile } from "./bigquery.js";

/**
 * Emit an Apache Ossie semantic model from a physical Strata model.
 *
 * The two tools divide cleanly. Strata models structure: what tables exist,
 * what one row means, which columns are keys, how tables relate and which
 * columns are sensitive. A semantic layer models measurement: what revenue is,
 * at what grain it is defined, which questions about it are answerable. Strata
 * has no metrics and the semantic layer has no opinion about DDL, so this is a
 * handover rather than an overlap.
 *
 * What makes the handover worth doing is that Ossie declares neither grain nor
 * join cardinality. A semantic engine has to infer both, and infers them from
 * the primary key. Strata states the primary key outright, so a model generated
 * here is better input than one written by hand against the Ossie spec.
 *
 * Nothing is emitted over the network. These are files, written into the same
 * git repository, read later by a separate binary. Neither tool imports the
 * other, and neither has to be running for the other to work.
 */

/** The portable logical type vocabulary from the Ossie core spec. */
type OssieDatatype =
  | "String"
  | "Integer"
  | "Decimal"
  | "Float"
  | "Boolean"
  | "Date"
  | "Time"
  | "DateTime"
  | "DateTimeTz"
  | "Opaque";

export interface OssieOptions {
  /** Namespace name. Defaults to the Strata model name. */
  namespace?: string;
  /** Owners recorded in the namespace manifest, e.g. `["@acme/sales"]`. */
  owners?: string[];
  /**
   * Tables this namespace publishes to other namespaces.
   *
   * Default is none. A semantic workspace is private by default so a team can
   * restructure without discovering another team depended on the old shape.
   */
  exports?: string[];
  /** Project-level dataset, when a table does not name its own. */
  defaultDataset?: string;
  /** Folder the namespace is written into. Defaults to `semantic`. */
  out?: string;
}

/**
 * Something the generated model will behave differently about than the Strata
 * model implies. These are not cosmetic: each one changes which questions the
 * semantic engine will answer.
 */
export interface OssieWarning {
  objectId: string;
  message: string;
  hint: string;
}

export interface OssieOutput {
  files: GeneratedFile[];
  warnings: OssieWarning[];
}

/**
 * BigQuery type to Ossie logical type.
 *
 * Parameters are dropped: `NUMERIC(18, 2)` is a Decimal, and the precision is a
 * physical concern the semantic layer does not carry.
 *
 * TIMESTAMP maps to DateTimeTz and DATETIME to DateTime, which is the one pair
 * worth getting right: BigQuery's TIMESTAMP is an absolute instant and its
 * DATETIME is a wall clock with no zone. Collapsing them would make a daily
 * grain silently shift by hours.
 */
export function ossieDatatype(bigQueryType: string): OssieDatatype {
  const base = bigQueryType.trim().toUpperCase().split("(")[0]!.trim();
  switch (base) {
    case "STRING":
      return "String";
    case "INT64":
    case "INT":
    case "INTEGER":
    case "SMALLINT":
    case "BIGINT":
    case "TINYINT":
    case "BYTEINT":
      return "Integer";
    case "NUMERIC":
    case "DECIMAL":
    case "BIGNUMERIC":
    case "BIGDECIMAL":
      return "Decimal";
    case "FLOAT64":
    case "FLOAT":
      return "Float";
    case "BOOL":
    case "BOOLEAN":
      return "Boolean";
    case "DATE":
      return "Date";
    case "TIME":
      return "Time";
    case "DATETIME":
      return "DateTime";
    case "TIMESTAMP":
      return "DateTimeTz";
    default:
      // JSON, GEOGRAPHY, INTERVAL, BYTES, STRUCT, ARRAY and anything a future
      // BigQuery adds. Opaque is readable as a dimension and refused as a
      // measure, which is the right default for a type we cannot reason about.
      return "Opaque";
  }
}

/** One Ossie field. */
interface OssieField {
  name: string;
  expression: { dialects: Array<{ dialect: string; expression: string }> };
  datatype: OssieDatatype;
  description?: string;
  dimension?: Record<string, never>;
}

/**
 * Whether a field is offered as something to group and filter by.
 *
 * Ossie makes this explicit: a field with no `dimension` block cannot be
 * grouped by at all, so leaving it off everything produces a model that
 * validates and answers nothing.
 *
 * The rule is that continuous numbers are not dimensions and everything else
 * is. Grouping by `order_total` yields one bucket per distinct price, which is
 * never a question anybody asked, whereas integers are routinely keys, counts
 * and categorical codes worth grouping on. It is a heuristic, and the cost of
 * being wrong is small in one direction: a missing dimension is added by hand,
 * a spurious one is noise in a picker.
 */
function isDimension(datatype: OssieDatatype): boolean {
  return datatype !== "Decimal" && datatype !== "Float";
}

/**
 * Flatten a column into Ossie fields.
 *
 * A STRUCT becomes one field per leaf, addressed by its dotted path, which is
 * how BigQuery names it in INFORMATION_SCHEMA and how a query must reference
 * it. A REPEATED column is skipped: an array has no single value per row, so
 * it cannot be a dimension or a measure without an explicit UNNEST that only a
 * person can decide the semantics of.
 */
function fieldsFor(column: Column, prefix: string, warnings: OssieWarning[], tableId: string): OssieField[] {
  const path = prefix ? `${prefix}.${column.name}` : column.name;

  if (column.mode === "REPEATED") {
    warnings.push({
      objectId: tableId,
      message: `column \`${path}\` is REPEATED, so it was not emitted as a field`,
      hint: "an array has no single value per row; model it as its own table, or add a field by hand with the UNNEST you intend",
    });
    return [];
  }

  if (column.fields && column.fields.length > 0) {
    return column.fields.flatMap((child) => fieldsFor(child, path, warnings, tableId));
  }

  const datatype = ossieDatatype(column.dataType);
  const field: OssieField = {
    name: path.replace(/\./g, "_"),
    expression: { dialects: [{ dialect: "ANSI_SQL", expression: path }] },
    datatype,
  };
  if (column.description) field.description = column.description;
  // Empty rather than absent: the block's presence is what marks a dimension,
  // and `is_time` is already implied by a temporal datatype.
  if (isDimension(datatype)) field.dimension = {};
  return [field];
}

/**
 * Check that the grain a semantic engine will infer matches what Strata says.
 *
 * Ossie carries no grain and no cardinality, so an engine derives both from the
 * primary key: a join is safe when its target columns are a declared key on the
 * target, and repeats rows otherwise. A table with no primary key therefore
 * looks like it repeats on every join, and every sum taken across one is
 * refused. That is correct behaviour on the engine's part and almost never what
 * the modeller meant, so it is worth saying here rather than leaving them to
 * discover it as an unexplained refusal.
 */
function checkGrain(table: Table, warnings: OssieWarning[]): void {
  if (table.primaryKey.length > 0) return;
  warnings.push({
    objectId: table.id,
    message: `table \`${table.name}\` declares no primaryKey, so the semantic engine cannot establish its grain`,
    hint: "any join into this table will be treated as repeating its rows, and sums across that join will be refused; add primaryKey to the table",
  });
}

/**
 * Check a relationship's declared cardinality against the key it joins on.
 *
 * Strata declares cardinality; a semantic engine derives it. When the two
 * disagree the engine wins, because it is the one answering the question, and
 * the result is a refusal the modeller cannot explain from reading the Strata
 * model. Catching it at generation is the whole value of having both tools.
 */
function checkCardinality(
  relationship: Relationship,
  parentTable: Table | undefined,
  warnings: OssieWarning[],
): void {
  const { parent } = relationship;
  const saysOne = parent.cardinality === "exactly-one" || parent.cardinality === "zero-or-one";
  if (!saysOne || !parentTable) return;

  const key = [...parentTable.primaryKey].sort();
  const joined = [...parent.attributes].sort();
  const isKey = key.length > 0 && key.length === joined.length && key.every((c, i) => c === joined[i]);
  if (isKey) return;

  warnings.push({
    objectId: relationship.id,
    message:
      `relationship \`${relationship.name}\` says ${parent.ref} is \`${parent.cardinality}\`, ` +
      `but it is joined on [${parent.attributes.join(", ")}] which is not its primary key ` +
      `[${parentTable.primaryKey.join(", ") || "none"}]`,
    hint: "the semantic engine derives cardinality from the primary key, so it will treat this join as repeating rows and refuse sums across it; make the joined columns the primary key, or correct the cardinality",
  });
}

/**
 * Build the Ossie semantic model for one physical Strata model.
 */
export function generateOssie(
  graph: ObjectGraph,
  modelName: string,
  options: OssieOptions = {},
): OssieOutput {
  const model = graph.modelNamed(modelName);
  if (!model) throw new Error(`no model named \`${modelName}\``);
  if (model.tier !== "physical") {
    throw new Error(
      `\`${modelName}\` is a ${model.tier} model; a semantic model is generated from the physical tier, ` +
        "because that is what a query actually reads",
    );
  }

  const namespace = options.namespace ?? model.name;
  const out = options.out ?? "semantic";
  const warnings: OssieWarning[] = [];

  const objects = graph.inModel(modelName).map((entry) => entry.object);
  const tables = objects
    .filter((o): o is Table => o.kind === "table")
    .sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(tables.map((t) => [t.name, t]));

  const datasets = tables.map((table) => {
    checkGrain(table, warnings);
    const dataset = table.dataset ?? options.defaultDataset ?? model.target?.dataset;
    const entry: Record<string, unknown> = {
      name: table.name,
      source: dataset ? `${dataset}.${table.name}` : table.name,
    };
    if (table.primaryKey.length > 0) entry.primary_key = [...table.primaryKey];
    // Strata's `grain` is a sentence about what one row means, which is exactly
    // the grounding text an agent needs to pick the right table. Modellers often
    // repeat it inside the description, so it is only appended when it adds
    // something: a description that says the same thing twice reads as careless.
    const parts = [table.description, table.grain].filter((p): p is string => Boolean(p));
    const description =
      parts.length === 2 && parts[0]!.includes(parts[1]!) ? parts[0]! : [...new Set(parts)].join(" ");
    if (description) entry.description = description;
    entry.fields = table.columns.flatMap((c) => fieldsFor(c, "", warnings, table.id));
    return entry;
  });

  const relationships = objects
    .filter((o): o is Relationship => o.kind === "relationship" && o.tier === "physical")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((rel) => {
      checkCardinality(rel, byName.get(refName(rel.parent.ref)), warnings);
      // Ossie writes a join from the many side to the one side. Strata's parent
      // is the one side, so parent becomes `to`.
      return {
        name: rel.name,
        from: refName(rel.child.ref),
        to: refName(rel.parent.ref),
        from_columns: [...rel.child.attributes],
        to_columns: [...rel.parent.attributes],
      };
    });

  const semanticModel: Record<string, unknown> = { name: namespace };
  if (model.description) semanticModel.description = model.description;
  semanticModel.datasets = datasets;
  if (relationships.length > 0) semanticModel.relationships = relationships;

  if (ownersFor(model, options)[0] === UNASSIGNED_OWNER) {
    warnings.push({
      objectId: model.id,
      message: `model \`${model.name}\` names no owner, so the namespace manifest was written with ${UNASSIGNED_OWNER}`,
      hint: "a semantic workspace will load it, but nobody is recorded as approving access or answering for a disputed number; set ownership.owner on the model, or edit namespace.yaml",
    });
  }

  const files: GeneratedFile[] = [
    {
      path: `${out}/${namespace}/namespace.yaml`,
      contents: manifest(namespace, model, options),
      objectId: model.id,
      kind: "semantic",
    },
    {
      path: `${out}/${namespace}/datasets.generated.yaml`,
      contents:
        header([
          `Generated by \`strata generate semantic\` from the ${model.name} model.`,
          "",
          "Do not edit. Every change here is overwritten on the next run, and the",
          "source of truth is the Strata model this came from.",
          "",
          "Metrics are deliberately not generated: what revenue means is a business",
          "decision, not something derivable from a schema. Write them in",
          "metrics.yaml next to this file, which this command never touches.",
        ]) + stringify({ version: "0.2.0.dev0", semantic_model: [semanticModel] }, { lineWidth: 0 }),
      objectId: model.id,
      kind: "semantic",
    },
  ];

  return { files, warnings };
}

/**
 * The namespace manifest a semantic workspace uses to compose teams.
 *
 * Owners are mandatory downstream: a semantic workspace refuses to load a
 * namespace that names none, because an owner is who approves access to it and
 * who answers when a number is disputed. Strata's own ownership metadata is
 * used when it is there, and a visible placeholder when it is not, so the gap
 * shows up in review rather than as an unexplained load failure.
 */
function manifest(namespace: string, model: Model, options: OssieOptions): string {
  const doc: Record<string, unknown> = { version: 1, name: namespace };
  doc.owners = ownersFor(model, options);
  if (model.description) doc.description = model.description;
  // Absent rather than empty: an empty exports block reads as "exports nothing
  // deliberately", which is the same outcome but a different statement.
  if (options.exports && options.exports.length > 0) {
    doc.exports = { datasets: [...options.exports] };
  }
  return (
    header([
      `The ${namespace} namespace.`,
      "",
      "Everything is private unless listed under `exports`. Edit this file by",
      "hand: who owns these definitions and what they publish is a decision,",
      "not something derivable from the schema, so it is never regenerated.",
      "",
      "`owners` is required. Replace a placeholder owner with the team that",
      "answers when one of these numbers is disputed.",
    ]) + stringify(doc, { lineWidth: 0 })
  );
}

/** Placeholder written when nothing in the Strata model names an owner. */
export const UNASSIGNED_OWNER = "@unassigned";

function ownersFor(model: Model, options: OssieOptions): string[] {
  if (options.owners && options.owners.length > 0) return options.owners;
  const owner = model.ownership?.owner ?? model.ownership?.team;
  if (owner) return [owner.startsWith("@") ? owner : `@${owner}`];
  return [UNASSIGNED_OWNER];
}

function header(lines: string[]): string {
  return lines.map((l) => (l ? `# ${l}` : "#")).join("\n") + "\n\n";
}

/** A ref is `name` or `model:name`; the semantic model addresses by name. */
function refName(ref: string): string {
  const colon = ref.lastIndexOf(":");
  return colon === -1 ? ref : ref.slice(colon + 1);
}
