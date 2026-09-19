import { z } from "zod";
import { BaseObjectSchema, RefSchema } from "./common.js";

/**
 * Subject areas partition a model into business-meaningful chunks. They are a
 * hierarchy, they are the primary unit of RBAC scoping ("edit Finance, read
 * everything else"), and they are available as a variable in file layout
 * templates so a repo can be organised by subject area if the team prefers.
 */
export const SubjectAreaSchema = BaseObjectSchema.extend({
  kind: z.literal("subjectArea"),
  /** Parent subject area, for nesting. */
  parent: RefSchema.optional(),
  /** Colour hint used by diagrams and the UI. */
  color: z.string().optional(),
});
export type SubjectArea = z.infer<typeof SubjectAreaSchema>;

export const GlossaryTermSchema = BaseObjectSchema.extend({
  kind: z.literal("glossaryTerm"),
  definition: z.string().min(1),
  /** Approved abbreviation, fed into the naming standards engine. */
  abbreviation: z.string().optional(),
  synonyms: z.array(z.string()).default([]),
  /** Terms that should NOT be used in place of this one. */
  deprecatedSynonyms: z.array(z.string()).default([]),
  relatedTerms: z.array(RefSchema).default([]),
  subjectArea: RefSchema.optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  /** Free-text authority, e.g. a policy document or regulation reference. */
  source: z.string().optional(),
});
export type GlossaryTerm = z.infer<typeof GlossaryTermSchema>;

/**
 * A concept is a business thing, described in business language, with no
 * attributes and no keys. The conceptual tier exists to be argued about by
 * people who do not write SQL, so it stays deliberately thin.
 */
export const ConceptSchema = BaseObjectSchema.extend({
  kind: z.literal("concept"),
  definition: z.string().optional(),
  subjectArea: RefSchema.optional(),
  synonyms: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  /** Glossary terms that define the vocabulary of this concept. */
  glossaryTerms: z.array(RefSchema).default([]),
  /**
   * Business identifier in prose, e.g. "a customer is uniquely identified by
   * their tax registration number". Becomes a candidate key downstream.
   */
  businessKey: z.string().optional(),
});
export type Concept = z.infer<typeof ConceptSchema>;
