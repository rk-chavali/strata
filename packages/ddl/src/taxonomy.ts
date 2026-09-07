import type { Classification, Column, ObjectGraph } from "@strata/metamodel";

/**
 * Turning a classification into a BigQuery policy tag.
 *
 * This is the link that was missing. Everything either side of it already existed: columns
 * could carry `classification: {sensitivity, categories}`, and the DDL generator could emit
 * `SET OPTIONS(policy_tags = [...])`, but only for a column that already named a tag. So a
 * column classified `confidential / pii` produced no policy tag at all, and the governance
 * story stopped at documentation.
 *
 * The reason it needs a mapping rather than a convention: a policy tag is a *Dataplex
 * resource*, `projects/p/locations/eu/taxonomies/123/policyTags/456`. Nothing about the word
 * "pii" implies that string. Only your Data Catalog knows it, so the mapping has to be
 * declared, versioned in the repo like everything else, and reviewable.
 *
 * Precedence runs most-specific first, because a column that names its own tag has made a
 * decision the taxonomy should not override.
 */

export interface Taxonomy {
  /**
   * Data category to policy tag. Checked before sensitivity, because a category is the
   * more specific statement: `pii` says what the data *is*, `confidential` only says how
   * carefully to treat it.
   */
  byCategory?: Record<string, string>;
  /** Sensitivity level to policy tag, the fallback for data with no category. */
  bySensitivity?: Record<string, string>;
  /**
   * Logical taxonomy name to policy tag resource.
   *
   * Separate from `byCategory` because a `policyTagName` is not a data category: it is
   * whatever your Data Catalog calls a node in its tree, like `pii/contact`. An earlier
   * version looked names up in `byCategory`, which worked by accident and meant a taxonomy
   * node sharing a name with a category would silently resolve to the wrong tag.
   */
  byName?: Record<string, string>;
}

export interface ResolvedTag {
  tag: string;
  /** Why this tag was chosen, so generated SQL can explain itself in a comment. */
  source: "column" | "category" | "sensitivity";
  /** The category or level that matched, when it came from the taxonomy. */
  matched?: string;
  /** True when only a logical name is known and no resource id could be resolved. */
  unresolved?: boolean;
}

/**
 * The policy tag a classification implies, if any.
 *
 * `undefined` means "no tag", which is a legitimate answer: a column classified `internal`
 * in a workspace whose taxonomy only maps `pii` does not get a tag, and inventing one would
 * apply column-level security nobody asked for.
 */
export function resolvePolicyTag(
  classification: Classification | undefined,
  taxonomy: Taxonomy | undefined,
): ResolvedTag | undefined {
  if (!classification) return undefined;

  // An explicit resource id on the column always wins.
  if (classification.policyTag) return { tag: classification.policyTag, source: "column" };

  /*
    A logical name with no resolution is reported as unresolved rather than dropped.

    The generator turns this into a `TODO` comment instead of a runnable statement. Silently
    emitting nothing would leave a column the modeller explicitly marked sensitive with no
    protection and no trace of the intent.
  */
  if (classification.policyTagName) {
    const mapped = taxonomy?.byName?.[classification.policyTagName];
    if (mapped) return { tag: mapped, source: "column", matched: classification.policyTagName };
    return { tag: classification.policyTagName, source: "column", unresolved: true };
  }

  for (const category of classification.categories ?? []) {
    const mapped = taxonomy?.byCategory?.[category];
    if (mapped) return { tag: mapped, source: "category", matched: category };
  }

  const level = classification.sensitivity;
  const mapped = level ? taxonomy?.bySensitivity?.[level] : undefined;
  if (mapped) return { tag: mapped, source: "sensitivity", matched: level };

  return undefined;
}

/**
 * A column's classification including everything it inherits.
 *
 * Three sources, most specific first: the column itself, the reusable `domain` it is typed
 * from, and the logical `attributeRef` it implements. Without this, classifying a logical
 * attribute once, which is the whole point of having a logical tier, would protect nothing,
 * because generation only ever reads the physical column.
 *
 * Fields merge rather than whole objects replacing each other: a column that sets only
 * `sensitivity: restricted` on top of a domain carrying `categories: [pii]` should keep the
 * categories. Taking the first non-empty *object* would silently drop them, and the dropped
 * field is the one that decides whether a policy tag gets applied.
 */
export function effectiveClassification(
  column: Column,
  graph: ObjectGraph,
  model: string | undefined,
): Classification | undefined {
  const ctx = model ? { model } : {};
  const layers: Classification[] = [];

  if (column.classification) layers.push(column.classification);

  if (column.domain) {
    const domain = graph.resolve(column.domain, ctx)?.target.object;
    if (domain?.kind === "domain" && domain.classification) layers.push(domain.classification);
  }

  if (column.attributeRef) {
    const resolved = graph.resolve(column.attributeRef, ctx);
    const owner = resolved?.target.object;
    const path = resolved?.memberPath;
    if (owner?.kind === "entity" && path) {
      const attribute = owner.attributes.find(
        (candidate) => candidate.name.toLowerCase() === path.toLowerCase(),
      );
      if (attribute?.classification) layers.push(attribute.classification);

      /*
        A logical attribute can itself be typed from a domain.

        Skipping this hop is how a workspace that classifies its type library once, on the
        logical side, still generates no policy tags, the chain is column → attribute →
        domain, and stopping at the attribute finds nothing on it.
      */
      if (attribute?.domain) {
        const domain = graph.resolve(attribute.domain, ctx)?.target.object;
        if (domain?.kind === "domain" && domain.classification) layers.push(domain.classification);
      }
    }
  }

  if (layers.length === 0) return undefined;

  const merged: Classification = { categories: [] };
  const categories = new Set<string>();

  // Earlier layers win per field, so iterate outward-in and only fill what is still empty.
  for (const layer of layers) {
    if (merged.sensitivity === undefined && layer.sensitivity !== undefined) {
      merged.sensitivity = layer.sensitivity;
    }
    if (merged.policyTag === undefined && layer.policyTag !== undefined) {
      merged.policyTag = layer.policyTag;
    }
    if (merged.policyTagName === undefined && layer.policyTagName !== undefined) {
      merged.policyTagName = layer.policyTagName;
    }
    if (merged.retentionDays === undefined && layer.retentionDays !== undefined) {
      merged.retentionDays = layer.retentionDays;
    }
    // Categories union rather than override: a column tagged `financial` on top of a domain
    // tagged `pii` holds both, and dropping either loses a real protection requirement.
    for (const category of layer.categories ?? []) categories.add(category);
  }

  merged.categories = [...categories] as Classification["categories"];
  return merged;
}

/**
 * Where a classification came from, for reporting.
 *
 * The dictionary needs this to show `↳ confidential` distinctly from a value set on the
 * column, and coverage reporting needs it so a model governed entirely through its logical
 * tier does not read as 0% classified.
 */
export function classificationSource(
  column: Column,
  graph: ObjectGraph,
  model: string | undefined,
): "column" | "domain" | "attribute" | undefined {
  if (column.classification) return "column";
  const ctx = model ? { model } : {};

  if (column.domain) {
    const domain = graph.resolve(column.domain, ctx)?.target.object;
    if (domain?.kind === "domain" && domain.classification) return "domain";
  }

  if (column.attributeRef) {
    const resolved = graph.resolve(column.attributeRef, ctx);
    const owner = resolved?.target.object;
    if (owner?.kind === "entity" && resolved?.memberPath) {
      const attribute = owner.attributes.find(
        (candidate) => candidate.name.toLowerCase() === resolved.memberPath!.toLowerCase(),
      );
      if (attribute?.classification) return "attribute";
      if (attribute?.domain) {
        const domain = graph.resolve(attribute.domain, ctx)?.target.object;
        if (domain?.kind === "domain" && domain.classification) return "attribute";
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------- environments

/**
 * The shape `governance` takes in `strata.config.yaml`.
 *
 * Declared structurally rather than imported from `@strata/storage` so this package keeps its one
 * dependency. The storage schema is the thing that parses the file; this is the shape the
 * generator needs, and the two are checked against each other by the server that passes one to
 * the other.
 */
export interface GovernanceConfig {
  policyTags?: Taxonomy;
  environments?: Record<
    string,
    Taxonomy & { project?: string; location?: string; bigqueryProject?: string; syncedAt?: string }
  >;
}

/**
 * The taxonomy to generate against, for a given environment.
 *
 * **Why this cannot be one flat map.** A policy tag is a Dataplex resource path that embeds a
 * project and a taxonomy id, so the same logical `pii` category is a different string in every
 * project. Generating production DDL with development's tag ids does not fail loudly, it applies
 * column-level security pointing at a taxonomy the target project cannot see, and nobody finds
 * out until apply time.
 *
 * The environment's entries win field by field over the shared defaults, rather than the whole
 * map replacing it. That is the same merge rule `effectiveClassification` uses, and for the same
 * reason: an environment that overrides only `byCategory.pii` should keep every other mapping,
 * and taking the first non-empty *object* would silently drop the rest, leaving columns
 * unprotected in exactly the environment someone bothered to configure specially.
 *
 * An unknown environment name returns the defaults rather than throwing. The caller has better
 * context for that error than this function does, and silently generating *nothing* would be the
 * worse failure.
 */
export function taxonomyFor(
  governance: GovernanceConfig | undefined,
  environment?: string,
): Taxonomy {
  const base = governance?.policyTags ?? {};
  const override = environment ? governance?.environments?.[environment] : undefined;

  if (!override) return base;

  return {
    byCategory: { ...base.byCategory, ...override.byCategory },
    bySensitivity: { ...base.bySensitivity, ...override.bySensitivity },
    byName: { ...base.byName, ...override.byName },
  };
}

/** Environment names a workspace declares, sorted. */
export function environmentNames(governance: GovernanceConfig | undefined): string[] {
  return Object.keys(governance?.environments ?? {}).sort();
}
