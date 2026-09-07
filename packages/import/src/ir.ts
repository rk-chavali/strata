/**
 * The neutral shape every reader produces.
 *
 * One intermediate representation, not a direct source-to-metamodel mapping per format.
 * Three readers each doing their own mapping means three subtly different answers to
 * "what is a primary key", and the differences only surface months later when someone
 * notices the CSV import lost the identifying relationships. The readers' job is to say
 * what they found; the mapper's job is to decide what it means.
 *
 * Everything here is deliberately loose, `string` types, optional everything, because
 * a source file is not trusted input. Validation happens once, on the way out, against
 * the real schemas.
 */

export interface SourceColumn {
  name: string;
  /** As written in the source. Translated to a BigQuery type later, not here. */
  type?: string;
  required?: boolean;
  isPrimaryKey?: boolean;
  description?: string;
  /** erwin domain, or a CSV column saying which reusable type this uses. */
  domain?: string;
}

export interface SourceEntity {
  name: string;
  /** erwin keeps a separate physical name; both are worth carrying. */
  physicalName?: string;
  description?: string;
  /** Free-text grouping from the source, erwin subject area, or a CSV column. */
  subjectArea?: string;
  schema?: string;
  columns: SourceColumn[];
}

export interface SourceRelationship {
  name?: string;
  parent: string;
  child: string;
  /** Verbatim from the source; normalised to our vocabulary by the mapper. */
  cardinality?: string;
  identifying?: boolean;
  parentColumns?: string[];
  childColumns?: string[];
}

/** A reusable type, erwin calls these domains, and so do we. */
export interface SourceDomain {
  name: string;
  type?: string;
  description?: string;
}

export interface ImportDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** Where in the source, when the reader can say, a line, an element, a row. */
  at?: string;
}

export interface SourceModel {
  /** What the reader thinks this is. The user can override before applying. */
  name?: string;
  tier?: "conceptual" | "logical" | "physical";
  entities: SourceEntity[];
  relationships: SourceRelationship[];
  domains: SourceDomain[];
  diagnostics: ImportDiagnostic[];
  /** Which reader produced this, shown in the preview so the user can tell. */
  format: string;
}

/**
 * Map a source datatype onto our logical type vocabulary.
 *
 * The logical tier deliberately has a closed set of types, `string`, `decimal`,
 * `timestamp`, rather than free text, so that one logical model can target more than
 * one warehouse. A source type like `VARCHAR(200)` or `DECIMAL(18,2)` therefore has to
 * be classified, and the original kept alongside as the physical type rather than
 * thrown away.
 *
 * Anything unrecognised becomes `unknown`, which is a valid value: it imports cleanly
 * and shows up in validation as something a human should look at. Guessing `string`
 * would hide it.
 */
export function toLogicalType(raw: string | undefined): string {
  if (!raw) return "unknown";
  const value = raw.trim().toLowerCase();

  if (/^(var)?char|^n(var)?char|^string|^clob/.test(value)) return "string";
  if (/^text|^longtext|^ntext/.test(value)) return "text";
  if (/^bigint|^int64|^long/.test(value)) return "bigint";
  if (/^(tiny|small|medium)?int|^integer|^serial/.test(value)) return "integer";
  if (/^decimal|^numeric|^number|^money|^bignumeric/.test(value)) return "decimal";
  if (/^float|^double|^real/.test(value)) return "float";
  if (value.startsWith("bool")) return "boolean";
  if (value.startsWith("datetime")) return "datetime";
  if (value.startsWith("timestamp")) return "timestamp";
  if (value.startsWith("date")) return "date";
  if (value.startsWith("time")) return "time";
  if (value.startsWith("interval")) return "interval";
  if (value.startsWith("json")) return "json";
  if (/^bytes|^binary|^blob|^varbinary/.test(value)) return "binary";
  if (/^geograph|^geometry|^point/.test(value)) return "geography";
  if (/^uuid|^uniqueidentifier/.test(value)) return "uuid";
  if (value.startsWith("enum")) return "enum";
  if (/^struct|^record/.test(value)) return "struct";
  if (value.startsWith("array")) return "array";

  return "unknown";
}

/**
 * Split a source cardinality into the pair our metamodel stores.
 *
 * Cardinality lives on each *end* here, `exactly-one` on the parent, `zero-or-more` on
 * the child, rather than as one phrase on the relationship. Sources say it the other
 * way round, so the translation has to happen somewhere, and doing it once here beats
 * three readers each getting it subtly wrong.
 */
export function cardinalityEnds(phrase: string | undefined): { parent: string; child: string } {
  switch (phrase) {
    case "one-to-one":
      return { parent: "exactly-one", child: "zero-or-one" };
    case "many-to-many":
      return { parent: "zero-or-more", child: "zero-or-more" };
    // `many-to-one` describes the same fact as `one-to-many` read from the child's end,
    // and parent/child are already identified, so it maps to the same pair.
    case "many-to-one":
    case "one-to-many":
    default:
      return { parent: "exactly-one", child: "zero-or-more" };
  }
}

export function emptyModel(format: string): SourceModel {
  return { entities: [], relationships: [], domains: [], diagnostics: [], format };
}

/**
 * Normalise a cardinality phrase onto our four values.
 *
 * Sources spell this every possible way, `1:M`, `One-to-Many`, `ZeroOrMore`, `0..*`, * and getting it wrong silently inverts a relationship. Anything unrecognised returns
 * undefined so the caller can record a diagnostic rather than guess.
 */
export function normaliseCardinality(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase().replace(/[\s_-]/g, "");

  if (/^(1:1|onetoone|exactlyone|zeroorone|0\.\.1|1\.\.1)$/.test(value)) return "one-to-one";
  if (/^(1:m|1:n|onetomany|zeroormore|oneormore|0\.\.\*|1\.\.\*|1\.\.n)$/.test(value)) return "one-to-many";
  if (/^(m:n|m:m|manytomany|\*\.\.\*)$/.test(value)) return "many-to-many";
  if (/^(m:1|n:1|manytoone)$/.test(value)) return "many-to-one";
  return undefined;
}

/**
 * A name safe to use as an identifier, without destroying the original.
 *
 * erwin logical names are prose, `Customer Order Line`, and carrying that through
 * verbatim produces ids nothing can reference. The original is kept as the display
 * name; this is only for the id.
 */
export function identifierise(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "unnamed"
  );
}
