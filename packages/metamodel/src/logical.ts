import { z } from "zod";
import {
  BaseObjectSchema,
  ClassificationSchema,
  IdSchema,
  LogicalTypeSchema,
  RefSchema,
} from "./common.js";

/**
 * An attribute of a logical entity.
 *
 * Type information comes from one of two places: a `domain` reference (preferred
 *, it is how standards propagate) or inline `logicalType` plus facets. Inline
 * types are permitted because forcing a domain for every one-off attribute makes
 * the tool annoying, but the linter can be configured to require them.
 */
export const AttributeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  description: z.string().optional(),

  domain: RefSchema.optional(),
  logicalType: LogicalTypeSchema.optional(),
  length: z.number().int().positive().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),

  required: z.boolean().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  allowedValues: z.array(z.union([z.string(), z.number()])).default([]),

  /** True when this attribute exists only because a relationship migrated it. */
  inherited: z.boolean().default(false),
  /** The relationship that migrated this attribute, when `inherited`. */
  inheritedFrom: RefSchema.optional(),

  /** Business rule expression for derived attributes, in prose or SQL. */
  derivation: z.string().optional(),

  classification: ClassificationSchema.optional(),
  tags: z.array(z.string()).default([]),
  properties: z.record(z.unknown()).default({}),
  previousNames: z.array(z.string()).default([]),

  /** Trace back to the conceptual tier. */
  conceptRef: RefSchema.optional(),
  /** Glossary term defining this attribute's meaning. */
  glossaryTerm: RefSchema.optional(),
});
export type Attribute = z.infer<typeof AttributeSchema>;

export const ENTITY_TYPES = [
  "entity",
  /** Resolves a many-to-many; owns no independent identity. */
  "associative",
  /** Identity depends on a parent entity. */
  "weak",
  /** Abstract parent in a supertype/subtype cluster. */
  "supertype",
  /** Specialisation of a supertype. */
  "subtype",
] as const;

export const KeySchema = z.object({
  name: z.string().min(1),
  attributes: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
});
export type Key = z.infer<typeof KeySchema>;

/**
 * A logical entity: attributes, keys, and inheritance, but no dataset, no
 * partitioning, no warehouse types. Everything platform-specific belongs to the
 * physical tier, so one logical model can drive several physical ones (staging,
 * core, marts) without contamination.
 */
export const EntitySchema = BaseObjectSchema.extend({
  kind: z.literal("entity"),
  entityType: z.enum(ENTITY_TYPES).default("entity"),
  subjectArea: RefSchema.optional(),

  attributes: z.array(AttributeSchema).default([]),

  /** Attribute names forming the primary key, in order. */
  primaryKey: z.array(z.string()).default([]),
  /** Additional uniqueness constraints. Each compiles to a uniqueness assertion. */
  alternateKeys: z.array(KeySchema).default([]),

  /** Supertype entity, for a subtype. */
  supertype: RefSchema.optional(),
  /** Attribute whose value selects the subtype. */
  subtypeDiscriminator: z.string().optional(),
  /** Discriminator value identifying this specific subtype. */
  subtypeValue: z.string().optional(),
  /** Whether subtypes are mutually exclusive and cover the supertype. */
  subtypeCompleteness: z.enum(["complete", "incomplete"]).optional(),

  /** Trace back to the conceptual tier. */
  conceptRef: RefSchema.optional(),

  /** Business rules that cannot be expressed structurally. */
  constraints: z
    .array(
      z.object({
        name: z.string().min(1),
        expression: z.string().min(1),
        description: z.string().optional(),
        /** Emit a Dataform assertion for this rule. */
        assert: z.boolean().default(true),
      }),
    )
    .default([]),
});
export type Entity = z.infer<typeof EntitySchema>;

/** Look up an attribute on an entity by name, case-insensitively. */
export function findAttribute(entity: Entity, name: string): Attribute | undefined {
  const lower = name.toLowerCase();
  return entity.attributes.find((a) => a.name.toLowerCase() === lower);
}

/** Attributes that make up the primary key, in key order. Unknown names are skipped. */
export function primaryKeyAttributes(entity: Entity): Attribute[] {
  const found: Attribute[] = [];
  for (const name of entity.primaryKey) {
    const attr = findAttribute(entity, name);
    if (attr) found.push(attr);
  }
  return found;
}
