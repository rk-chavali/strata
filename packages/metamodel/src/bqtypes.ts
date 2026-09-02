import type { LogicalType } from "./common.js";

/**
 * BigQuery type handling: parsing, validation, and the logical-to-physical
 * mapping used by forward engineering.
 *
 * We validate type strings with a small parser rather than an enum because
 * BigQuery types are parameterised (`NUMERIC(18, 2)`, `STRING(50)`) and
 * composable (`ARRAY<STRUCT<a INT64>>`). A parser also gives us the type
 * comparison needed to classify schema changes as safe or breaking.
 */

/** Scalar type names, including the legacy aliases BigQuery still accepts. */
export const BQ_SCALAR_TYPES = [
  "STRING",
  "BYTES",
  "INT64",
  "INTEGER",
  "SMALLINT",
  "BIGINT",
  "TINYINT",
  "BYTEINT",
  "FLOAT64",
  "FLOAT",
  "NUMERIC",
  "DECIMAL",
  "BIGNUMERIC",
  "BIGDECIMAL",
  "BOOL",
  "BOOLEAN",
  "DATE",
  "DATETIME",
  "TIME",
  "TIMESTAMP",
  "GEOGRAPHY",
  "JSON",
  "INTERVAL",
] as const;

/** Canonical name for each alias, so comparisons do not trip over synonyms. */
const CANONICAL: Record<string, string> = {
  INTEGER: "INT64",
  SMALLINT: "INT64",
  BIGINT: "INT64",
  TINYINT: "INT64",
  BYTEINT: "INT64",
  FLOAT: "FLOAT64",
  DECIMAL: "NUMERIC",
  BIGDECIMAL: "BIGNUMERIC",
  BOOLEAN: "BOOL",
  RECORD: "STRUCT",
};

export interface ParsedType {
  /** Canonical base name, e.g. `INT64`, `NUMERIC`, `STRUCT`, `ARRAY`, `RANGE`. */
  base: string;
  /** Numeric parameters, e.g. `[18, 2]` for `NUMERIC(18, 2)`. */
  parameters: number[];
  /** Element type for `ARRAY<...>` and `RANGE<...>`. */
  elementType?: ParsedType;
  /** Named fields for `STRUCT<...>`. */
  fields?: { name?: string; type: ParsedType }[];
}

export class TypeParseError extends Error {}

/** Parse a BigQuery type string. Throws `TypeParseError` on malformed input. */
export function parseBigQueryType(input: string): ParsedType {
  const parser = new TypeParser(input);
  const parsed = parser.parseType();
  parser.expectEnd();
  return parsed;
}

/** Non-throwing variant, for validation paths that collect diagnostics. */
export function tryParseBigQueryType(input: string): ParsedType | { error: string } {
  try {
    return parseBigQueryType(input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

class TypeParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseType(): ParsedType {
    this.skipWhitespace();
    const name = this.readIdentifier();
    if (!name) throw new TypeParseError(`expected a type name at position ${this.pos}`);
    const base = CANONICAL[name.toUpperCase()] ?? name.toUpperCase();

    this.skipWhitespace();

    if (base === "ARRAY" || base === "RANGE") {
      if (this.peek() !== "<") {
        // Bare ARRAY is legal in some contexts (mode REPEATED carries the arity).
        return { base, parameters: [] };
      }
      this.expect("<");
      const elementType = this.parseType();
      this.skipWhitespace();
      this.expect(">");
      return { base, parameters: [], elementType };
    }

    if (base === "STRUCT") {
      if (this.peek() !== "<") return { base, parameters: [] };
      this.expect("<");
      const fields: { name?: string; type: ParsedType }[] = [];
      this.skipWhitespace();
      if (this.peek() === ">") {
        this.expect(">");
        return { base, parameters: [], fields };
      }
      for (;;) {
        this.skipWhitespace();
        fields.push(this.parseStructField());
        this.skipWhitespace();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.skipWhitespace();
      this.expect(">");
      return { base, parameters: [], fields };
    }

    if (!isKnownScalar(base)) {
      throw new TypeParseError(`unknown BigQuery type \`${name}\``);
    }

    const parameters: number[] = [];
    if (this.peek() === "(") {
      this.expect("(");
      for (;;) {
        this.skipWhitespace();
        const num = this.readNumberOrMax();
        parameters.push(num);
        this.skipWhitespace();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        break;
      }
      this.skipWhitespace();
      this.expect(")");
    }
    return { base, parameters };
  }

  /**
   * A struct field is either `name TYPE` or a bare `TYPE`. Distinguishing them
   * requires lookahead: read an identifier, and if another type token follows,
   * the first was a field name.
   */
  private parseStructField(): { name?: string; type: ParsedType } {
    const checkpoint = this.pos;
    const first = this.readIdentifier();
    if (!first) throw new TypeParseError(`expected a field type at position ${this.pos}`);
    this.skipWhitespace();
    const next = this.peek();
    const looksLikeTypeFollows = Boolean(next) && next !== "," && next !== ">" && next !== "(" && next !== "<";
    if (looksLikeTypeFollows) {
      return { name: first, type: this.parseType() };
    }
    this.pos = checkpoint;
    return { type: this.parseType() };
  }

  expectEnd(): void {
    this.skipWhitespace();
    if (this.pos < this.src.length) {
      throw new TypeParseError(`unexpected trailing input \`${this.src.slice(this.pos)}\``);
    }
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private expect(char: string): void {
    if (this.src[this.pos] !== char) {
      throw new TypeParseError(`expected \`${char}\` at position ${this.pos}`);
    }
    this.pos++;
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  private readIdentifier(): string | undefined {
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z_0-9]/.test(this.src[this.pos]!)) this.pos++;
    return this.pos > start ? this.src.slice(start, this.pos) : undefined;
  }

  private readNumberOrMax(): number {
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9A-Za-z]/.test(this.src[this.pos]!)) this.pos++;
    const raw = this.src.slice(start, this.pos);
    // `STRING(MAX)` and `BYTES(MAX)` are valid; we model MAX as -1.
    if (raw.toUpperCase() === "MAX") return -1;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new TypeParseError(`expected a numeric type parameter, got \`${raw}\``);
    }
    return num;
  }
}

function isKnownScalar(canonicalBase: string): boolean {
  return (BQ_SCALAR_TYPES as readonly string[]).includes(canonicalBase);
}

/** Render a parsed type back to canonical BigQuery syntax. */
export function formatBigQueryType(type: ParsedType): string {
  if (type.base === "ARRAY" || type.base === "RANGE") {
    return type.elementType ? `${type.base}<${formatBigQueryType(type.elementType)}>` : type.base;
  }
  if (type.base === "STRUCT") {
    if (!type.fields) return "STRUCT";
    const inner = type.fields
      .map((f) => (f.name ? `${f.name} ${formatBigQueryType(f.type)}` : formatBigQueryType(f.type)))
      .join(", ");
    return `STRUCT<${inner}>`;
  }
  if (type.parameters.length) {
    const params = type.parameters.map((p) => (p === -1 ? "MAX" : String(p))).join(", ");
    return `${type.base}(${params})`;
  }
  return type.base;
}

/** Canonicalise a type string, resolving aliases. Returns input unchanged if unparseable. */
export function canonicalizeType(input: string): string {
  const parsed = tryParseBigQueryType(input);
  return "error" in parsed ? input : formatBigQueryType(parsed);
}

/**
 * How disruptive a column type change is.
 *
 * This drives the migration planner. BigQuery's `ALTER TABLE` support is narrow:
 * widening a few specific types is a metadata-only operation, but most other
 * changes require creating a new table, backfilling, and swapping. Knowing which
 * is which up front is the difference between a five-second change and an
 * unplanned outage.
 */
export type ChangeImpact = "none" | "safe" | "requiresRebuild" | "destructive";

/**
 * Type relaxations BigQuery performs in place, as a metadata-only operation.
 *
 * Sourced from BigQuery's documented schema modifications. Worth re-verifying
 * against current docs periodically, the set has grown over time, and a stale
 * entry here would make us recommend a rebuild that is no longer necessary.
 */
const SAFE_WIDENINGS = new Set([
  "INT64->NUMERIC",
  "INT64->BIGNUMERIC",
  "INT64->FLOAT64",
  "NUMERIC->BIGNUMERIC",
  "NUMERIC->FLOAT64",
  "BIGNUMERIC->FLOAT64",
]);

/** Severity order, least to most disruptive. */
const IMPACT_ORDER: readonly ChangeImpact[] = ["none", "safe", "requiresRebuild", "destructive"];

function worst(a: ChangeImpact, b: ChangeImpact): ChangeImpact {
  return IMPACT_ORDER.indexOf(a) >= IMPACT_ORDER.indexOf(b) ? a : b;
}

/**
 * Classify a column type change.
 *
 * Deliberately conservative: when we cannot prove a change is safe we return
 * `requiresRebuild`, because a wrong "safe" verdict is the expensive kind of
 * wrong, it turns into a failed deploy or, worse, silent truncation.
 */
export function classifyTypeChange(from: string, to: string): ChangeImpact {
  const a = tryParseBigQueryType(from);
  const b = tryParseBigQueryType(to);
  if ("error" in a || "error" in b) return "requiresRebuild";
  return compareTypes(a, b);
}

function compareTypes(a: ParsedType, b: ParsedType): ChangeImpact {
  if (formatBigQueryType(a) === formatBigQueryType(b)) return "none";

  if (a.base === "STRUCT" && b.base === "STRUCT") return compareStructs(a, b);

  if ((a.base === "ARRAY" || a.base === "RANGE") && a.base === b.base) {
    if (!a.elementType || !b.elementType) return "requiresRebuild";
    const inner = compareTypes(a.elementType, b.elementType);
    if (inner === "none") return "none";
    // An array's element type cannot be relaxed in place even when the
    // equivalent scalar change could be.
    return inner === "destructive" ? "destructive" : "requiresRebuild";
  }

  if (a.base !== b.base) {
    return SAFE_WIDENINGS.has(`${a.base}->${b.base}`) ? "safe" : "requiresRebuild";
  }

  // Same scalar base, different parameters. Widening is safe; narrowing truncates.
  const [aPrecisionRaw = Infinity, aScale = 0] = a.parameters;
  const [bPrecisionRaw = Infinity, bScale = 0] = b.parameters;
  const aPrecision = aPrecisionRaw === -1 ? Infinity : aPrecisionRaw;
  const bPrecision = bPrecisionRaw === -1 ? Infinity : bPrecisionRaw;
  return bPrecision >= aPrecision && bScale >= aScale ? "safe" : "destructive";
}

/**
 * Compare two STRUCT shapes.
 *
 * BigQuery permits appending a nested field to an existing STRUCT in place, so
 * additions at the end are safe. Removing a field loses data, and renaming or
 * reordering fields cannot be expressed as an in-place alter at all.
 */
function compareStructs(a: ParsedType, b: ParsedType): ChangeImpact {
  if (!a.fields || !b.fields) return "requiresRebuild";

  let impact: ChangeImpact = "none";
  for (const [i, aField] of a.fields.entries()) {
    const bField = b.fields[i];
    if (!bField) return "destructive";
    if ((aField.name ?? "") !== (bField.name ?? "")) return "requiresRebuild";
    impact = worst(impact, compareTypes(aField.type, bField.type));
  }
  if (b.fields.length > a.fields.length) {
    impact = worst(impact, "safe");
  }
  return impact;
}

/** Default logical-to-BigQuery type mapping used when forward engineering. */
export const LOGICAL_TO_BIGQUERY: Record<LogicalType, string> = {
  string: "STRING",
  text: "STRING",
  integer: "INT64",
  bigint: "INT64",
  decimal: "NUMERIC",
  float: "FLOAT64",
  boolean: "BOOL",
  date: "DATE",
  time: "TIME",
  timestamp: "TIMESTAMP",
  datetime: "DATETIME",
  interval: "INTERVAL",
  json: "JSON",
  binary: "BYTES",
  geography: "GEOGRAPHY",
  uuid: "STRING",
  enum: "STRING",
  struct: "STRUCT",
  array: "ARRAY",
  unknown: "STRING",
};

/** Types BigQuery permits as a time-partitioning column. */
export const TIME_PARTITION_TYPES = new Set(["DATE", "DATETIME", "TIMESTAMP"]);

/** BigQuery allows at most this many clustering columns. */
export const MAX_CLUSTERING_COLUMNS = 4;

/** Identifier rules for datasets, tables and columns. */
export const BQ_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_COLUMN_NAME_LENGTH = 300;
export const MAX_TABLE_NAME_LENGTH = 1024;
export const MAX_DATASET_NAME_LENGTH = 1024;
