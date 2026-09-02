import { WORKSPACE_SCOPED_KINDS, type AnyObject, type ObjectKind } from "@strata/metamodel";
import { resolveTemplates, type LayoutConfig, type LayoutTemplates } from "./config.js";

/**
 * The layout engine: decides which file an object is *written* to.
 *
 * Note the asymmetry, because it is the whole design. Layout governs writes only.
 * Reads never consult it, the loader globs files and takes each object's `kind`,
 * `id` and `model` from the file's own contents. That asymmetry is what lets a
 * team reorganise the repo however they like, at any time, with nothing but a
 * file move: no meaning is encoded in the path, so no meaning is lost.
 *
 * `strata reorganize` exists precisely to exploit this, change the preset, and every
 * file moves to its new home in one reviewable commit.
 */

export interface LayoutContext {
  /** Pluralised kind, e.g. `entities`. Provided so templates can use `{kinds}`. */
  kinds?: string;
  /** Business domain of the owning model, when it declares one. */
  namespace?: string;
  /** Tier of the owning model, when known. */
  tier?: string;
  /** Resolved subject area name, when the object has one. */
  subjectArea?: string;
  /** Warehouse layer, for physical tables. */
  layer?: string;
}

/** Irregular plurals; everything else takes a trailing `s`. */
const PLURALS: Partial<Record<ObjectKind, string>> = {
  entity: "entities",
  subjectArea: "subject_areas",
  glossaryTerm: "glossary",
  namingStandard: "naming_standards",
};

export function pluralKind(kind: ObjectKind): string {
  return PLURALS[kind] ?? `${toSnake(kind)}s`;
}

function toSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

function toKebab(value: string): string {
  return toSnake(value).replace(/_/g, "-");
}

/**
 * Slugify a value for use as a path segment.
 *
 * Characters that are legal in an object name but hostile in a filename, dots,
 * slashes, colons, are folded away. Dots matter especially: a physical table can
 * legitimately be named `analytics.dim_customer`, and that must not become a
 * directory boundary.
 */
export function slugify(value: string, style: LayoutConfig["slugStyle"]): string {
  const cleaned = value.replace(/[/\\:]+/g, "_").replace(/\.+/g, "_");
  if (style === "preserve") return cleaned.replace(/\s+/g, "_");
  return style === "kebab" ? toKebab(cleaned) : toSnake(cleaned);
}

export class LayoutEngine {
  private readonly templates: LayoutTemplates;

  constructor(private readonly config: LayoutConfig) {
    this.templates = resolveTemplates(config);
  }

  /** The template that applies to a given object. Most specific wins. */
  templateFor(object: AnyObject): string {
    const byKind = this.templates[object.kind];
    if (byKind) return byKind;
    if (object.kind === "diagram" && this.templates.diagram) return this.templates.diagram;
    // The shared template is for genuinely shared objects. A domain or glossary
    // term that names a model belongs with that model, so it follows the default.
    if (WORKSPACE_SCOPED_KINDS.has(object.kind) && !object.model && this.templates.shared) {
      return this.templates.shared;
    }
    return this.templates.default;
  }

  /**
   * Resolve the repo-relative path an object should be written to.
   *
   * Two objects legitimately resolving to the same path is not an error, it
   * produces a multi-document YAML file, which is exactly how the
   * `single-file-per-model` preset works.
   */
  pathFor(object: AnyObject, context: LayoutContext = {}): string {
    const template = this.templateFor(object);
    const variables = this.variablesFor(object, context);
    return renderTemplate(template, variables);
  }

  private variablesFor(object: AnyObject, context: LayoutContext): Record<string, string> {
    const slug = (value: string | undefined): string =>
      value ? slugify(value, this.config.slugStyle) : "";

    return {
      name: slug(object.name),
      id: object.id,
      kind: slug(object.kind),
      kinds: context.kinds ?? pluralKind(object.kind),
      model: slug(object.kind === "model" ? object.name : object.model),
      namespace: slug(context.namespace),
      tier: slug(context.tier),
      subjectArea: slug(context.subjectArea),
      layer: slug(context.layer),
    };
  }
}

/**
 * Substitute template variables, collapsing segments whose variables are empty.
 *
 * `models/{model}/{layer}/{name}.yaml` with no layer yields
 * `models/core/orders.yaml` rather than `models/core//orders.yaml` or a stray
 * `_unknown` directory. The filename segment never collapses, if it would be
 * empty we fall back to the object id, because a file must be called something.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  const segments = template.split("/").filter((s) => s.length > 0);
  const rendered: string[] = [];

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    let sawEmptyVariable = false;

    const substituted = segment.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = variables[key] ?? "";
      if (!value) sawEmptyVariable = true;
      return value;
    });

    if (!isLast) {
      // Tidy up separators orphaned by an empty variable, then drop the segment
      // entirely if nothing meaningful is left.
      const tidied = sawEmptyVariable ? substituted.replace(/^[_.-]+|[_.-]+$/g, "") : substituted;
      if (tidied.length > 0) rendered.push(tidied);
      continue;
    }

    rendered.push(renderFilename(substituted, variables));
  }

  return rendered.join("/");
}

/**
 * Build the filename segment.
 *
 * The stem and the extension have to be separated *before* tidying, or a template
 * like `{name}.yaml` with an empty name collapses to the string `yaml`, a file
 * named after its own extension. A file must always be called something, so an
 * empty stem falls back to the object's name and then its id.
 */
function renderFilename(segment: string, variables: Record<string, string>): string {
  const lastDot = segment.lastIndexOf(".");
  const stem = lastDot > 0 ? segment.slice(0, lastDot) : lastDot === 0 ? "" : segment;
  const extension = lastDot >= 0 ? segment.slice(lastDot) : "";

  const tidiedStem = stem.replace(/^[_.-]+|[_.-]+$/g, "");
  if (tidiedStem.length > 0) return `${tidiedStem}${extension}`;

  const fallbackStem = variables.name || variables.id || "object";
  return `${fallbackStem}${extension || ".yaml"}`;
}
