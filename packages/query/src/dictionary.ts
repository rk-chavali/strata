import {
  DATA_CATEGORIES,
  SENSITIVITY_LEVELS,
  type AnyObject,
  type Attribute,
  type Column,
  type Entity,
  type ObjectGraph,
  type Table,
} from "@strata/metamodel";

/**
 * The data dictionary: every field of every object in a model, as flat rows.
 *
 * This is the view the diagram cannot give you. A diagram answers "how do these relate";
 * a dictionary answers "what do we hold, who owns it, and which of it is sensitive", and
 * that second question is asked by auditors, not modellers, which is why it wants a
 * spreadsheet rather than a canvas.
 *
 * Flat rows rather than nested groups, with the owning object repeated on each row. The
 * client groups them for display, and keeping the wire format flat means sorting and
 * filtering across the whole model, "show me every unclassified column", costs nothing.
 *
 * The structured `classification` is preserved here rather than summarised to a string the
 * way `MemberView` does it. The canvas only needs to *show* sensitivity; this screen has to
 * *edit* it, and you cannot edit `"pii/contact"` back into a category array without
 * guessing.
 */

export interface DictionaryRow {
  /** The object this field belongs to. Repeated per row so the client can group freely. */
  objectId: string;
  objectName: string;
  objectKind: "table" | "entity";
  /** BigQuery dataset, on tables that state one. Absent on entities. */
  dataset?: string;
  layer?: string;

  /** Dotted path from the object root, so an edit can address this exact field. */
  path: string;
  name: string;
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** Nesting depth for STRUCT fields, so the client can indent without re-parsing paths. */
  depth: number;

  description?: string;
  sensitivity?: string;
  categories: string[];
  policyTagName?: string;
  /** True when a full policy tag resource id is set, which the UI shows but does not edit. */
  hasPolicyTag: boolean;

  /**
   * The classification this field gets from its domain rather than from itself.
   *
   * Reported separately rather than merged into `sensitivity` and `categories`, because the
   * two are not interchangeable: an inherited value cannot be edited here, you would edit
   * the domain, and showing it in the editable cell would make every attempt to change it
   * silently write an override onto the column instead. A grid that cannot tell you *where*
   * a value comes from is how a type library stops being the source of truth.
   */
  inherited?: { from: string; sensitivity?: string; categories: string[] };

  /** The reusable attribute type this field inherits from, if any. */
  domain?: string;
  /** The logical attribute a physical column implements, for lineage. */
  attributeRef?: string;
  tags: string[];
}

export interface DictionaryView {
  model: string;
  rows: DictionaryRow[];
  /** The closed vocabularies, sent with the data so the client never hardcodes them. */
  sensitivityLevels: readonly string[];
  categories: readonly string[];
  /** How much of this model carries a classification, the number governance actually wants. */
  classified: number;
  total: number;
}

export function dictionaryView(graph: ObjectGraph, model: string): DictionaryView {
  const rows: DictionaryRow[] = [];

  /**
   * Resolve a `domain` reference to the classification it lends its members.
   *
   * Memoised per call: a wide model points dozens of columns at the same handful of domains,
   * and `resolve` walks the reference syntax every time. Caching the misses matters as much
   * as caching the hits, an unresolvable domain is exactly the one that appears on every
   * row of a broken model.
   */
  const domainCache = new Map<string, DictionaryRow["inherited"]>();

  function inheritedFrom(ref: string | undefined): DictionaryRow["inherited"] {
    if (!ref) return undefined;
    if (domainCache.has(ref)) return domainCache.get(ref);

    const object = graph.resolve(ref, { model })?.target.object;
    let result: DictionaryRow["inherited"];

    if (object?.kind === "domain" && object.classification) {
      const { sensitivity, categories } = object.classification;
      if (sensitivity || categories?.length) {
        result = {
          from: object.name,
          ...(sensitivity ? { sensitivity } : {}),
          categories: categories ?? [],
        };
      }
    }

    domainCache.set(ref, result);
    return result;
  }

  /*
    Sorted by object name so the grid is stable across reloads.

    The graph's own order is file-load order, which changes when a file is renamed or the
    layout preset moves it. A dictionary that reorders itself between visits cannot be
    diffed by eye, and this screen exists to be read line by line.
  */
  const objects = [...graph.inModel(model)]
    .map((loaded) => loaded.object)
    .filter((object): object is Table | Entity => object.kind === "table" || object.kind === "entity")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const object of objects) {
    if (object.kind === "table") {
      const keys = new Set((object.primaryKey ?? []).map((name) => name.toLowerCase()));
      const foreign = new Set(
        (object.foreignKeys ?? []).flatMap((fk) => fk.columns.map((name) => name.toLowerCase())),
      );

      walkColumns(object.columns ?? [], "", 0, (column, path, depth) => {
        rows.push({
          objectId: object.id,
          objectName: object.name,
          objectKind: "table",
          ...(object.dataset ? { dataset: object.dataset } : {}),
          ...(object.layer ? { layer: object.layer } : {}),
          path,
          name: column.name,
          type: column.dataType,
          required: column.mode === "REQUIRED",
          /*
            Only a top-level column can be a key. A STRUCT field cannot appear in
            `primaryKey`, and matching on the leaf name would mark `address.id` as the
            primary key of a table whose key is `id`.
          */
          isPrimaryKey: depth === 0 && keys.has(column.name.toLowerCase()),
          isForeignKey: depth === 0 && foreign.has(column.name.toLowerCase()),
          depth,
          ...annotations(column, inheritedFrom(column.domain)),
        });
      });
      continue;
    }

    const keys = new Set((object.primaryKey ?? []).map((name) => name.toLowerCase()));
    for (const attribute of object.attributes ?? []) {
      rows.push({
        objectId: object.id,
        objectName: object.name,
        objectKind: "entity",
        path: attribute.name,
        name: attribute.name,
        /*
          The logical type, or the domain it comes from, or nothing.

          Resolving the domain's own type here would be a lie by omission: on this screen
          "inherits `Money`" is the fact worth showing, because it is what you would change.
        */
        type: attribute.logicalType ?? (attribute.domain ? `→ ${attribute.domain}` : ""),
        required: attribute.required ?? false,
        isPrimaryKey: keys.has(attribute.name.toLowerCase()),
        isForeignKey: false,
        depth: 0,
        ...annotations(attribute, inheritedFrom(attribute.domain)),
      });
    }
  }

  /*
    Inherited classification counts as classified.

    A model typed entirely through a governed domain library would otherwise report 0%, and
    the number exists to tell you what still needs attention, not to reward writing the
    same annotation onto every column by hand.
  */
  const classified = rows.filter(
    (row) =>
      row.sensitivity ||
      row.categories.length > 0 ||
      row.inherited?.sensitivity ||
      (row.inherited?.categories.length ?? 0) > 0,
  ).length;

  return {
    model,
    rows,
    sensitivityLevels: SENSITIVITY_LEVELS,
    categories: DATA_CATEGORIES,
    classified,
    total: rows.length,
  };
}

/**
 * Depth-first over columns and their STRUCT fields, building the dotted path as it goes.
 *
 * Depth-first rather than breadth-first so `address` is immediately followed by
 * `address.postcode` in the output. The grid indents by depth, and a breadth-first order
 * would put every top-level column first and its children in a block at the bottom, which
 * indentation cannot rescue.
 */
function walkColumns(
  columns: Column[],
  prefix: string,
  depth: number,
  visit: (column: Column, path: string, depth: number) => void,
): void {
  for (const column of columns) {
    const path = prefix ? `${prefix}.${column.name}` : column.name;
    visit(column, path, depth);
    if (column.fields?.length) walkColumns(column.fields, path, depth + 1, visit);
  }
}

/** The metadata fields shared by columns and attributes. */
function annotations(
  member: Column | Attribute,
  inherited: DictionaryRow["inherited"],
): Pick<
  DictionaryRow,
  | "description"
  | "sensitivity"
  | "categories"
  | "policyTagName"
  | "hasPolicyTag"
  | "inherited"
  | "domain"
  | "attributeRef"
  | "tags"
> {
  const classification = member.classification;
  const attributeRef = "attributeRef" in member ? member.attributeRef : undefined;

  return {
    ...(member.description ? { description: member.description } : {}),
    ...(classification?.sensitivity ? { sensitivity: classification.sensitivity } : {}),
    categories: classification?.categories ?? [],
    ...(classification?.policyTagName ? { policyTagName: classification.policyTagName } : {}),
    hasPolicyTag: Boolean(classification?.policyTag),
    ...(inherited ? { inherited } : {}),
    ...(member.domain ? { domain: member.domain } : {}),
    ...(attributeRef ? { attributeRef } : {}),
    tags: member.tags ?? [],
  };
}

/** True when this object kind has fields a dictionary can list. */
export function hasFields(object: AnyObject): boolean {
  return object.kind === "table" || object.kind === "entity";
}
