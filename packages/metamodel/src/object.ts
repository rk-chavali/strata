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
}

/** Parse and validate an untrusted object (e.g. freshly read from YAML). */
export function parseObject(input: unknown): ParseResult {
  const result = ObjectSchema.safeParse(input);
  if (result.success) return { object: result.data };

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
