import { z } from "zod";
import { BaseObjectSchema, RefSchema, TierSchema } from "./common.js";

export const CARDINALITIES = ["zero-or-one", "exactly-one", "zero-or-more", "one-or-more"] as const;
export const CardinalitySchema = z.enum(CARDINALITIES);
export type Cardinality = z.infer<typeof CardinalitySchema>;

/** Crow's-foot glyph pair for a cardinality, used when rendering diagrams. */
export const CARDINALITY_NOTATION: Record<Cardinality, string> = {
  "zero-or-one": "|o",
  "exactly-one": "||",
  "zero-or-more": "}o",
  "one-or-more": "}|",
};

export const RelationshipEndSchema = z.object({
  /** The entity, concept or table at this end. */
  ref: RefSchema,
  cardinality: CardinalitySchema,
  /**
   * Reading phrase from this end towards the other, e.g. "places" so the
   * relationship reads "Customer places zero-or-more Order".
   */
  verbPhrase: z.string().optional(),
  /**
   * Role name, used when the same entity appears twice in a relationship
   * (a self-reference like manager/report) to keep migrated keys distinct.
   */
  roleName: z.string().optional(),
  /** Attribute or column names participating at this end. */
  attributes: z.array(z.string()).default([]),
});
export type RelationshipEnd = z.infer<typeof RelationshipEndSchema>;

/**
 * A relationship between two objects in the same tier.
 *
 * Relationships are stored as their own objects rather than embedded in either
 * participant. That is a deliberate choice for git: a relationship change touches
 * one file instead of two, which removes a whole class of merge conflict when two
 * people edit connected entities at the same time.
 */
export const RelationshipSchema = BaseObjectSchema.extend({
  kind: z.literal("relationship"),
  tier: TierSchema,

  parent: RelationshipEndSchema,
  child: RelationshipEndSchema,

  /**
   * Identifying relationships migrate the parent key into the child's primary
   * key; non-identifying ones migrate it as a plain foreign key.
   */
  identifying: z.boolean().default(false),

  /** Many-to-many resolved through an associative entity. */
  associativeEntity: RefSchema.optional(),

  onDelete: z.enum(["noAction", "cascade", "setNull", "setDefault", "restrict"]).optional(),
  onUpdate: z.enum(["noAction", "cascade", "setNull", "setDefault", "restrict"]).optional(),

  /**
   * Generate a referential-integrity assertion for this relationship. BigQuery
   * cannot enforce it, so an assertion is the only thing that actually checks it.
   */
  assert: z.boolean().default(true),

  subjectArea: RefSchema.optional(),
  /** Trace back to the equivalent relationship in the tier above. */
  derivedFrom: RefSchema.optional(),

  /**
   * Confidence score when the relationship was inferred rather than declared, * for example from observed join patterns in query history. Human-declared
   * relationships leave this unset.
   */
  inferredConfidence: z.number().min(0).max(1).optional(),
  inferenceEvidence: z.string().optional(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/** Human-readable sentence for a relationship, for docs and diagram labels. */
export function describeRelationship(rel: Relationship): string {
  const verb = rel.parent.verbPhrase ?? "relates to";
  return `${rel.parent.ref} ${verb} ${cardinalityPhrase(rel.child.cardinality)} ${rel.child.ref}`;
}

function cardinalityPhrase(cardinality: Cardinality): string {
  switch (cardinality) {
    case "zero-or-one":
      return "zero or one";
    case "exactly-one":
      return "exactly one";
    case "zero-or-more":
      return "zero or more";
    case "one-or-more":
      return "one or more";
  }
}

/** True when the child side permits more than one row per parent. */
export function isToMany(rel: Relationship): boolean {
  return rel.child.cardinality === "zero-or-more" || rel.child.cardinality === "one-or-more";
}
