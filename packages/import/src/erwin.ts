import { XMLParser } from "fast-xml-parser";
import { emptyModel, normaliseCardinality, type SourceColumn, type SourceEntity, type SourceModel } from "./ir.js";

/**
 * Read an erwin Data Modeler XML export.
 *
 * **Why this is written as a search rather than as a schema.** erwin has shipped several
 * incompatible XML shapes across r7, r9, 2019 and 2020+: some nest everything under
 * `<EROBJECT>` elements whose type is an attribute, others use named elements like
 * `<Entity>` and `<Attribute>`, and the property names differ again between logical and
 * physical exports. Coding to one of them means the importer works for exactly the
 * customers who happen to run that release, and fails opaquely for everyone else.
 *
 * So this walks the whole document and recognises nodes by shape: anything that looks
 * like an entity, with children that look like attributes. It is deliberately
 * permissive, and every guess it cannot make becomes a diagnostic the user sees before
 * anything is written.
 *
 * The honest limitation: this has been built against erwin's documented structures and
 * verified with synthetic files in both dialects, not against a production export from
 * every release. The preview exists precisely because of that, nothing is written
 * until a human has looked at what was understood.
 */

/** Element names erwin has used for an entity, across versions and export modes. */
const ENTITY_NAMES = new Set(["entity", "table", "erentity", "ertable"]);
const ATTRIBUTE_NAMES = new Set(["attribute", "column", "erattribute", "ercolumn"]);
const RELATIONSHIP_NAMES = new Set(["relationship", "errelationship", "foreignkey", "erforeignkey"]);
const DOMAIN_NAMES = new Set(["domain", "erdomain"]);

/** Property names carrying a display name, in the order we prefer them. */
const NAME_KEYS = ["name", "Name", "logical_name", "LogicalName", "physical_name", "PhysicalName"];

interface XmlNode {
  [key: string]: unknown;
}

export function readErwinXml(xml: string): SourceModel {
  const model = emptyModel("erwin-xml");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    // erwin exports carry namespace prefixes that differ by version and mean nothing
    // to us; stripping them lets one set of names match every dialect.
    removeNSPrefix: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });

  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch (error) {
    model.diagnostics.push({
      severity: "error",
      code: "erwin/unparsable",
      message: `this file is not valid XML: ${error instanceof Error ? error.message : String(error)}`,
    });
    return model;
  }

  walk(document, "", model);

  // An error only when the file yielded *nothing*. A domains-only or relationships-only
  // export is a legitimate partial import, and failing it would block the very case
  // where someone is bringing across a shared type library on its own.
  if (model.entities.length === 0 && model.domains.length === 0 && model.relationships.length === 0) {
    model.diagnostics.push({
      severity: "error",
      code: "erwin/noEntities",
      message:
        "nothing recognised in this file. It may be an erwin dialect the reader does not know, send the file and the mapping can be extended.",
    });
  } else if (model.entities.length === 0) {
    model.diagnostics.push({
      severity: "info",
      code: "erwin/noEntities",
      message: "no entities or tables found; importing the other objects only",
    });
  }

  model.tier = guessTier(model.entities);
  return model;
}

/**
 * Decide whether this is a logical or a physical export.
 *
 * "Has datatypes" is the obvious signal and it is wrong: erwin logical models carry
 * datatypes too, so it calls almost everything physical. The distinguishing feature is
 * *naming*. A logical model uses business language, `Account Party Role`, `Legal Name`,
 * spaces and mixed case, and usually carries a separate physical name alongside. A
 * physical export has only the database identifiers.
 *
 * Still only a default; the import dialog lets the user say otherwise, and the tier
 * decides the shape of everything produced.
 */
function guessTier(entities: SourceModel["entities"]): "logical" | "physical" {
  if (entities.length === 0) return "logical";

  const logicalLooking = entities.filter(
    (entity) =>
      // A distinct physical name is erwin explicitly saying "this name is the logical one".
      Boolean(entity.physicalName) ||
      / /.test(entity.name) ||
      entity.columns.some((column) => / /.test(column.name)),
  );

  return logicalLooking.length > entities.length / 2 ? "logical" : "physical";
}

/** Depth-first walk, recognising nodes by name rather than by position. */
function walk(node: unknown, name: string, model: SourceModel): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, name, model);
    return;
  }
  if (!node || typeof node !== "object") return;

  const record = node as XmlNode;
  const key = name.toLowerCase();

  if (ENTITY_NAMES.has(key) || isErObject(record, ENTITY_NAMES)) {
    const entity = readEntity(record, model);
    if (entity) model.entities.push(entity);
    // Deliberately no `return`: relationships and domains are frequently nested inside
    // the entity that owns them, and stopping here would lose all of them.
  }

  if (RELATIONSHIP_NAMES.has(key) || isErObject(record, RELATIONSHIP_NAMES)) {
    readRelationship(record, model);
  }

  if (DOMAIN_NAMES.has(key) || isErObject(record, DOMAIN_NAMES)) {
    const domainName = textOf(record, NAME_KEYS);
    if (domainName) {
      model.domains.push({
        name: domainName,
        ...(textOf(record, ["datatype", "DataType", "physical_datatype"]) ? { type: textOf(record, ["datatype", "DataType", "physical_datatype"])! } : {}),
        ...(textOf(record, ["definition", "Definition", "comment"]) ? { description: textOf(record, ["definition", "Definition", "comment"])! } : {}),
      });
    }
  }

  for (const [childName, child] of Object.entries(record)) {
    if (childName.startsWith("@") || childName === "#text") continue;
    walk(child, childName, model);
  }
}

/**
 * erwin's generic form: `<EROBJECT Type="Entity">` rather than `<Entity>`.
 *
 * Checked as well as the element name because the two dialects are otherwise
 * indistinguishable, and a file can mix them.
 */
function isErObject(record: XmlNode, kinds: Set<string>): boolean {
  const type = record["@Type"] ?? record["@type"] ?? record["@ObjectType"];
  return typeof type === "string" && kinds.has(type.toLowerCase().replace(/[\s_]/g, ""));
}

function readEntity(record: XmlNode, model: SourceModel): SourceEntity | undefined {
  const logicalName = textOf(record, ["name", "Name", "logical_name", "LogicalName"]);
  const name = logicalName ?? textOf(record, ["physical_name", "PhysicalName", "TableName"]);

  // Falling back to the physical name is better than dropping the entity, but it is a
  // guess and the result reads oddly among business names, so say so rather than let
  // `ORPHANED_TABLE` appear beside `Account Party Role` with no explanation.
  if (!logicalName && name) {
    model.diagnostics.push({
      severity: "warning",
      code: "erwin/noLogicalName",
      message: `\`${name}\` has no logical name; its physical name was used instead`,
      at: name,
    });
  }

  if (!name) {
    model.diagnostics.push({
      severity: "warning",
      code: "erwin/unnamedEntity",
      message: "an entity had no readable name and was skipped",
    });
    return undefined;
  }

  const entity: SourceEntity = { name, columns: [] };

  const physical = textOf(record, ["physical_name", "PhysicalName", "TableName"]);
  if (physical && physical !== name) entity.physicalName = physical;

  const definition = textOf(record, ["definition", "Definition", "comment", "Comment", "Note"]);
  if (definition) entity.description = definition;

  const subjectArea = textOf(record, ["subject_area", "SubjectArea", "SubjectAreaName"]);
  if (subjectArea) entity.subjectArea = subjectArea;

  collectAttributes(record, entity);

  if (entity.columns.length === 0) {
    model.diagnostics.push({
      severity: "warning",
      code: "erwin/noAttributes",
      message: `\`${name}\` has no readable attributes`,
      at: name,
    });
  }

  return entity;
}

/** Find attribute nodes anywhere beneath an entity, at whatever depth erwin nested them. */
function collectAttributes(node: unknown, entity: SourceEntity): void {
  if (Array.isArray(node)) {
    for (const item of node) collectAttributes(item, entity);
    return;
  }
  if (!node || typeof node !== "object") return;

  for (const [childName, child] of Object.entries(node as XmlNode)) {
    if (childName.startsWith("@") || childName === "#text") continue;

    const key = childName.toLowerCase();
    const items = Array.isArray(child) ? child : [child];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as XmlNode;

      if (ATTRIBUTE_NAMES.has(key) || isErObject(record, ATTRIBUTE_NAMES)) {
        const column = readAttribute(record);
        if (column) entity.columns.push(column);
        continue;
      }
      // A list wrapper like <AttributeList> or <Columns>: keep descending.
      collectAttributes(record, entity);
    }
  }
}

function readAttribute(record: XmlNode): SourceColumn | undefined {
  const name = textOf(record, NAME_KEYS);
  if (!name) return undefined;

  const column: SourceColumn = { name };

  const type = textOf(record, ["datatype", "DataType", "physical_datatype", "PhysicalDataType", "Type"]);
  if (type) column.type = type;

  const domain = textOf(record, ["domain", "Domain", "DomainName", "parent_domain"]);
  if (domain) column.domain = domain;

  const definition = textOf(record, ["definition", "Definition", "comment", "Comment"]);
  if (definition) column.description = definition;

  if (isTrue(record, ["primary_key", "PrimaryKey", "IsPK", "PK"])) {
    column.isPrimaryKey = true;
    column.required = true;
  }
  // erwin stores this either way round depending on the version, so both are read and
  // the affirmative one wins, guessing "nullable" for an unmarked column is the safer
  // default, since a wrong NOT NULL breaks a load and a wrong NULL does not.
  if (isTrue(record, ["not_null", "NotNull", "IsRequired", "Required"])) column.required = true;
  else if (isFalse(record, ["null_option", "NullOption", "Nullable", "IsNullable"])) column.required = true;

  return column;
}

function readRelationship(record: XmlNode, model: SourceModel): void {
  const parent = textOf(record, ["parent_entity", "ParentEntity", "Parent", "parent", "PrimaryEntity"]);
  const child = textOf(record, ["child_entity", "ChildEntity", "Child", "child", "ForeignEntity"]);

  if (!parent || !child) {
    model.diagnostics.push({
      severity: "warning",
      code: "erwin/danglingRelationship",
      message: "a relationship was missing a parent or child and was skipped",
      at: textOf(record, NAME_KEYS) ?? undefined,
    });
    return;
  }

  const rawCardinality = textOf(record, ["cardinality", "Cardinality", "RelationshipCardinality", "Type"]);
  const cardinality = normaliseCardinality(rawCardinality);

  if (rawCardinality && !cardinality) {
    model.diagnostics.push({
      severity: "info",
      code: "erwin/unknownCardinality",
      message: `cardinality \`${rawCardinality}\` not recognised; defaulted to one-to-many`,
      at: `${parent} → ${child}`,
    });
  }

  model.relationships.push({
    ...(textOf(record, NAME_KEYS) ? { name: textOf(record, NAME_KEYS)! } : {}),
    parent,
    child,
    cardinality: cardinality ?? "one-to-many",
    identifying: isTrue(record, ["identifying", "Identifying", "IsIdentifying"]),
  });
}

/**
 * Read a value that may be an attribute, a child element, or element text.
 *
 * erwin puts the same property in all three places depending on version and on whether
 * the value contains markup, so a reader that checks only one finds half the fields.
 */
function textOf(record: XmlNode, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    for (const candidate of [`@${key}`, key]) {
      const value = record[candidate];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const text = (value as XmlNode)["#text"];
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
  }
  return undefined;
}

function isTrue(record: XmlNode, keys: readonly string[]): boolean {
  const value = textOf(record, keys)?.toLowerCase();
  return value === "true" || value === "yes" || value === "1" || value === "y";
}

function isFalse(record: XmlNode, keys: readonly string[]): boolean {
  const value = textOf(record, keys)?.toLowerCase();
  return value === "false" || value === "no" || value === "0" || value === "n" || value === "notnull";
}
