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
   * Dotted paths this version of the schema has no field for, e.g. `partitionBy`.
   *
   * Present on success. The object is still valid, still loaded, and still carries these
   * keys: they are preserved verbatim so a write-back cannot lose them. Nothing reads
   * them, which is worth saying out loud, because the usual cause is a key spelled the way
   * someone assumed rather than the way the schema names it.
   */
  unrecognised?: string[];
}

/**
 * Keys YAML supplied that the schema did not return, never assigned to an object.
 *
 * The `yaml` parser produces a real own `__proto__` key when a file contains one, and
 * `target["__proto__"] = value` reassigns the prototype rather than adding a property. A
 * model file is attacker-controlled the moment a workspace takes pull requests, so these
 * are reported like any other unrecognised key and then left on the floor.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface Reconciled {
  value: unknown;
  unrecognised: string[];
}

/**
 * Rebuild the parsed object with the keys the schema dropped put back, and name them.
 *
 * Compares the two objects rather than introspecting the schema, so it stays correct as
 * the schema grows and needs no per-kind knowledge. Recurses through nested objects and
 * arrays, which is where it matters most: a mistyped key inside `columns[]` is both the
 * easiest to make and the most expensive to lose.
 *
 * Carrying the key rather than dropping it is what makes a round trip safe. Stripping lets
 * a file written by a newer Strata *load* in an older one, but the next save then writes
 * the stripped object back and the field is gone, surfacing as a deletion in a pull request
 * no human authored. Preserved keys cost nothing to keep: no code reads them, and
 * `normalizeForWrite` sorts them to the end of the file, so the diff stays stable.
 */
function reconcile(input: unknown, parsed: unknown, prefix = ""): Reconciled {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    const unrecognised: string[] = [];
    const value = parsed.map((item, index) => {
      if (index >= input.length) return item;
      const child = reconcile(input[index], item, `${prefix}[${index}]`);
      unrecognised.push(...child.unrecognised);
      return child.value;
    });
    return { value, unrecognised };
  }

  if (!isPlainObject(input) || !isPlainObject(parsed)) return { value: parsed, unrecognised: [] };

  const value: Record<string, unknown> = { ...parsed };
  const unrecognised: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // Named and then dropped, before any recursion: `__proto__` must not be walked into
    // either, because `parsed.__proto__` is `Object.prototype` and descending it produces a
    // nonsense path and an assignment that reseats the prototype.
    if (UNSAFE_KEYS.has(key)) {
      unrecognised.push(path);
      continue;
    }

    // `hasOwnProperty`, not `in`: `in` consults the prototype chain, so every key that
    // shares a name with an `Object.prototype` member (`constructor`, `toString`) reads as
    // present on an object that has no such field of its own.
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      unrecognised.push(path);
      value[key] = raw;
      continue;
    }

    const child = reconcile(raw, parsed[key], path);
    unrecognised.push(...child.unrecognised);
    value[key] = child.value;
  }
  return { value, unrecognised };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate an untrusted object (e.g. freshly read from YAML). */
export function parseObject(input: unknown): ParseResult {
  const result = ObjectSchema.safeParse(input);
  if (result.success) {
    const { value, unrecognised } = reconcile(input, result.data);
    const object = value as AnyObject;
    return unrecognised.length > 0 ? { object, unrecognised } : { object };
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
