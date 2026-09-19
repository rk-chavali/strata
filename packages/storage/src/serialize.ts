import { LineCounter, parseAllDocuments, stringify } from "yaml";

/**
 * YAML serialization tuned for git.
 *
 * Three properties matter more than anything else here, because they determine
 * whether a pull request diff is reviewable:
 *
 *  1. **Deterministic key order.** The same model always serialises identically,
 *     so a diff shows what changed and nothing else.
 *  2. **No line wrapping.** Reflowed prose turns a one-word edit into a
 *     twelve-line diff.
 *  3. **Defaults omitted.** Writing `tags: []` on every object buries the
 *     signal. Absent means default, and the schema fills it back in on read.
 */

/**
 * Preferred key order. Keys listed here come first, in this order; anything else
 * follows alphabetically. One global list works because key names are consistent
 * across kinds, and it keeps the important fields at the top of every file.
 */
const KEY_ORDER = [
  "id",
  "kind",
  "name",
  "model",
  "tier",
  "displayName",
  "description",
  "definition",
  "lifecycle",
  "deprecated",
  "subjectArea",
  "layer",
  "entityType",
  "objectType",
  "logicalType",
  "physicalType",
  "dataType",
  "mode",
  "required",
  "nullable",
  "project",
  "dataset",
  "target",
  "derivedFrom",
  "domain",
  "attributes",
  "columns",
  "fields",
  "primaryKey",
  "alternateKeys",
  "uniqueKeys",
  "foreignKeys",
  "partitioning",
  "clustering",
  "parent",
  "child",
  "sources",
  "columnMappings",
  "loadStrategy",
  "dimensional",
  "nodes",
  "edges",
  "groups",
  "options",
  "dataform",
  "classification",
  "ownership",
  "tags",
  "properties",
  "previousNames",
] as const;

const KEY_RANK = new Map<string, number>(KEY_ORDER.map((key, index) => [key, index]));

function compareKeys(a: string, b: string): number {
  const rankA = KEY_RANK.get(a) ?? Number.MAX_SAFE_INTEGER;
  const rankB = KEY_RANK.get(b) ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return a.localeCompare(b);
}

/**
 * Recursively drop defaulted-empty values and order keys.
 *
 * Booleans and zeros are always kept, even when they equal the schema default, * an explicit `requireFilter: false` is a statement of intent, and silently
 * deleting a user's words is worse than a slightly longer file.
 */
export function normalizeForWrite(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForWrite);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareKeys)) {
    const normalized = normalizeForWrite(source[key]);
    if (isOmittable(normalized)) continue;
    result[key] = normalized;
  }
  return result;
}

function isOmittable(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}

const STRINGIFY_OPTIONS = {
  /** Never wrap: reflowed prose produces diffs that hide the real change. */
  lineWidth: 0,
  /** Multi-line strings (descriptions, SQL) become readable literal blocks. */
  blockQuote: "literal" as const,
  indent: 2,
  /** Keep nested sequences indented under their key, which reads better in diffs. */
  indentSeq: true,
  nullStr: "null",
};

/** Serialize one object to a YAML document. */
export function serializeObject(object: unknown): string {
  return stringify(normalizeForWrite(object), STRINGIFY_OPTIONS);
}

/**
 * Serialize several objects to one multi-document YAML file.
 *
 * This is what makes layouts like `single-file-per-model` work, and what happens
 * whenever a template resolves two objects to the same path.
 */
export function serializeDocuments(objects: readonly unknown[]): string {
  if (objects.length === 0) return "";
  if (objects.length === 1) return serializeObject(objects[0]);
  return objects.map((object) => `---\n${serializeObject(object)}`).join("");
}

export interface RawDocument {
  value: unknown;
  /** Zero-based position within a multi-document file. */
  index: number;
  /** One-based line the document starts on, for diagnostics. */
  line: number;
}

export interface ParsedFile {
  documents: RawDocument[];
  /** YAML syntax errors. A file with errors yields whatever documents did parse. */
  errors: { message: string; line: number }[];
}

/** Parse a YAML file that may contain several documents. */
export function parseYamlFile(text: string): ParsedFile {
  const lineCounter = new LineCounter();
  const parsed = parseAllDocuments(text, { lineCounter });

  const documents: RawDocument[] = [];
  const errors: { message: string; line: number }[] = [];

  for (const [index, doc] of parsed.entries()) {
    const startOffset = doc.range?.[0] ?? 0;
    const line = lineCounter.linePos(startOffset).line;

    for (const error of doc.errors) {
      errors.push({
        message: error.message,
        line: lineCounter.linePos(error.pos[0]).line,
      });
    }
    if (doc.errors.length > 0) continue;

    const value = doc.toJS({ mapAsMap: false });
    // A document that is entirely comments or blank parses to null; skip it
    // rather than reporting it as a malformed object.
    if (value === null || value === undefined) continue;
    documents.push({ value, index, line });
  }

  return { documents, errors };
}

/**
 * Whether a parsed document looks like one of ours.
 *
 * A repo scanned by `roots: ["."]` will contain YAML that has nothing to do with
 * data modelling, CI workflows, Docker Compose files, linter configs. The
 * presence of a top-level `kind` is the marker. Files without one are skipped
 * silently; files *with* one that fail validation are reported loudly, so a typo
 * in a real model file never passes unnoticed.
 */
export function looksLikeModelObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}
