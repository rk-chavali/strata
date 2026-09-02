import { emptyModel, type SourceColumn, type SourceEntity, type SourceModel } from "./ir.js";

/**
 * Read `CREATE TABLE` statements.
 *
 * This is the universal path out of erwin: every version can forward-engineer DDL, the
 * output is plain text, and it does not depend on which XML schema that release happened
 * to use. It loses the conceptual and logical layers, a physical script has no concept
 * of a business term, which is exactly why it is one reader among several rather than
 * the only one.
 *
 * Written as a scanner rather than a regex over the whole file. Column definitions
 * contain commas inside `NUMERIC(18, 2)` and `STRUCT<a INT64, b STRING>`, so splitting
 * on commas is wrong in a way that only shows up on the types people actually use.
 */

export function readDdl(sql: string): SourceModel {
  const model = emptyModel("ddl");
  const statements = splitStatements(stripComments(sql));

  for (const statement of statements) {
    const table = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EXTERNAL\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i.exec(
      statement,
    );

    if (table) {
      model.entities.push(readTable(table[1]!, statement, model));
      continue;
    }

    const alter = /^\s*ALTER\s+TABLE\s+(\S+)[\s\S]*?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\S+)\s*\(([^)]*)\)/i.exec(
      statement,
    );
    if (alter) {
      model.relationships.push({
        // Unqualified on both ends: tables are keyed by bare name, so leaving the schema
        // on `staging.stg_supplier` here means the relationship never resolves and the
        // foreign key is silently dropped, which is most of them, since erwin emits
        // qualified names in ALTER and bare ones in CREATE.
        parent: tableName(alter[3]!),
        child: tableName(alter[1]!),
        cardinality: "one-to-many",
        parentColumns: splitList(alter[4]!),
        childColumns: splitList(alter[2]!),
      });
      continue;
    }

    // Anything else, views, grants, indexes, procedures, is reported rather than
    // dropped. A migration where the tool silently ignored a third of the file is how
    // people discover missing objects in production.
    const verb = /^\s*(\w+(?:\s+\w+)?)/.exec(statement)?.[1];
    if (verb && !/^\s*$/.test(statement)) {
      model.diagnostics.push({
        severity: "info",
        code: "ddl/skipped",
        message: `\`${verb.toUpperCase()}\` statement not imported`,
        at: statement.slice(0, 60).replace(/\s+/g, " "),
      });
    }
  }

  if (model.entities.length === 0) {
    model.diagnostics.push({
      severity: "error",
      code: "ddl/noTables",
      message: "no CREATE TABLE statements found, is this a DDL script?",
    });
  }

  model.tier = "physical";
  return model;
}

function readTable(rawName: string, statement: string, model: SourceModel): SourceEntity {
  const parts = bareName(rawName).split(".");
  const name = parts[parts.length - 1]!;
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;

  const entity: SourceEntity = { name, columns: [], ...(schema ? { schema } : {}) };

  const body = balancedBody(statement);
  if (body === undefined) {
    model.diagnostics.push({
      severity: "error",
      code: "ddl/unbalanced",
      message: `could not find the column list for \`${name}\`, unbalanced parentheses`,
      at: name,
    });
    return entity;
  }

  for (const item of splitTopLevel(body)) {
    const clause = item.trim();
    if (!clause) continue;

    // Table-level constraints come first: they look like columns until you read the
    // first word, and treating `PRIMARY KEY (id)` as a column named PRIMARY is the
    // classic failure of a naive parser.
    const primary = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(clause);
    if (primary) {
      const keys = new Set(splitList(primary[1]!).map((key) => key.toLowerCase()));
      for (const column of entity.columns) {
        if (keys.has(column.name.toLowerCase())) column.isPrimaryKey = true;
      }
      continue;
    }

    const foreign = /^(?:CONSTRAINT\s+(\S+)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\S+)\s*\(([^)]*)\)/i.exec(
      clause,
    );
    if (foreign) {
      model.relationships.push({
        ...(foreign[1] ? { name: bareName(foreign[1]) } : {}),
        parent: tableName(foreign[3]!),
        child: name,
        cardinality: "one-to-many",
        parentColumns: splitList(foreign[4]!),
        childColumns: splitList(foreign[2]!),
      });
      continue;
    }

    if (/^(CONSTRAINT|UNIQUE|CHECK|KEY|INDEX|PERIOD)\b/i.test(clause)) {
      model.diagnostics.push({
        severity: "info",
        code: "ddl/constraintSkipped",
        message: `constraint on \`${name}\` not imported`,
        at: clause.slice(0, 60),
      });
      continue;
    }

    const column = readColumn(clause);
    if (column) entity.columns.push(column);
  }

  const description = /OPTIONS\s*\([^)]*description\s*=\s*(['"])([\s\S]*?)\1/i.exec(statement);
  if (description) entity.description = unescapeSql(description[2]!);

  if (entity.columns.length === 0) {
    model.diagnostics.push({
      severity: "warning",
      code: "ddl/noColumns",
      message: `\`${name}\` has no readable columns`,
      at: name,
    });
  }

  return entity;
}

function readColumn(clause: string): SourceColumn | undefined {
  // Name, then everything else. The name may be quoted or backticked.
  const match = /^([`"[]?)([\p{L}\p{N}_$]+)[`"\]]?\s+([\s\S]+)$/u.exec(clause);
  if (!match) return undefined;

  const name = match[2]!;
  const rest = match[3]!;

  // The type runs until a keyword that cannot be part of one. Taking "the first word"
  // truncates `NUMERIC(18, 2)` and `ARRAY<STRUCT<a INT64>>`.
  const type = takeType(rest);

  const column: SourceColumn = { name };
  if (type) column.type = type;
  if (/\bNOT\s+NULL\b/i.test(rest)) column.required = true;
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
    column.isPrimaryKey = true;
    column.required = true;
  }

  const description = /OPTIONS\s*\([^)]*description\s*=\s*(['"])([\s\S]*?)\1/i.exec(rest);
  if (description) column.description = unescapeSql(description[2]!);

  return column;
}

/** Consume a type, tracking `()` and `<>` depth so nested generics survive. */
function takeType(rest: string): string | undefined {
  let depth = 0;
  let end = rest.length;

  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (char === "(" || char === "<") depth += 1;
    else if (char === ")" || char === ">") depth -= 1;
    else if (depth === 0 && /\s/.test(char)) {
      const tail = rest.slice(index + 1);
      // A space inside `NUMERIC(18, 2)` is already excluded by the depth check; a space
      // before one of these keywords ends the type.
      if (/^(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|OPTIONS|COMMENT|GENERATED|COLLATE|AS|CHECK|UNIQUE)\b/i.test(tail)) {
        end = index;
        break;
      }
      // Some dialects write `DOUBLE PRECISION` or `TIMESTAMP WITH TIME ZONE`.
      if (!/^(PRECISION|VARYING|WITH|WITHOUT|TIME|ZONE|UNSIGNED)\b/i.test(tail)) {
        end = index;
        break;
      }
    }
  }

  const type = rest.slice(0, end).trim().replace(/,$/, "");
  return type || undefined;
}

/** The contents of the outermost `(...)`, respecting nesting and string literals. */
function balancedBody(statement: string): string | undefined {
  const start = statement.indexOf("(");
  if (start < 0) return undefined;

  let depth = 0;
  let quote: string | undefined;

  for (let index = start; index < statement.length; index += 1) {
    const char = statement[index]!;

    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return statement.slice(start + 1, index);
    }
  }
  return undefined;
}

/** Split on commas that are not inside brackets or quotes. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;

    if (quote) {
      current += char;
      if (char === "\\") {
        current += body[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "<") depth += 1;
    if (char === ")" || char === ">") depth -= 1;

    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current);
  return items;
}

/** Split on semicolons outside quotes. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let quote: string | undefined;
  let current = "";

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;

    if (quote) {
      current += char;
      if (char === "\\") {
        current += sql[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

/**
 * Remove comments, leaving string literals alone.
 *
 * A `--` inside a description is not a comment, and stripping it truncates the text at
 * a point that looks deliberate.
 */
function stripComments(sql: string): string {
  let out = "";
  let quote: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;

    if (quote) {
      out += char;
      if (char === "\\") {
        out += sql[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

/** The table name alone, with quoting and any `project.dataset.` prefix removed. */
function tableName(value: string): string {
  return bareName(value).split(".").pop() ?? "";
}

function bareName(value: string): string {
  return value.trim().replace(/^[`"[]|[`"\]]$/g, "").replace(/[`"[\]]/g, "");
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => bareName(item))
    .filter(Boolean);
}

function unescapeSql(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/''/g, "'");
}
