import { z } from "zod";

/**
 * Workspace configuration, `strata.config.yaml` at the root of the model repo.
 *
 * Everything here is versioned alongside the models themselves, which is the
 * point: how a team organises its files, which Dataform repos it generates into,
 * and which lint rules gate its pull requests are all decisions that belong under
 * review rather than in someone's local settings.
 */

export const CONFIG_FILENAME = "strata.config.yaml";
export const CONFIG_VERSION = 1;

/**
 * Named layout presets.
 *
 * These are shorthand for the templates in `PRESET_TEMPLATES`. Any team that
 * wants something else sets `preset: custom` and writes their own templates, * and because object identity lives in file *content*, switching layouts is a
 * pure file move that changes no meaning.
 */
export const LAYOUT_PRESETS = [
  /** Every object in one directory. Fine for small models. */
  "flat",
  /** Grouped by object kind: `models/entities/…`, `models/tables/…`. */
  "by-kind",
  /** Grouped by model, kinds mixed together. */
  "by-model",
  /** Grouped by model then kind. The default, and what most teams end up wanting. */
  "by-model-and-kind",
  /** Grouped by model then subject area, good when teams own subject areas. */
  "by-subject-area",
  /** Grouped by model then warehouse layer then kind. Suits layered warehouses. */
  "by-layer",
  /** Grouped by business domain, then tier. Best isolation for multi-domain repos. */
  "by-namespace",
  /** One multi-document YAML file per model. Fewest files, largest diffs. */
  "single-file-per-model",
  /** Use `templates` verbatim. */
  "custom",
] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

/**
 * Path templates per preset.
 *
 * Available variables: `{model}`, `{kind}`, `{kinds}` (plural), `{name}`,
 * `{subjectArea}`, `{layer}`, `{tier}`, `{id}`. A variable that resolves to
 * nothing collapses its path segment rather than producing an `_unknown`
 * directory, so `models/{model}/{layer}/{name}.yaml` degrades gracefully to
 * `models/core/orders.yaml` for a table with no layer.
 */
export const PRESET_TEMPLATES: Record<Exclude<LayoutPreset, "custom">, LayoutTemplates> = {
  flat: {
    default: "models/{name}.yaml",
    shared: "models/{name}.yaml",
    diagram: "diagrams/{name}.diagram.yaml",
  },
  "by-kind": {
    default: "models/{kinds}/{name}.yaml",
    // Without this the model object lands in `models/models/core.yaml`.
    model: "models/{name}.yaml",
    shared: "shared/{kinds}/{name}.yaml",
    diagram: "diagrams/{name}.diagram.yaml",
  },
  "by-model": {
    default: "models/{model}/{name}.yaml",
    model: "models/{model}/model.yaml",
    shared: "shared/{name}.yaml",
    diagram: "diagrams/{model}/{name}.diagram.yaml",
  },
  "by-model-and-kind": {
    default: "models/{model}/{kinds}/{name}.yaml",
    model: "models/{model}/model.yaml",
    shared: "shared/{kinds}/{name}.yaml",
    diagram: "diagrams/{model}/{name}.diagram.yaml",
  },
  "by-subject-area": {
    default: "models/{model}/{subjectArea}/{name}.yaml",
    model: "models/{model}/model.yaml",
    shared: "shared/{kinds}/{name}.yaml",
    diagram: "diagrams/{model}/{name}.diagram.yaml",
  },
  "by-layer": {
    default: "models/{model}/{layer}/{kinds}/{name}.yaml",
    model: "models/{model}/model.yaml",
    shared: "shared/{kinds}/{name}.yaml",
    diagram: "diagrams/{model}/{name}.diagram.yaml",
  },
  /**
   * Grouped by business domain, then tier.
   *
   * The shape most teams end up wanting once there is more than one modelling effort in
   * the repo, because it gives each domain a single folder, which makes an ownership
   * rule in CODEOWNERS one line rather than an enumeration of every model.
   */
  "by-namespace": {
    default: "models/{namespace}/{tier}/{kinds}/{name}.yaml",
    model: "models/{namespace}/{tier}/model.yaml",
    shared: "shared/{kinds}/{name}.yaml",
    diagram: "models/{namespace}/{tier}/diagrams/{name}.diagram.yaml",
  },
  "single-file-per-model": {
    default: "models/{model}.yaml",
    shared: "shared/domains.yaml",
    diagram: "diagrams/{model}.diagram.yaml",
  },
};

export interface LayoutTemplates {
  /** Fallback template for any kind without a specific one. */
  default: string;
  /** Template for workspace-scoped kinds (domains, glossary, naming standards). */
  shared?: string;
  /** Template for the model object itself. */
  model?: string;
  /** Template for diagrams. Kept separate on purpose, see `diagram.ts`. */
  diagram?: string;
  /** Per-kind overrides, keyed by object kind. */
  [kind: string]: string | undefined;
}

export const LayoutConfigSchema = z.object({
  preset: z.enum(LAYOUT_PRESETS).default("by-model-and-kind"),
  /** Overrides merged over the preset's templates. */
  templates: z.record(z.string()).default({}),
  /** How `{name}`, `{model}` and friends are slugified into path segments. */
  slugStyle: z.enum(["snake", "kebab", "preserve"]).default("snake"),
  /**
   * Write multiple objects per file. Implied by `single-file-per-model`, but can
   * be set independently, any template that resolves to the same path for
   * several objects produces a multi-document YAML file.
   */
  allowMultiDocument: z.boolean().default(true),
});
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;

/** A Dataform repository this workspace generates pipelines into. */
export const DataformConnectionSchema = z.object({
  name: z.string().min(1),
  /** Git remote of the Dataform repo. */
  remote: z.string().optional(),
  branch: z.string().default("main"),
  /** Local path, for a repo checked out beside the model repo. */
  path: z.string().optional(),

  /** The GCP-managed Dataform repository this git repo is attached to. */
  gcp: z
    .object({
      project: z.string(),
      location: z.string(),
      repository: z.string(),
      /** Default workspace to read compiled results from. */
      workspace: z.string().optional(),
    })
    .optional(),

  /**
   * Where generated files land inside the Dataform repo. Same template variables
   * as the model layout, plus `{dataset}`.
   */
  paths: z
    .object({
      declaration: z.string().default("definitions/sources/{dataset}/{name}.sqlx"),
      model: z.string().default("definitions/{layer}/{name}.sqlx"),
      assertion: z.string().default("definitions/assertions/{name}.sqlx"),
      include: z.string().default("includes/{name}.js"),
    })
    .default({}),

  /**
   * Glob patterns the tool owns outright and may rewrite or delete freely.
   *
   * The default draws the boundary where it causes least friction: we own
   * declarations and assertions, which are pure derivations of the model, and we
   * never touch hand-written transformation SQL except inside explicitly marked
   * regions. Widen this only for repos the tool fully generates.
   */
  managed: z.array(z.string()).default(["definitions/sources/**", "definitions/assertions/**"]),

  /**
   * Markers delimiting a region we may rewrite inside an otherwise hand-written
   * file. Everything outside the markers is left byte-for-byte alone.
   */
  managedRegion: z
    .object({
      begin: z.string().default("-- strata:begin generated"),
      end: z.string().default("-- strata:end generated"),
    })
    .default({}),

  /** Models whose objects generate into this connection. Empty means all. */
  models: z.array(z.string()).default([]),
});
export type DataformConnection = z.infer<typeof DataformConnectionSchema>;

export const LintConfigSchema = z.object({
  /** Rule code to severity, e.g. `naming/case: error`. `off` disables a rule. */
  rules: z.record(z.enum(["error", "warning", "info", "off"])).default({}),
  /** Glob patterns excluded from linting. */
  ignore: z.array(z.string()).default([]),
  /** Treat warnings as errors, for a strict CI gate. */
  strict: z.boolean().default(false),
});
export type LintConfig = z.infer<typeof LintConfigSchema>;

/** One provider's non-secret configuration. */
export const IntegrationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Provider-specific non-secret fields, e.g. a Confluence space key. */
  settings: z.record(z.string()).default({}),
  /** Events this provider responds to. Empty means every event it supports. */
  events: z.array(z.string()).default([]),
});
export type IntegrationSettings = z.infer<typeof IntegrationSettingsSchema>;

/**
 * A classification-to-policy-tag mapping.
 *
 * Extracted so the top-level default and every per-environment override share one shape, two
 * definitions that had to be kept in step would drift the first time a field was added.
 */
export const PolicyTagMapSchema = z.object({
  /**
   * Data category to policy tag. Checked before sensitivity: a category says what
   * the data *is*, a sensitivity level only says how carefully to treat it.
   */
  byCategory: z.record(z.string()).default({}),
  bySensitivity: z.record(z.string()).default({}),
  /** Logical taxonomy node name, e.g. `pii/contact`, to policy tag resource. */
  byName: z.record(z.string()).default({}),
});
export type PolicyTagMap = z.infer<typeof PolicyTagMapSchema>;

/** One deployment target: which GCP project and location its taxonomy lives in. */
export const EnvironmentSchema = z.object({
  /** GCP project holding this environment's Dataplex taxonomy. */
  project: z.string().optional(),
  /** Taxonomy location, e.g. `us` or `eu`. Policy tags are regional. */
  location: z.string().optional(),
  /** BigQuery project for generated DDL, when it differs from the taxonomy project. */
  bigqueryProject: z.string().optional(),
  byCategory: z.record(z.string()).default({}),
  bySensitivity: z.record(z.string()).default({}),
  byName: z.record(z.string()).default({}),
  /** When the mapping was last synced from Data Catalog, so a stale one is visible. */
  syncedAt: z.string().optional(),
});
export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;

export const WorkspaceConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),

  /**
   * Directories scanned for model files. Defaults to the whole repo, because
   * discovery reads meaning from file contents rather than location, narrowing
   * this is an optimisation, not a requirement.
   */
  roots: z.array(z.string()).default(["."]),

  /** Additional ignore globs, on top of the built-in defaults. */
  ignore: z.array(z.string()).default([]),

  layout: LayoutConfigSchema.default({}),
  dataform: z.array(DataformConnectionSchema).default([]),
  lint: LintConfigSchema.default({}),

  /**
   * House conventions, written as prose.
   *
   * The deterministic rules in `lint` cover what a rules engine can decide, casing,
   * prefixes, lengths. This is for everything else: "every fact table must have a date
   * dimension", "money columns end in `_amount` and are NUMERIC(18, 2)", "never
   * abbreviate outside the approved dictionary".
   *
   * Stored in the repo rather than a database so the conventions are versioned and
   * reviewed like any other governed artifact. See `checkConventions` for what
   * currently enforces them.
   */
  conventions: z.string().optional(),

  /** Where generated DDL goes. Files are only ever created, never edited in place. */
  ddl: z
    .object({
      outputFolder: z.string().default("DDL"),
      /** Relative to the output folder. `{dataset}`, `{name}` and `{layer}` substitute. */
      pathTemplate: z.string().default("{dataset}/{name}.sql"),
      orReplace: z.boolean().default(false),
    })
    .optional(),

  /** Default BigQuery target, inherited by physical models that omit their own. */
  bigquery: z
    .object({
      project: z.string().optional(),
      location: z.string().optional(),
      /** Datasets to include when introspecting. Empty means all. */
      datasets: z.array(z.string()).default([]),
    })
    .optional(),

  /**
   * How a classification becomes a BigQuery policy tag.
   *
   * This mapping has to be declared because nothing about the word "pii" implies the string
   * `projects/p/locations/eu/taxonomies/1/policyTags/2`, only your Data Catalog knows that,
   * and a tool that guessed would apply column-level security to the wrong columns.
   *
   * Keeping it in the config rather than in a UI setting is the point: it is reviewed in a
   * pull request like the rest of the model, and CI can generate the same tags the operator
   * would.
   */
  /**
   * Integration providers, minus their credentials.
   *
   * The non-secret half lives here so it is versioned and reviewed like the model: which
   * Confluence page gets overwritten on merge, and which Jira projects count as ours, are
   * decisions worth seeing in a diff. Tokens go in the encrypted secret store and never here.
   */
  integrations: z.record(IntegrationSettingsSchema).default({}),

  governance: z
    .object({
      policyTags: PolicyTagMapSchema.optional(),

      /**
       * Per-environment policy tag mappings.
       *
       * The reason this exists: a policy tag is a Dataplex resource path, and the *same* logical
       * classification resolves to a different one in every project. `pii` is
       * `projects/acme-dev/locations/us/taxonomies/111/policyTags/222` in development and
       * `projects/acme-prod/.../taxonomies/999/policyTags/888` in production, different
       * taxonomy, different id, same meaning.
       *
       * A single flat map therefore cannot serve more than one environment, which is what the
       * previous shape assumed. Generating DDL for production with development's tag ids does
       * not fail loudly; it applies column-level security that points at a taxonomy the target
       * project cannot see, and the failure surfaces at apply time.
       *
       * Each environment inherits from the top-level `policyTags` and overrides what it names,
       * so a workspace with one environment keeps working unchanged and one with four states
       * only the differences.
       */
      environments: z.record(EnvironmentSchema).default({}),
    })
    .optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/** Paths never scanned for model files, regardless of configuration. */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.strata/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/__pycache__/**",
  // Dataform repos checked out inside the model repo are generated, not read.
  "**/definitions/**",
] as const;

/** Resolve the effective templates for a config, applying preset then overrides. */
export function resolveTemplates(layout: LayoutConfig): LayoutTemplates {
  const base: LayoutTemplates =
    layout.preset === "custom"
      ? { default: "models/{model}/{kinds}/{name}.yaml" }
      : { ...PRESET_TEMPLATES[layout.preset] };
  return { ...base, ...layout.templates };
}

export function parseWorkspaceConfig(input: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(input);
}
