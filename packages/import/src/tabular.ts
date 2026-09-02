import { emptyModel, type SourceEntity, type SourceModel } from "./ir.js";

/**
 * Read a CSV or TSV column inventory, one row per column.
 *
 * The format everyone already has. Long before a migration is approved, someone has
 * exported a spreadsheet of every table and column from erwin, or from the warehouse's
 * `INFORMATION_SCHEMA`, and circulated it for review. Being able to import that means
 * the tool is useful on day one rather than after a licence negotiation.
 *
 * Headers are matched loosely, `Table Name`, `table_name` and `TABLE` all work, * because these files are written by people, not by an exporter.
 */

const HEADERS: Record<string, string[]> = {
  entity: ["table", "tablename", "entity", "entityname", "object", "objectname"],
  column: ["column", "columnname", "attribute", "attributename", "field", "fieldname"],
  type: ["type", "datatype", "columntype", "physicaltype", "sqltype"],
  required: ["required", "notnull", "nullable", "isnullable", "mandatory"],
  key: ["pk", "primarykey", "iskey", "ispk", "key"],
  description: ["description", "definition", "comment", "businessdefinition", "notes"],
  schema: ["schema", "dataset", "database", "namespace"],
  subjectArea: ["subjectarea", "subject", "area", "domain", "module"],
};

export function readTabular(text: string): SourceModel {
  const model = emptyModel("tabular");
  const rows = parseDelimited(text);

  if (rows.length < 2) {
    model.diagnostics.push({
      severity: "error",
      code: "tabular/empty",
      message: "expected a header row and at least one data row",
    });
    return model;
  }

  const header = rows[0]!.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const index: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADERS)) {
    const position = header.findIndex((cell) => aliases.includes(cell));
    if (position >= 0) index[field] = position;
  }

  if (index.entity === undefined || index.column === undefined) {
    model.diagnostics.push({
      severity: "error",
      code: "tabular/noKeyColumns",
      message: `could not find a table column and a column column. Found: ${rows[0]!.join(", ")}`,
    });
    return model;
  }

  const byName = new Map<string, SourceEntity>();

  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const entityName = cell(row, index.entity);
    const columnName = cell(row, index.column);

    if (!entityName || !columnName) {
      if (row.some((value) => value.trim())) {
        model.diagnostics.push({
          severity: "warning",
          code: "tabular/incompleteRow",
          message: "row skipped: it has no table or no column name",
          at: `line ${line}`,
        });
      }
      return;
    }

    let entity = byName.get(entityName.toLowerCase());
    if (!entity) {
      entity = { name: entityName, columns: [] };
      const schema = cell(row, index.schema);
      if (schema) entity.schema = schema;
      const area = cell(row, index.subjectArea);
      if (area) entity.subjectArea = area;
      byName.set(entityName.toLowerCase(), entity);
      model.entities.push(entity);
    }

    const required = cell(row, index.required);
    const key = cell(row, index.key);

    entity.columns.push({
      name: columnName,
      ...(cell(row, index.type) ? { type: cell(row, index.type)! } : {}),
      ...(cell(row, index.description) ? { description: cell(row, index.description)! } : {}),
      // `nullable` and `required` mean opposite things, and the header tells us which
      // this column is, reading either as "truthy means required" inverts one of them.
      ...(required !== undefined
        ? { required: header[index.required!]?.includes("null") && !header[index.required!]?.includes("notnull") ? !isTruthy(required) : isTruthy(required) }
        : {}),
      ...(isTruthy(key) ? { isPrimaryKey: true, required: true } : {}),
    });
  });

  model.tier = model.entities.some((entity) => entity.columns.some((column) => column.type))
    ? "physical"
    : "logical";
  return model;
}

function cell(row: string[], position: number | undefined): string | undefined {
  if (position === undefined) return undefined;
  const value = row[position]?.trim();
  return value ? value : undefined;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["y", "yes", "true", "1", "pk", "x", "required"].includes(value.trim().toLowerCase());
}

/**
 * Parse CSV or TSV, honouring quoted fields.
 *
 * Written out rather than split on the delimiter because a description column routinely
 * contains commas and newlines, and splitting naively shifts every field after it, * producing an import that looks plausible and is wrong.
 */
export function parseDelimited(text: string): string[][] {
  const delimiter = chooseDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

/** Whichever delimiter appears more often on the header line. */
function chooseDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") + 1 || text.length);
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}
