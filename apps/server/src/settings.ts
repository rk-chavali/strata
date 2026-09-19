import { updateConfig, type WorkspaceConfig } from "@strata/storage";

/**
 * Editing workspace settings from the UI.
 *
 * Every write goes through the YAML document API so comments and formatting in
 * `strata.config.yaml` survive. That file belongs to the customer, it is in their repo
 * and their reviewers read it, so a settings dialog that silently reformatted it,
 * or dropped the comment explaining why a lint rule is demoted, would be doing real
 * damage in exchange for our convenience.
 */

export interface SettingsPatch {
  name?: string;
  description?: string;
  layout?: { preset?: string; slugStyle?: string };
  lint?: { strict?: boolean; rules?: Record<string, string> };
  bigquery?: { project?: string; location?: string };
  /** Free-prose conventions, checked by a model before a change is proposed. */
  conventions?: string;
  ddl?: { outputFolder?: string; pathTemplate?: string; orReplace?: boolean };
}

/** Apply a partial settings update. Absent keys are left untouched. */
export async function applySettings(root: string, patch: SettingsPatch): Promise<void> {
  await updateConfig(root, (doc) => {
    if (patch.name !== undefined) doc.setIn(["name"], patch.name);
    if (patch.description !== undefined) {
      if (patch.description) doc.setIn(["description"], patch.description);
      else doc.deleteIn(["description"]);
    }

    if (patch.layout?.preset !== undefined) doc.setIn(["layout", "preset"], patch.layout.preset);
    if (patch.layout?.slugStyle !== undefined) {
      doc.setIn(["layout", "slugStyle"], patch.layout.slugStyle);
    }

    if (patch.lint?.strict !== undefined) doc.setIn(["lint", "strict"], patch.lint.strict);
    if (patch.lint?.rules !== undefined) {
      // Replace the rule map wholesale: the dialog always sends the complete set, and
      // merging would make it impossible to remove an override.
      doc.setIn(["lint", "rules"], patch.lint.rules);
    }

    if (patch.bigquery?.project !== undefined) {
      doc.setIn(["bigquery", "project"], patch.bigquery.project);
    }
    if (patch.bigquery?.location !== undefined) {
      doc.setIn(["bigquery", "location"], patch.bigquery.location);
    }

    if (patch.conventions !== undefined) {
      if (patch.conventions.trim()) doc.setIn(["conventions"], patch.conventions);
      else doc.deleteIn(["conventions"]);
    }

    if (patch.ddl?.outputFolder !== undefined) doc.setIn(["ddl", "outputFolder"], patch.ddl.outputFolder);
    if (patch.ddl?.pathTemplate !== undefined) doc.setIn(["ddl", "pathTemplate"], patch.ddl.pathTemplate);
    if (patch.ddl?.orReplace !== undefined) doc.setIn(["ddl", "orReplace"], patch.ddl.orReplace);
  });
}

/**
 * The settings shape the dialog reads.
 *
 * Return type inferred rather than annotated: an explicit annotation here has to be
 * updated in lockstep with every field added below, and forgetting produces an error
 * pointing at the caller rather than at the omission.
 */
export function readSettings(config: WorkspaceConfig) {
  return {
    name: config.name,
    description: config.description ?? "",
    layout: { preset: config.layout.preset, slugStyle: config.layout.slugStyle },
    lint: { strict: config.lint.strict, rules: config.lint.rules },
    bigquery: {
      project: config.bigquery?.project ?? "",
      location: config.bigquery?.location ?? "",
    },
    conventions: config.conventions ?? "",
    ddl: {
      outputFolder: config.ddl?.outputFolder ?? "DDL",
      pathTemplate: config.ddl?.pathTemplate ?? "{dataset}/{name}.sql",
      orReplace: config.ddl?.orReplace ?? false,
    },
    dataform: config.dataform,
  };
}

/**
 * Rule codes worth surfacing in the settings dialog.
 *
 * A flat list of every code the validator can emit would be unusable. These are the
 * ones teams actually need to demote when adopting the tool against an existing
 * estate, the difference between a red pipeline they switch off and one they fix
 * incrementally.
 */
export const TUNABLE_RULES: { code: string; label: string; group: string }[] = [
  { code: "entity/noPrimaryKey", label: "Entity has no primary key", group: "Structure" },
  { code: "table/noColumns", label: "Table has no columns", group: "Structure" },
  { code: "attribute/untyped", label: "Attribute has no domain or type", group: "Structure" },
  { code: "ref/stale", label: "Reference uses a previous name", group: "Structure" },
  { code: "relationship/unmapped", label: "Relationship declares no attributes", group: "Structure" },
  { code: "naming/case", label: "Name does not match required casing", group: "Naming" },
  { code: "naming/pattern", label: "Name does not match required pattern", group: "Naming" },
  { code: "naming/prefix", label: "Name is missing a required prefix", group: "Naming" },
  { code: "naming/suffix", label: "Name is missing a required suffix", group: "Naming" },
  { code: "naming/length", label: "Name is too long", group: "Naming" },
  { code: "naming/forbiddenWord", label: "Name uses a discouraged word", group: "Naming" },
  { code: "mapping/missingColumn", label: "Target column is never populated", group: "Pipelines" },
  { code: "dimensional/noUnknownMember", label: "Dimension lookup has no unknown member", group: "Pipelines" },
  { code: "dimensional/noWatermark", label: "Incremental load has no watermark", group: "Pipelines" },
  { code: "model/noTarget", label: "Physical model has no deployment target", group: "Pipelines" },
  { code: "column/emptyStruct", label: "STRUCT column declares no fields", group: "BigQuery" },
  { code: "column/doubleArray", label: "Column is both ARRAY-typed and REPEATED", group: "BigQuery" },
];
