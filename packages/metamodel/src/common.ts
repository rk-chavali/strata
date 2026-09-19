import { z } from "zod";
import { ID_PATTERN } from "./ids.js";

/** The three modelling tiers, in refinement order. */
export const TIERS = ["conceptual", "logical", "physical"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const IdSchema = z
  .string()
  .min(1)
  .regex(ID_PATTERN, "must be a path-safe token (letters, digits, _ . : -)");

/**
 * A reference to another object, written as a readable qualified name rather
 * than an opaque id so diffs stay reviewable.
 *
 *   Customer                    object in the current model
 *   Customer.customer_id        member (attribute/column) of an object
 *   core_logical:Customer       object in a named sibling model
 *   analytics.dim_customer      dataset-qualified physical table
 */
export const RefSchema = z.string().min(1);
export type Ref = z.infer<typeof RefSchema>;

/**
 * Tier-neutral logical types. Physical models use warehouse-native type strings
 * instead (see `physical.ts`); this enum is what conceptual and logical objects
 * speak, and what domains translate from.
 */
export const LOGICAL_TYPES = [
  "string",
  "text",
  "integer",
  "bigint",
  "decimal",
  "float",
  "boolean",
  "date",
  "time",
  "timestamp",
  "datetime",
  "interval",
  "json",
  "binary",
  "geography",
  "uuid",
  "enum",
  "struct",
  "array",
  "unknown",
] as const;
export const LogicalTypeSchema = z.enum(LOGICAL_TYPES);
export type LogicalType = z.infer<typeof LogicalTypeSchema>;

export const SENSITIVITY_LEVELS = ["public", "internal", "confidential", "restricted"] as const;
export const DATA_CATEGORIES = [
  "pii",
  "phi",
  "pci",
  "financial",
  "credential",
  "biometric",
  "location",
  "contact",
  "demographic",
] as const;

/**
 * Governance annotations. These are the source for generated BigQuery policy
 * tags, column-level security bindings and subject-erasure reports, so they are
 * first-class on the model rather than bolted on in a side system.
 */
export const ClassificationSchema = z.object({
  sensitivity: z.enum(SENSITIVITY_LEVELS).optional(),
  categories: z.array(z.enum(DATA_CATEGORIES)).default([]),
  /** Fully qualified Dataplex policy tag, e.g. `projects/p/locations/eu/taxonomies/123/policyTags/456`. */
  policyTag: z.string().optional(),
  /** Logical taxonomy name, resolved to a policyTag at generation time. */
  policyTagName: z.string().optional(),
  retentionDays: z.number().int().positive().optional(),
  residency: z.string().optional(),
  maskingRule: z.string().optional(),
  /** Marks the column as identifying a data subject, for erasure mapping. */
  subjectIdentifier: z.boolean().optional(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const OwnershipSchema = z.object({
  owner: z.string().optional(),
  steward: z.string().optional(),
  team: z.string().optional(),
});
export type Ownership = z.infer<typeof OwnershipSchema>;

export const LIFECYCLE_STATES = ["draft", "in_review", "approved", "deprecated", "retired"] as const;
export const LifecycleSchema = z.enum(LIFECYCLE_STATES);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/**
 * Fields shared by every stored object.
 *
 * `properties` is the user-defined-property escape hatch. Enterprises migrating
 * off erwin depend heavily on UDPs, and refusing them is a migration blocker,
 * so every object accepts arbitrary extra metadata that we round-trip untouched.
 */
export const BaseObjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /**
   * Model this object belongs to, by name.
   *
   * Stated explicitly in the file rather than inferred from the directory it sits
   * in. That is what lets a team reorganise the repo however they like, move a
   * file, rename a folder, flatten the whole tree, without changing meaning.
   *
   * Omitted for workspace-scoped objects (domains, glossary terms, naming
   * standards) that are shared across every model.
   */
  model: RefSchema.optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  properties: z.record(z.unknown()).default({}),
  ownership: OwnershipSchema.optional(),
  lifecycle: LifecycleSchema.optional(),
  /**
   * Names this object has had before. Written automatically on rename so that
   * references in repos we do not control (and older commits) can still be
   * resolved, and so merges can follow the rename.
   */
  previousNames: z.array(z.string()).default([]),
});
export type BaseObject = z.infer<typeof BaseObjectSchema>;

export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A single validation or lint finding. */
export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. `ref/unresolved` or `naming/case`. */
  code: string;
  message: string;
  /** Id of the object the finding belongs to, when known. */
  objectId?: string;
  /** Dotted path within the object, e.g. `columns[3].dataType`. */
  path?: string;
  /** Repo-relative file the object was loaded from, when known. */
  file?: string;
  /** Optional suggested replacement, for autofixable findings. */
  fix?: { path: string; value: unknown };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function countBySeverity(diagnostics: readonly Diagnostic[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}
