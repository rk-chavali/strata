import { readDdl } from "./ddl.js";
import { readErwinXml } from "./erwin.js";
import { readTabular } from "./tabular.js";
import { cardinalityEnds, identifierise, toLogicalType, type SourceModel } from "./ir.js";

export * from "./ir.js";
export { readDdl } from "./ddl.js";
export { readErwinXml } from "./erwin.js";
export { readTabular, parseDelimited } from "./tabular.js";
/*
  The live reader, kept out of `read()` and `detectFormat` on purpose.

  Those two answer "what is this text", and a warehouse is not text. Listing it as a
  `SourceFormat` would put a value in that union which no file could ever be detected as, and
  every switch over formats would grow a branch that cannot happen.
*/
export {
  readBigQuery,
  columnsQuery,
  keysQuery,
  assertDatasetId,
  type BigQueryColumnRow,
  type BigQueryKeyRow,
} from "./bigquery.js";

export type SourceFormat = "erwin-xml" | "ddl" | "tabular";

/**
 * Work out what a file is from its content, not its extension.
 *
 * A `.txt` full of `CREATE TABLE` is DDL, and an erwin export saved as `.dat` is still
 * XML. Extensions are advisory at best when the file has been through a mail server and
 * three people's downloads folder.
 */
/**
 * Recognise erwin's own binary model file.
 *
 * A `.erwin` file is a proprietary compound document, not markup, it opens with the
 * marker `GDM` and is full of NUL bytes. It happens to contain commas, so without this
 * check the delimited reader claims it and fails with "could not find a table column",
 * which tells the user nothing about the actual problem: the file simply cannot be read
 * by anything except erwin.
 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 2048);
  // Control characters are the signal being sniffed for, not an accident in the pattern:
  // a leading U+FFFD followed by ETX is how erwin's binary export starts.
  // oxlint-disable-next-line no-control-regex
  if (/^�?|GDM/.test(head.slice(0, 16))) return true;

  // Replacement characters and NULs in the first couple of kilobytes mean this was not
  // text to begin with.
  let suspicious = 0;
  for (const char of head) {
    const code = char.charCodeAt(0);
    if (code === 0 || code === 0xfffd) suspicious += 1;
  }
  return suspicious > head.length / 50;
}

export function detectFormat(text: string): SourceFormat | undefined {
  if (looksBinary(text)) return undefined;

  const head = text.slice(0, 4096).trimStart();

  if (head.startsWith("<?xml") || /^<\w[\s\S]*>/.test(head)) return "erwin-xml";
  if (/\bCREATE\s+(OR\s+REPLACE\s+)?(EXTERNAL\s+|TEMP(ORARY)?\s+)?TABLE\b/i.test(text)) return "ddl";

  const firstLine = head.split(/\r?\n/)[0] ?? "";
  if (firstLine.includes(",") || firstLine.includes("\t")) return "tabular";

  return undefined;
}

export function read(text: string, format?: SourceFormat): SourceModel {
  const chosen = format ?? detectFormat(text);

  if (!chosen) {
    const binary = looksBinary(text);
    return {
      entities: [],
      relationships: [],
      domains: [],
      format: "unknown",
      diagnostics: [
        binary
          ? {
              severity: "error",
              code: "import/binaryModel",
              // Naming the fix matters more than naming the fault: nobody can act on
              // "unsupported format", and everybody can act on "File > Save As > XML".
              message:
                "this is erwin's own binary model file (.erwin), which only erwin can read. In erwin Data Modeler use File → Save As → XML to get an importable export, or Tools → Forward Engineer to get a DDL script.",
            }
          : {
              severity: "error",
              code: "import/unknownFormat",
              message:
                "could not tell what this file is. Supported: erwin XML export, a DDL script, or a CSV of tables and columns.",
            },
      ],
    };
  }

  if (chosen === "erwin-xml") return readErwinXml(text);
  if (chosen === "ddl") return readDdl(text);
  return readTabular(text);
}

// ---------------------------------------------------------------- mapping

export interface MappedObject {
  id: string;
  kind: string;
  name: string;
  model?: string;
  [key: string]: unknown;
}

export interface MapOptions {
  /** Model these objects belong to. */
  model: string;
  tier: "conceptual" | "logical" | "physical";
  /** Prefix for generated ids, so a second import cannot collide with the first. */
  idPrefix?: string;
  /** BigQuery dataset for imported tables, when the source did not say. */
  dataset?: string;
}

/**
 * Turn what a reader found into objects our metamodel accepts.
 *
 * Kept separate from the readers so every format lands on the same rules. The mapping
 * itself is deliberately conservative: it never invents a datatype it was not given,
 * and it never drops something silently, anything it cannot place is returned as a
 * diagnostic for the preview to show.
 */
export function mapToObjects(
  source: SourceModel,
  options: MapOptions,
): { objects: MappedObject[]; diagnostics: SourceModel["diagnostics"] } {
  const objects: MappedObject[] = [];
  const diagnostics = [...source.diagnostics];
  const prefix = options.idPrefix ?? identifierise(options.model);

  /** Source name → the id we minted, so relationships can resolve to real objects. */
  const idByName = new Map<string, string>();
  const used = new Set<string>();

  for (const entity of source.entities) {
    const base = `${prefix}_${identifierise(entity.physicalName ?? entity.name)}`;
    let id = base;
    // Two source entities can normalise to the same identifier, `Order Line` and
    // `order_line`. Colliding ids would silently merge two tables into one.
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}_${suffix}`;
    used.add(id);
    idByName.set(entity.name.toLowerCase(), id);
    if (entity.physicalName) idByName.set(entity.physicalName.toLowerCase(), id);

    const kind = options.tier === "physical" ? "table" : options.tier === "logical" ? "entity" : "concept";
    const object: MappedObject = {
      id,
      kind,
      name: options.tier === "physical" ? (entity.physicalName ?? entity.name) : entity.name,
      model: options.model,
    };

    if (entity.description) object.description = entity.description;
    // Same trap as domains: `subjectArea` is a reference, not a label, so passing the
    // source's own spelling through leaves it pointing at nothing. erwin puts a subject
    // area on almost every entity, so this alone produced dozens of unresolved
    // references on a real import.
    if (entity.subjectArea) object.subjectArea = `sa_${identifierise(entity.subjectArea)}`;

    if (kind === "concept") {
      // A conceptual model has no columns by definition; carrying them would produce
      // an object the validator rejects.
      if (entity.columns.length > 0) {
        diagnostics.push({
          severity: "info",
          code: "map/columnsDropped",
          message: `${entity.columns.length} attribute(s) on \`${entity.name}\` not imported, a conceptual model holds no attributes`,
          at: entity.name,
        });
      }
      objects.push(object);
      continue;
    }

    const members = entity.columns.map((column) => ({
      id: `${id}_${identifierise(column.name)}`,
      name: column.name,
      // A table column carries the warehouse type verbatim; a logical attribute carries
      // a classified one. Writing `dataType` on an attribute is not an error the schema
      // reports, zod strips unknown keys, so the type simply vanished, and the import
      // looked like it had worked.
      ...(kind === "table"
        ? { dataType: column.type ?? "STRING", mode: column.required ? "REQUIRED" : "NULLABLE" }
        : {
            ...(column.type ? { logicalType: toLogicalType(column.type) } : {}),
            required: column.required ?? false,
          }),
      ...(column.description ? { description: column.description } : {}),
      // Reference the domain by the id we mint for it, not by its source name. Passing
      // `RiskBand` straight through leaves a reference that resolves to nothing, because
      // the domain object itself lands as `dom_riskband`, so every typed attribute in
      // an erwin model would import with a dangling type.
      ...(column.domain ? { domain: `dom_${identifierise(column.domain)}` } : {}),
    }));

    for (const column of entity.columns) {
      if (kind === "table" && !column.type) {
        diagnostics.push({
          severity: "warning",
          code: "map/untypedColumn",
          message: `\`${entity.name}.${column.name}\` had no datatype; defaulted to STRING`,
          at: entity.name,
        });
      }
    }

    if (kind === "table") {
      object.columns = members;
      object.dataset = entity.schema ?? options.dataset ?? "imported";
    } else {
      object.attributes = members;
    }

    const keys = entity.columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
    if (keys.length > 0) object.primaryKey = keys;
    else {
      diagnostics.push({
        severity: "warning",
        code: "map/noPrimaryKey",
        message: `\`${entity.name}\` has no primary key in the source`,
        at: entity.name,
      });
    }

    objects.push(object);
  }

  for (const relationship of source.relationships) {
    const parentId = idByName.get(relationship.parent.toLowerCase());
    const childId = idByName.get(relationship.child.toLowerCase());

    if (!parentId || !childId) {
      diagnostics.push({
        severity: "warning",
        code: "map/danglingRelationship",
        message: `relationship ${relationship.parent} → ${relationship.child} skipped: ${
          !parentId ? relationship.parent : relationship.child
        } was not imported`,
      });
      continue;
    }

    // A physical model expresses this as a foreign key on the child table, a logical one
    // as a first-class relationship object. Same fact, two shapes, which is the whole
    // reason the mapper exists rather than each reader deciding for itself.
    if (options.tier === "physical") {
      const child = objects.find((object) => object.id === childId);
      if (!child) continue;
      const keys = (child.foreignKeys as unknown[] | undefined) ?? [];
      keys.push({
        name: relationship.name ?? `fk_${identifierise(relationship.child)}_${identifierise(relationship.parent)}`,
        columns: relationship.childColumns ?? [],
        references: { table: parentId, columns: relationship.parentColumns ?? [] },
      });
      child.foreignKeys = keys;
      continue;
    }

    const ends = cardinalityEnds(relationship.cardinality);
    objects.push({
      id: `${prefix}_rel_${identifierise(relationship.name ?? `${relationship.parent}_${relationship.child}`)}`,
      kind: "relationship",
      name: relationship.name ?? `${relationship.parent} to ${relationship.child}`,
      model: options.model,
      tier: options.tier,
      // Cardinality lives on each end here, not as one phrase on the relationship.
      parent: {
        ref: parentId,
        cardinality: ends.parent,
        ...(relationship.name ? { verbPhrase: relationship.name } : {}),
        attributes: relationship.parentColumns ?? [],
      },
      child: {
        ref: childId,
        cardinality: ends.child,
        attributes: relationship.childColumns ?? [],
      },
      identifying: relationship.identifying ?? false,
    });
  }

  // Attributes may reference a domain the file never defined, common when a model was
  // exported without its type library. Reported rather than left to fail validation
  // later with a message that does not mention the import.
  const defined = new Set(source.domains.map((domain) => identifierise(domain.name)));
  const referenced = new Set(
    source.entities.flatMap((entity) =>
      entity.columns.filter((column) => column.domain).map((column) => identifierise(column.domain!)),
    ),
  );
  for (const name of referenced) {
    if (!defined.has(name)) {
      diagnostics.push({
        severity: "warning",
        code: "map/missingDomain",
        message: `attributes reference the domain \`${name}\`, which this file does not define`,
      });
    }
  }

  /**
   * Create the subject areas the entities point at.
   *
   * Derived from what the entities actually use rather than only from an explicit list,
   * because the two do not always agree, an export can carry an entity tagged with a
   * subject area whose definition did not make it into the file. Minting the object
   * either way keeps the reference resolvable, which matters more than being pedantic
   * about where the name came from.
   */
  const areas = new Set(
    source.entities.map((entity) => entity.subjectArea).filter((area): area is string => Boolean(area)),
  );
  for (const area of areas) {
    objects.push({
      id: `sa_${identifierise(area)}`,
      kind: "subjectArea",
      name: area,
      model: options.model,
    });
  }

  for (const domain of source.domains) {
    objects.push({
      id: `dom_${identifierise(domain.name)}`,
      kind: "domain",
      name: domain.name,
      // `logicalType` is a closed vocabulary; the source's own spelling is kept as the
      // physical type so nothing is lost.
      logicalType: toLogicalType(domain.type),
      ...(domain.type ? { physicalType: domain.type } : {}),
      ...(domain.description ? { description: domain.description } : {}),
    });

    if (domain.type && toLogicalType(domain.type) === "unknown") {
      diagnostics.push({
        severity: "warning",
        code: "map/unknownDomainType",
        message: `domain \`${domain.name}\`: could not classify \`${domain.type}\`, imported as unknown`,
        at: domain.name,
      });
    }
  }

  return { objects, diagnostics };
}
