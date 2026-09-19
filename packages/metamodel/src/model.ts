import { z } from "zod";
import { BaseObjectSchema, RefSchema, TierSchema } from "./common.js";

/**
 * A model is a container of objects at a single tier.
 *
 * A workspace holds several models, linked by `derivedFrom`, which is how the
 * three-tier requirement is actually satisfied: not three views of one artefact,
 * but a chain, one conceptual model, one or more logical models refining it, and
 * several physical models (staging, core, marts) realising those. Mappings carry
 * the transformations between them.
 */

/** Where a physical model is deployed. */
export const BigQueryTargetSchema = z.object({
  platform: z.literal("bigquery").default("bigquery"),
  project: z.string().optional(),
  /** Default dataset for tables that do not name their own. */
  dataset: z.string().optional(),
  location: z.string().optional(),
  /**
   * Per-environment overrides, keyed by environment name. The generator resolves
   * these when producing Dataform release configurations.
   */
  environments: z
    .record(
      z.object({
        project: z.string().optional(),
        dataset: z.string().optional(),
        datasetSuffix: z.string().optional(),
        location: z.string().optional(),
      }),
    )
    .default({}),
});
export type BigQueryTarget = z.infer<typeof BigQueryTargetSchema>;

export const ModelSchema = BaseObjectSchema.extend({
  kind: z.literal("model"),
  tier: TierSchema,

  /**
   * The business domain this model belongs to, `retail`, `finance`, `supply_chain`.
   *
   * A workspace of any size holds several unrelated modelling efforts, and a flat list
   * of models stops being navigable quickly. Grouping by namespace also gives the file
   * layout a natural top level (`models/retail/logical/...`), which is what makes an
   * ownership boundary in CODEOWNERS a single line rather than an enumeration.
   *
   * Note this is unrelated to attribute `domain` objects, which are reusable types.
   */
  namespace: z.string().optional(),

  /** The model this one refines, e.g. a logical model derived from a conceptual one. */
  derivedFrom: RefSchema.optional(),

  /** Naming standard applied to objects in this model. */
  namingStandard: RefSchema.optional(),

  /** Physical deployment target. Only meaningful for physical models. */
  target: BigQueryTargetSchema.optional(),

  /**
   * Warehouse layers this model contains, in dependency order. Free-form because
   * every organisation names them differently, raw/staging/core/mart,
   * bronze/silver/gold, l0/l1/l2. The linter uses the order to flag dependencies
   * that point the wrong way.
   */
  layers: z.array(z.string()).default([]),

  /** Dataform connection (declared in strata.config.yaml) this model generates into. */
  dataformConnection: z.string().optional(),

  version: z.string().optional(),
});
export type Model = z.infer<typeof ModelSchema>;
