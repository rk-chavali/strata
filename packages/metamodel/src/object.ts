import { z } from "zod";
import { ConceptSchema, GlossaryTermSchema, SubjectAreaSchema } from "./conceptual.js";
import { DiagramSchema } from "./diagram.js";
import { DomainSchema, NamingStandardSchema } from "./domain.js";
import { EntitySchema } from "./logical.js";
import { MappingSchema } from "./mapping.js";
import { ModelSchema } from "./model.js";
import { RelationshipSchema } from "./relationship.js";
import { TableSchema } from "./physical.js";

/**
 * The set of everything that can be stored as a file.
 *
 * Every object is self-describing: it carries its own `kind`, `id` and owning
 * `model`. That is what makes the loader layout-independent, it globs files,
 * reads what each one says it is, and never infers meaning from the path.
 */
export const ObjectSchema = z.discriminatedUnion("kind", [
  ModelSchema,
  SubjectAreaSchema,
  GlossaryTermSchema,
  DomainSchema,
  NamingStandardSchema,
  ConceptSchema,
  EntitySchema,
  TableSchema,
  RelationshipSchema,
  MappingSchema,
  DiagramSchema,
]);

export type AnyObject = z.infer<typeof ObjectSchema>;
export type ObjectKind = AnyObject["kind"];

export const OBJECT_KINDS = [
  "model",
  "subjectArea",
  "glossaryTerm",
  "domain",
  "namingStandard",
  "concept",
  "entity",
  "table",
  "relationship",
  "mapping",
  "diagram",
] as const satisfies readonly ObjectKind[];

/** Kinds that are shared across every model rather than belonging to one. */
export const WORKSPACE_SCOPED_KINDS = new Set<ObjectKind>([
  "domain",
  "glossaryTerm",
  "namingStandard",
]);

/** Which tier each kind belongs to. `undefined` means the kind is tier-neutral. */
export const KIND_TIER: Partial<Record<ObjectKind, "conceptual" | "logical" | "physical">> = {
  concept: "conceptual",
  entity: "logical",
  table: "physical",
};

/** Narrow an object to a given kind. */
export function isKind<K extends ObjectKind>(
  object: AnyObject,
  kind: K,
): object is Extract<AnyObject, { kind: K }> {
  return object.kind === kind;
}

export interface ParseResult {
  object?: AnyObject;
  error?: string;
  /** Field-level issues, when the failure was a schema violation. */
  issues?: { path: string; message: string }[];
  /**
   * Dotted paths the schema accepted the file without, e.g. `partitionBy`.
   *
   * Present on success. The object is still valid and still loaded; these are the parts of
   * the file that had no effect, which is worth saying out loud because the usual cause is
   * a key spelled the way someone assumed rather than the way the schema names it.
   */
  discarded?: string[];
}

/**
 * Keys present in the parsed input but absent from what the schema returned.
 *
 * Compares the two objects rather than introspecting the schema, so it stays correct as
 * the schema grows and needs no per-kind knowledge. Recurses through nested objects and
 * arrays, which is where it matters most: a mistyped key inside `columns[]` is both the
 * easiest to make and the most expensive to lose.
 */
function discardedPaths(input: unknown, parsed: unknown, prefix = ""): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((item, index) =>
      index < parsed.length ? discardedPaths(item, parsed[index], `${prefix}[${index}]`) : [],
    );
  }

  if (!isPlainObject(input) || !isPlainObject(parsed)) return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in parsed)) {
      found.push(path);
      continue;
    }
    found.push(...discardedPaths(value, parsed[key], path));
  }
  return found;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate an untrusted object (e.g. freshly read from YAML). */
export function parseObject(input: unknown): ParseResult {
  const result = ObjectSchema.safeParse(input);
  if (result.success) {
    const discarded = discardedPaths(input, result.data);
    return discarded.length > 0
      ? { object: result.data, discarded }
      : { object: result.data };
  }

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

  // A missing or unrecognised `kind` produces an unhelpful union error, so we
  // detect that case and say what actually went wrong.
  const kind = (input as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string") {
    return { error: "object is missing a `kind` field", issues };
  }
  if (!(OBJECT_KINDS as readonly string[]).includes(kind)) {
    return {
      error: `unknown kind \`${kind}\` (expected one of: ${OBJECT_KINDS.join(", ")})`,
      issues,
    };
  }
  return { error: issues.map((i) => `${i.path || "<root>"}: ${i.message}`).join("; "), issues };
}
