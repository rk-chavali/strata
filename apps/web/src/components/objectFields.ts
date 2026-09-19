import type { ModelObject } from "../types";

/**
 * What each object kind is made of, as editable fields.
 *
 * Extracted from `ObjectDialog` so the docked properties panel and the modal render the
 * same form from the same source. Two copies of this table is how a field gets added in
 * one place and silently stays missing in the other, and the panel is now the primary
 * way anyone edits an object, so a drift here would be a drift in the main path.
 */

export interface Field {
  /** Dotted path from the object root, so nested settings like `target.dataset` reach the form. */
  key: string;
  label: string;
  type: "text" | "textarea" | "select";
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  /** For `select`: the legal values, each with a line explaining what it does. */
  options?: { value: string; label: string; hint: string }[];
}

/**
 * How a target table is loaded, the single most consequential field on a mapping.
 *
 * It decides which SQL gets generated, whether history is kept, and whether a re-run is
 * safe. It was a free-text box: eight legal values, no list, no explanation, and a typo
 * surfaced only later as a validation error on a different screen.
 *
 * The hints matter as much as the picker. "scd2" means nothing to someone who has not
 * built a warehouse before, and the difference between `scd1` and `scd2` is whether you
 * can ever answer "what was this customer's segment last March", which is a business
 * decision, not a technical one, and needs to be legible to whoever is making it.
 */
export const LOAD_STRATEGIES: { value: string; label: string; hint: string }[] = [
  { value: "full", label: "Full rebuild", hint: "Replace the table entirely on every run." },
  { value: "incremental", label: "Incremental", hint: "Add rows past a watermark; needs a watermark column." },
  { value: "append", label: "Append only", hint: "Add rows, never update. Keeps everything." },
  { value: "merge", label: "Merge", hint: "Insert new rows and update changed ones, on a business key." },
  { value: "scd1", label: "Dimension, overwrite (SCD1)", hint: "Latest values only. No history." },
  { value: "scd2", label: "Dimension, history (SCD2)", hint: "Keeps every version with valid-from/to dates." },
  { value: "scd3", label: "Dimension, previous value (SCD3)", hint: "Keeps only the prior value, in its own column." },
  { value: "snapshot", label: "Snapshot", hint: "A dated full copy each run. For sources with no change signal." },
  { value: "declaration", label: "Declaration only", hint: "Built elsewhere; just make it referenceable." },
];

/** Read a possibly-nested value as a string. Missing branches read as empty, not as a crash. */
export function readPath(object: ModelObject, path: string): string {
  let cursor: unknown = object;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return "";
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor === undefined || cursor === null ? "" : String(cursor);
}

/**
 * Set a possibly-nested value, creating the branches on the way down.
 *
 * Blanking a field deletes the key rather than writing an empty string: `dataset: ""`
 * is not the same as "inherit the model's dataset", and persisting the empty string
 * would silently produce `project..table` in the generated DDL.
 */
export function writePath(object: ModelObject, path: string, value: string): ModelObject {
  const parts = path.split(".");
  const root = { ...object } as Record<string, unknown>;

  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    const next = typeof existing === "object" && existing !== null ? { ...(existing as object) } : {};
    cursor[part] = next;
    cursor = next as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1]!;
  if (value.trim()) cursor[leaf] = value;
  else delete cursor[leaf];

  return root as ModelObject;
}

/** The fields worth surfacing per kind, in the order they make sense to read. */
export const FIELDS: Record<string, Field[]> = {
  glossaryTerm: [
    { key: "definition", label: "Definition", type: "textarea", hint: "What the business means by this word." },
    { key: "abbreviation", label: "Abbreviation", type: "text", hint: "Used when generating physical names." },
    { key: "approvedBy", label: "Approved by", type: "text" },
    { key: "source", label: "Source", type: "text", placeholder: "policy document, regulation…" },
  ],
  subjectArea: [
    { key: "parent", label: "Parent area", type: "text" },
    { key: "color", label: "Colour", type: "text", placeholder: "#2f6f4f" },
  ],
  domain: [
    { key: "logicalType", label: "Logical type", type: "text" },
    { key: "physicalType", label: "Physical type", type: "text", placeholder: "NUMERIC(18, 2)" },
    { key: "unit", label: "Unit", type: "text" },
    { key: "pattern", label: "Pattern", type: "text", hint: "Regular expression, compiled into an assertion." },
  ],
  mapping: [
    { key: "target", label: "Target", type: "text" },
    {
      key: "loadStrategy",
      label: "Load strategy",
      type: "select",
      options: LOAD_STRATEGIES,
      hint: "Decides the SQL that gets generated, and whether history is kept.",
    },
    { key: "stage", label: "Stage", type: "text", placeholder: "staging -> mart" },
  ],
  concept: [
    { key: "definition", label: "Definition", type: "textarea" },
    { key: "businessKey", label: "Business key", type: "textarea" },
    { key: "subjectArea", label: "Subject area", type: "text" },
  ],
  /**
   * A model owns the product it belongs to and, when physical, where it deploys.
   *
   * `namespace` is *your* grouping, retail, application, and drives the explorer, the
   * folder layout and CODEOWNERS. `target.dataset` is *BigQuery's* grouping, and exists
   * because a table has to live in some dataset to have a name at all. They are
   * unrelated, and having neither editable made the second one look like something this
   * tool had invented.
   */
  model: [
    { key: "namespace", label: "Product / domain", type: "text", placeholder: "retail, application…", hint: "Groups the tiers of one modelling effort, and the folders in the repo." },
    { key: "derivedFrom", label: "Derived from", type: "text", hint: "The model one tier up, so the tier switch can move between them." },
    { key: "target.project", label: "BigQuery project", type: "text", mono: true, placeholder: "acme-analytics-prod" },
    { key: "target.dataset", label: "Default dataset", type: "text", mono: true, placeholder: "retail_mart", hint: "Used by every table that does not set its own." },
  ],
  table: [
    { key: "dataset", label: "BigQuery dataset", type: "text", mono: true, placeholder: "inherits the model's default", hint: "Where this table lives in BigQuery: project.DATASET.table. Also the DDL folder, by default." },
    { key: "layer", label: "Layer", type: "text", placeholder: "staging, mart", hint: "Your own grouping, shown on the box and usable in the DDL path template." },
    { key: "partitionBy", label: "Partition by", type: "text", mono: true, placeholder: "order_date" },
    { key: "grain", label: "Grain", type: "textarea", hint: "What one row means. The single most useful thing to write down." },
  ],
  entity: [
    { key: "subjectArea", label: "Subject area", type: "text" },
    { key: "conceptRef", label: "Concept", type: "text", hint: "The conceptual object this refines." },
  ],
  namingStandard: [],
  relationship: [],
};
