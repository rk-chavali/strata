import {
  findColumn,
  migrateDiagram,
  walkColumns,
  type AnyObject,
  type Diagnostic,
  type Diagram,
  type DiagramConnector,
  type DiagramShape,
  type Entity,
  type Model,
  type ObjectGraph,
  type Relationship,
  type Table,
} from "@strata/metamodel";
import type { LoadedWorkspace } from "@strata/storage";

/**
 * View models for the UI.
 *
 * The API deliberately hands the browser a rendering-ready shape rather than raw
 * model objects. Resolving domains, migrating keys and working out cardinality
 * glyphs are all metamodel concerns, and doing them once on the server keeps that
 * logic in one place instead of duplicated in the client.
 */

export interface MemberView {
  name: string;
  /**
   * Dotted path from the object root, e.g. `address.postcode`.
   *
   * In-place edits address a member by path rather than by position, because the
   * flattened list the canvas renders interleaves nested STRUCT fields with top-level
   * ones, an index into it means nothing to the stored object.
   */
  path: string;
  /** Display type: resolved from the domain when the member does not state one. */
  type: string;
  required: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  description?: string;
  /** Nesting depth, for indenting STRUCT fields. */
  depth: number;
  classification?: string;
}

export interface NodeView {
  id: string;
  name: string;
  kind: AnyObject["kind"];
  subjectArea?: string;
  layer?: string;
  description?: string;
  members: MemberView[];
  x: number;
  y: number;
  /** True when the position came from a saved diagram rather than auto-layout. */
  positioned: boolean;
  /**
   * Estimated rendered size.
   *
   * The canvas needs node dimensions before it can route an edge. Waiting for the
   * browser to measure them means edges pop in a frame late, and never appear at
   * all if the tab is backgrounded, since the observer that measures them does not
   * fire. Sending an estimate lets edges draw immediately; the real measurement
   * refines it.
   */
  width: number;
  height: number;
  /** True when the user resized this box, so the size is intentional rather than an estimate. */
  userSized: boolean;
  /**
   * `entity` / `associative` / `weak` / `supertype` / `subtype`, for logical entities.
   *
   * The canvas needs it to draw IDEF1X, where an identifier-dependent entity, one whose
   * primary key contains a migrated key, so `weak` and `associative`, is drawn with
   * rounded corners and an independent one with square corners. That distinction is not
   * decorative: it is how a reader tells at a glance which boxes cannot exist on their own.
   *
   * Absent on tables and concepts, which have no such notion.
   */
  entityType?: string;
  /** Supertype this entity specialises, for drawing an IDEF1X subtype cluster. */
  supertype?: string;
  /** Whether the subtypes of this supertype are exhaustive. Drives the cluster glyph. */
  subtypeCompleteness?: "complete" | "incomplete";
}

export interface EdgeView {
  id: string;
  name: string;
  sourceId: string;
  targetId: string;
  sourceCardinality: string;
  targetCardinality: string;
  identifying: boolean;
  /** `relationship` for a declared one, `foreignKey` for one derived from a FK. */
  origin: "relationship" | "foreignKey";
  /**
   * The columns the join is actually on, parent side then child side, positionally paired.
   *
   * `sourceMembers[i]` joins to `targetMembers[i]`, which is how a composite key keeps its
   * order. Sent so the canvas can anchor a line to the *row* it joins on rather than to
   * the box: a fact table with six foreign keys all arriving at one edge tells a reader
   * that six things are related and nothing about which columns carry them.
   *
   * Empty on a conceptual model, where relationships carry no attributes at all.
   */
  sourceMembers: string[];
  targetMembers: string[];
  label?: string;
}

export interface ModelView {
  id: string;
  name: string;
  tier: Model["tier"];
  /** Business domain, e.g. `retail`. Groups the tiers of one modelling effort. */
  namespace?: string;
  description?: string;
  derivedFrom?: string;
  layers: string[];
  objectCount: number;
  counts: Record<string, number>;
}

export interface GraphView {
  model: ModelView;
  nodes: NodeView[];
  edges: EdgeView[];
  /** Free-form shapes and text drawn on the canvas. */
  shapes: DiagramShape[];
  /** Hand-drawn connectors, distinct from semantic relationship edges. */
  connectors: DiagramConnector[];
  /** Diagram used for positions, when one exists. */
  diagram?: { id: string; name: string; notation: string; gridSize: number };
}

export function modelViews(
  graph: ObjectGraph,
  /**
   * Diagnostics to attribute to each model, so a list of models can show which of them are
   * broken without a second request per row.
   *
   * Optional because the graph alone is enough for every other field, and callers that do not
   * have diagnostics to hand should not be forced to compute them.
   */
  diagnostics: readonly Diagnostic[] = [],
): ModelView[] {
  /**
   * Which model each diagnostic belongs to.
   *
   * By `objectId`, resolved through the graph, rather than by the file path: a diagnostic on a
   * shared object has no model, and under a single-file layout several models can live in one
   * file, so the path is ambiguous exactly where being wrong would matter.
   */
  const problemsByModel = new Map<string, { error: number; warning: number }>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "info") continue;
    if (!diagnostic.objectId) continue;

    const owner = graph.get(diagnostic.objectId)?.object;
    if (!owner) continue;
    const model = owner.kind === "model" ? owner.name : owner.model;
    if (!model) continue;

    const bucket = problemsByModel.get(model) ?? { error: 0, warning: 0 };
    bucket[diagnostic.severity] += 1;
    problemsByModel.set(model, bucket);
  }

  return graph
    .models()
    .map((entry) => {
      const members = graph.inModel(entry.object.name);
      const counts: Record<string, number> = {};
      for (const member of members) counts[member.object.kind] = (counts[member.object.kind] ?? 0) + 1;
      return {
        id: entry.object.id,
        name: entry.object.name,
        tier: entry.object.tier,
        ...(entry.object.namespace ? { namespace: entry.object.namespace } : {}),
        ...(entry.object.description ? { description: entry.object.description } : {}),
        ...(entry.object.derivedFrom ? { derivedFrom: entry.object.derivedFrom } : {}),
        ...(entry.object.displayName ? { displayName: entry.object.displayName } : {}),
        ...(entry.object.lifecycle ? { lifecycle: entry.object.lifecycle } : {}),
        ...(entry.object.ownership ? { ownership: entry.object.ownership } : {}),
        tags: entry.object.tags,
        layers: entry.object.layers,
        objectCount: members.length,
        counts,
        problems: problemsByModel.get(entry.object.name) ?? { error: 0, warning: 0 },
      };
    })
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.name.localeCompare(b.name));
}

function tierRank(tier: Model["tier"]): number {
  return tier === "conceptual" ? 0 : tier === "logical" ? 1 : 2;
}

export function buildGraphView(
  workspace: LoadedWorkspace,
  modelName: string,
  /**
   * Open one diagram rather than the whole model.
   *
   * At any real size a model has hundreds of objects, and drawing all of them on one
   * auto-laid-out canvas is unreadable, which is precisely why erwin has subject-area
   * views. A diagram is a curated subset someone chose; opening it shows only that.
   * Omit to see everything, which is still the right default for a small model.
   */
  diagramId?: string,
): GraphView | undefined {
  const graph = workspace.graph;
  const model = graph.modelNamed(modelName);
  if (!model) return undefined;

  const members = graph.inModel(modelName);

  // Migrating on read means the rest of the system only ever sees `shapes`.
  const raw = diagramId
    ? members.find((entry) => entry.object.id === diagramId)?.object
    : members.find((entry) => entry.object.kind === "diagram")?.object;
  const diagram: Diagram | undefined = raw?.kind === "diagram" ? migrateDiagram(raw) : undefined;

  let drawable = members.filter(
    (entry) => entry.object.kind === "entity" || entry.object.kind === "table" || entry.object.kind === "concept",
  );

  if (diagramId && diagram) {
    // Restrict to what the diagram names, plus anything in a subject area it auto-includes.
    const named = new Set<string>();
    for (const node of diagram.nodes) {
      const resolved = graph.resolve(node.ref, { model: modelName });
      if (resolved) named.add(resolved.target.object.id);
    }
    const autoAreas = new Set(
      diagram.autoIncludeSubjectAreas
        .map((ref) => graph.resolve(ref, { model: modelName, kind: "subjectArea" })?.target.object.name)
        .filter((name): name is string => Boolean(name)),
    );

    drawable = drawable.filter((entry) => {
      if (named.has(entry.object.id)) return true;
      const area = "subjectArea" in entry.object ? entry.object.subjectArea : undefined;
      return Boolean(area && autoAreas.has(area));
    });
  }

  const savedPositions = new Map<string, { x: number; y: number; width?: number; height?: number }>();
  if (diagram) {
    for (const node of diagram.nodes) {
      const resolved = graph.resolve(node.ref, { model: modelName });
      if (!resolved) continue;
      savedPositions.set(resolved.target.object.id, {
        x: node.x,
        y: node.y,
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
      });
    }
  }

  const nodes: NodeView[] = drawable.map((entry) => {
    const object = entry.object;
    const saved = savedPositions.get(object.id);
    const members = membersOf(graph, object);
    return {
      id: object.id,
      name: object.name,
      kind: object.kind,
      ...(("subjectArea" in object && object.subjectArea) ? { subjectArea: object.subjectArea } : {}),
      ...(object.kind === "table" && object.layer ? { layer: object.layer } : {}),
      ...(object.description ? { description: object.description } : {}),
      // Only entities carry these; a table or concept has no dependence or inheritance.
      ...(object.kind === "entity" ? { entityType: object.entityType } : {}),
      ...(object.kind === "entity" && object.supertype ? { supertype: object.supertype } : {}),
      ...(object.kind === "entity" && object.subtypeCompleteness
        ? { subtypeCompleteness: object.subtypeCompleteness }
        : {}),
      members,
      x: saved?.x ?? 0,
      y: saved?.y ?? 0,
      positioned: Boolean(saved),
      // A user-set size wins; otherwise estimate, so a box grows as columns are added.
      width: saved?.width ?? NODE_WIDTH,
      height: saved?.height ?? estimatedHeightFor(members.length),
      userSized: saved?.width !== undefined || saved?.height !== undefined,
    };
  });

  const edges = edgesOf(graph, modelName, nodes);
  autoLayout(nodes, edges);

  return {
    model: modelViews(graph).find((m) => m.name === modelName)!,
    nodes,
    edges,
    shapes: diagram?.shapes ?? [],
    connectors: diagram?.connectors ?? [],
    ...(diagram
      ? {
          diagram: {
            id: diagram.id,
            name: diagram.name,
            notation: diagram.notation,
            gridSize: diagram.gridSize,
          },
        }
      : {}),
  };
}

function membersOf(graph: ObjectGraph, object: AnyObject): MemberView[] {
  if (object.kind === "entity") return entityMembers(graph, object as Entity);
  if (object.kind === "table") return tableMembers(object as Table);
  return [];
}

function entityMembers(graph: ObjectGraph, entity: Entity): MemberView[] {
  const primaryKey = new Set(entity.primaryKey.map((n) => n.toLowerCase()));
  return entity.attributes.map((attribute) => {
    // The domain is the type of record; an inline logicalType is the fallback.
    const domain = attribute.domain
      ? graph.resolve(attribute.domain, { model: entity.model, kind: "domain" })?.target.object
      : undefined;
    const type =
      domain?.kind === "domain"
        ? (domain.physicalType ?? domain.logicalType)
        : (attribute.logicalType ?? "unknown");
    const classification =
      domain?.kind === "domain" ? summariseClassification(domain.classification) : summariseClassification(attribute.classification);

    return {
      name: attribute.name,
      path: attribute.name,
      type: String(type),
      required: attribute.required,
      isPrimaryKey: primaryKey.has(attribute.name.toLowerCase()),
      isForeignKey: attribute.inherited,
      ...(attribute.description ? { description: attribute.description } : {}),
      depth: 0,
      ...(classification ? { classification } : {}),
    };
  });
}

function tableMembers(table: Table): MemberView[] {
  const primaryKey = new Set(table.primaryKey.map((n) => n.toLowerCase()));
  const foreignKey = new Set(table.foreignKeys.flatMap((fk) => fk.columns.map((c) => c.toLowerCase())));

  const members: MemberView[] = [];
  for (const { column, path, depth } of walkColumns(table.columns)) {
    const classification = summariseClassification(column.classification);
    members.push({
      name: depth === 0 ? column.name : path.split(".").slice(-1)[0]!,
      path,
      type: column.mode === "REPEATED" ? `ARRAY<${column.dataType}>` : column.dataType,
      required: column.mode === "REQUIRED",
      isPrimaryKey: primaryKey.has(path.toLowerCase()),
      isForeignKey: foreignKey.has(path.toLowerCase()),
      ...(column.description ? { description: column.description } : {}),
      depth,
      ...(classification ? { classification } : {}),
    });
  }
  return members;
}

function summariseClassification(
  classification: { sensitivity?: string; categories?: string[] } | undefined,
): string | undefined {
  if (!classification) return undefined;
  if (classification.categories?.length) return classification.categories.join("/");
  return classification.sensitivity;
}

function edgesOf(graph: ObjectGraph, modelName: string, nodes: readonly NodeView[]): EdgeView[] {
  const present = new Set(nodes.map((n) => n.id));
  const edges: EdgeView[] = [];

  for (const entry of graph.inModel(modelName)) {
    if (entry.object.kind !== "relationship") continue;
    const rel = entry.object as Relationship;
    const parent = graph.resolve(rel.parent.ref, { model: modelName })?.target.object;
    const child = graph.resolve(rel.child.ref, { model: modelName })?.target.object;
    if (!parent || !child || !present.has(parent.id) || !present.has(child.id)) continue;

    edges.push({
      id: rel.id,
      name: rel.name,
      sourceId: parent.id,
      targetId: child.id,
      sourceCardinality: rel.parent.cardinality,
      targetCardinality: rel.child.cardinality,
      identifying: rel.identifying,
      origin: "relationship",
      sourceMembers: [...rel.parent.attributes],
      targetMembers: [...rel.child.attributes],
      ...(rel.parent.verbPhrase ? { label: rel.parent.verbPhrase } : {}),
    });
  }

  // Physical models usually carry their structure as foreign keys rather than
  // relationship objects, and a star schema is unreadable without them.
  for (const entry of graph.inModel(modelName)) {
    if (entry.object.kind !== "table") continue;
    const table = entry.object as Table;
    for (const fk of table.foreignKeys) {
      const parent = graph.resolve(fk.references.table, { model: modelName, kind: "table" })?.target.object;
      if (!parent || !present.has(parent.id) || !present.has(table.id)) continue;
      edges.push({
        id: `${table.id}:${fk.name}`,
        name: fk.name,
        sourceId: parent.id,
        targetId: table.id,
        sourceCardinality: "exactly-one",
        targetCardinality: "zero-or-more",
        identifying: false,
        origin: "foreignKey",
        // The foreign key already states its pairs explicitly, in order.
        sourceMembers: [...fk.references.columns],
        targetMembers: [...fk.columns],
      });
    }
  }

  return edges;
}

const NODE_WIDTH = 260;
const COLUMN_GAP = 120;
const ROW_GAP = 60;

/**
 * Position any node the diagram did not place.
 *
 * A deliberately simple layered layout: roots (nothing points at them) on the
 * left, dependents to the right. Good auto-layout is a real project, but a
 * predictable grid beats a pile of overlapping boxes, and saved diagram positions
 * always win over this.
 */
function autoLayout(nodes: NodeView[], edges: readonly EdgeView[]): void {
  const unplaced = nodes.filter((n) => !n.positioned);
  if (unplaced.length === 0) return;

  /**
   * Start below anything the diagram already placed.
   *
   * A saved diagram is a deliberate arrangement, so auto-layout must never land on
   * top of it, which is exactly what happens if we start at the origin and the
   * diagram happens to be there too.
   */
  const placed = nodes.filter((n) => n.positioned);
  const originY = placed.length
    ? Math.max(...placed.map((n) => n.y + estimatedHeight(n))) + ROW_GAP * 2
    : 0;

  const incoming = new Map<string, number>();
  for (const node of nodes) incoming.set(node.id, 0);
  for (const edge of edges) {
    incoming.set(edge.targetId, (incoming.get(edge.targetId) ?? 0) + 1);
  }

  const byDepth = new Map<number, NodeView[]>();
  for (const node of unplaced) {
    const depth = Math.min(incoming.get(node.id) ?? 0, 4);
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(node);
    else byDepth.set(depth, [node]);
  }

  for (const [depth, bucket] of byDepth) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
    let cursorY = originY;
    for (const node of bucket) {
      node.x = depth * (NODE_WIDTH + COLUMN_GAP);
      node.y = cursorY;
      cursorY += estimatedHeight(node) + ROW_GAP;
    }
  }
}

function estimatedHeight(node: NodeView): number {
  return estimatedHeightFor(node.members.length);
}

/** Header plus one row per visible member, matching the node's CSS. */
function estimatedHeightFor(memberCount: number): number {
  const headerHeight = 44;
  const rowHeight = 20;
  return headerHeight + Math.min(memberCount, 14) * rowHeight;
}

/** Diagnostics grouped for the UI's problems panel. */
export function diagnosticsView(diagnostics: readonly Diagnostic[]): {
  items: Diagnostic[];
  counts: { error: number; warning: number; info: number };
} {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return { items: [...diagnostics], counts };
}

/** Resolve an object plus a little context, for the detail panel. */
export function objectDetail(
  workspace: LoadedWorkspace,
  id: string,
): { object: AnyObject; file?: string; usedBy: { id: string; kind: string; name: string }[] } | undefined {
  const entry = workspace.graph.get(id);
  if (!entry) return undefined;

  // Cheap reverse-dependency scan: which objects mention this one by name.
  const target = entry.object;
  const usedBy: { id: string; kind: string; name: string }[] = [];
  for (const candidate of workspace.graph.all()) {
    if (candidate.object.id === id) continue;
    const serialized = JSON.stringify(candidate.object);
    if (serialized.includes(`"${target.name}"`) || serialized.includes(`:${target.name}"`)) {
      usedBy.push({ id: candidate.object.id, kind: candidate.object.kind, name: candidate.object.name });
    }
  }

  return {
    object: target,
    ...(entry.file ? { file: entry.file } : {}),
    usedBy: usedBy.slice(0, 25),
  };
}

/** Kept for callers that need a single column by dotted path. */
export { findColumn };
