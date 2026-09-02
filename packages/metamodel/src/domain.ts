import { z } from "zod";
import { BaseObjectSchema, ClassificationSchema, LogicalTypeSchema } from "./common.js";

/**
 * A domain is a reusable, named attribute definition, `money`, `email_address`,
 * `customer_id`. Attributes and columns inherit from it, so changing the domain
 * updates every usage in one commit.
 *
 * This is the first thing an enterprise data architect looks for in a modelling
 * tool, and it is the mechanism that makes standards enforceable rather than
 * aspirational.
 */
export const DomainSchema = BaseObjectSchema.extend({
  kind: z.literal("domain"),
  logicalType: LogicalTypeSchema,

  /**
   * Warehouse-native type this domain compiles to, e.g. `NUMERIC(18, 2)`.
   * Optional, when absent, the physical type is derived from `logicalType`
   * plus the target dialect's default mapping.
   */
  physicalType: z.string().optional(),

  length: z.number().int().positive().optional(),
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),

  nullable: z.boolean().default(true),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),

  /** Enumerated set of permitted values; compiles to an accepted-values assertion. */
  allowedValues: z.array(z.union([z.string(), z.number()])).default([]),
  /** Regular expression the value must satisfy; compiles to a format assertion. */
  pattern: z.string().optional(),
  minValue: z.union([z.string(), z.number()]).optional(),
  maxValue: z.union([z.string(), z.number()]).optional(),

  /** Unit of measure, e.g. `USD`, `metres`, `basis_points`. */
  unit: z.string().optional(),

  classification: ClassificationSchema.optional(),

  /**
   * Naming affix conventions for attributes drawn from this domain, e.g. a
   * `money` domain suffixing `_amount`. Checked by the naming standards linter.
   */
  namePrefix: z.string().optional(),
  nameSuffix: z.string().optional(),

  /** Domain inheritance, a `positive_money` narrowing `money`, for instance. */
  extends: z.string().optional(),
});
export type Domain = z.infer<typeof DomainSchema>;

/** A single naming rule evaluated by the lint engine. */
export const NamingRuleSchema = z.object({
  /** Which object kinds this rule applies to; empty means all. */
  appliesTo: z.array(z.string()).default([]),
  /** Restrict further by tier. */
  tiers: z.array(z.string()).default([]),
  casing: z.enum(["snake_case", "SCREAMING_SNAKE", "camelCase", "PascalCase", "Title Case", "any"]).optional(),
  /** Regular expression the name must match. */
  pattern: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  requiredPrefix: z.array(z.string()).default([]),
  requiredSuffix: z.array(z.string()).default([]),
  forbiddenWords: z.array(z.string()).default([]),
  /** Fail rather than warn. */
  severity: z.enum(["error", "warning", "info"]).default("warning"),
  message: z.string().optional(),
});
export type NamingRule = z.infer<typeof NamingRuleSchema>;

/**
 * Naming standards live in the repo as a model object, which means they are
 * versioned, reviewable, and enforceable by the CLI in CI. That last part is the
 * whole point: standards that only exist inside a desktop tool get bypassed.
 */
export const NamingStandardSchema = BaseObjectSchema.extend({
  kind: z.literal("namingStandard"),
  /**
   * Word-to-abbreviation dictionary used when generating physical names from
   * logical ones, e.g. `Identifier -> id`, `Organisation -> org`.
   */
  abbreviations: z.record(z.string()).default({}),
  rules: z.array(NamingRuleSchema).default([]),
  /**
   * Template for deriving a physical name from a logical name.
   * Available variables: {words}, {abbreviated}, {entity}, {domain}.
   */
  physicalNameTemplate: z.string().optional(),
});
export type NamingStandard = z.infer<typeof NamingStandardSchema>;
