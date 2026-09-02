import { z } from "zod";
import { BaseObjectSchema, RefSchema } from "./common.js";

/**
 * Diagram layout.
 *
 * Layout lives in its own files, never alongside semantic objects. Dragging a box two
 * pixels left must not produce a diff that looks like a model change, because
 * reviewers stop reading diffs that cry wolf. The storage layer enforces the
 * separation by writing diagrams to a distinct path template.
 *
 * Everything in here, shapes, connectors, colours, bold text, is presentation. None
 * of it changes what the model *means*, which is why it can be as free-form as a
 * drawing tool without endangering the governed artifact.
 */

export const NOTATIONS = ["crowsFoot", "idef1x", "uml", "barker"] as const;
export const NotationSchema = z.enum(NOTATIONS);
export type Notation = z.infer<typeof NotationSchema>;

export const DiagramNodeSchema = z.object({
  /** The object this box represents. */
  ref: RefSchema,
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  /** Collapsed boxes show the name only, hiding attributes. */
  collapsed: z.boolean().optional(),
  /** Show only these members, in this order. Empty means show all. */
  visibleMembers: z.array(z.string()).default([]),
  color: z.string().optional(),
});
export type DiagramNode = z.infer<typeof DiagramNodeSchema>;

export const DiagramEdgeSchema = z.object({
  ref: RefSchema,
  /** Manual routing points; empty means auto-route. */
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).default([]),
  labelOffset: z.object({ x: z.number(), y: z.number() }).optional(),
  hidden: z.boolean().optional(),
});
export type DiagramEdge = z.infer<typeof DiagramEdgeSchema>;

/**
 * Text and box formatting.
 *
 * A conceptual model is a document people argue over in a room, and the argument is
 * carried as much by emphasis and grouping as by the boxes. Denying bold text and
 * colour pushes people back into PowerPoint, and then the diagram that gets shown to
 * the business is not the one under version control.
 */
export const FormatSchema = z.object({
  fill: z.string().optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().positive().optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),

  textColor: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),

  cornerRadius: z.number().nonnegative().optional(),
  opacity: z.number().min(0).max(1).optional(),
});
export type Format = z.infer<typeof FormatSchema>;

/** Shapes available for free-form drawing, as in a diagramming tool. */
export const SHAPE_KINDS = [
  "note",
  "text",
  "rectangle",
  "roundedRectangle",
  "ellipse",
  "diamond",
  "cylinder",
  "process",
  "parallelogram",
  "hexagon",
  /**
   * A table sketch: a title bar over a list of rows, typed as free text.
   *
   * Deliberately *not* a real table object. Sketching a structure on the canvas before
   * committing to it is a normal part of modelling, and forcing every box to be a
   * governed object with validated columns makes the tool useless for thinking. This
   * draws like a table and carries no meaning, the first line is the title, the rest
   * are rows.
   */
  "table",
  "legend",
] as const;
export const ShapeKindSchema = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof ShapeKindSchema>;

/**
 * A free-standing shape on the canvas.
 *
 * These carry no meaning to the validator, the DDL generator or the CI gate. That is
 * deliberate: it lets a modeller sketch a boundary, a swimlane or an annotation
 * without inventing metamodel concepts nobody asked for.
 */
export const DiagramShapeSchema = z.object({
  id: z.string().min(1),
  shape: ShapeKindSchema.default("rectangle"),
  text: z.string().default(""),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().default(180),
  height: z.number().positive().default(90),
  rotation: z.number().optional(),
  /** Stacking order. Negative values sit behind entity boxes. */
  z: z.number().optional(),
  format: FormatSchema.default({}),
  /** Optional link to a model object, so a shape can stand for something real. */
  ref: RefSchema.optional(),
});
export type DiagramShape = z.infer<typeof DiagramShapeSchema>;

export const ARROW_HEADS = ["none", "arrow", "openArrow", "circle", "diamond"] as const;

/** One end of a free-drawn connector: a shape, a model object, or a fixed point. */
export const ConnectorEndSchema = z.object({
  /** Id of a shape on this diagram. */
  shape: z.string().optional(),
  /** Reference to a model object drawn on this diagram. */
  ref: RefSchema.optional(),
  /** Absolute position, when the end is not attached to anything. */
  x: z.number().optional(),
  y: z.number().optional(),
  /** Preferred side to leave from or arrive at. */
  side: z.enum(["left", "right", "top", "bottom", "auto"]).default("auto"),
});
export type ConnectorEnd = z.infer<typeof ConnectorEndSchema>;

/**
 * A hand-drawn connector.
 *
 * Distinct from a relationship edge: relationships are *semantic* and generate foreign
 * keys and assertions, whereas these are lines someone drew to explain something. They
 * are kept apart so that a decorative arrow can never be mistaken for a declared
 * relationship by anything downstream.
 */
export const DiagramConnectorSchema = z.object({
  id: z.string().min(1),
  from: ConnectorEndSchema,
  to: ConnectorEndSchema,
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).default([]),
  label: z.string().optional(),
  lineStyle: z.enum(["straight", "orthogonal", "curved"]).default("curved"),
  arrowStart: z.enum(ARROW_HEADS).default("none"),
  arrowEnd: z.enum(ARROW_HEADS).default("arrow"),
  format: FormatSchema.default({}),
});
export type DiagramConnector = z.infer<typeof DiagramConnectorSchema>;

export const DiagramGroupSchema = z.object({
  name: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  color: z.string().optional(),
  /** Subject area this group visualises, when it mirrors one. */
  subjectArea: RefSchema.optional(),
});
export type DiagramGroup = z.infer<typeof DiagramGroupSchema>;

/**
 * Legacy note shape, kept so diagrams written before shapes existed still load.
 *
 * `style` was an enum of note/label/legend; it now maps onto `shape`.
 */
const LegacyAnnotationSchema = z.object({
  id: z.string().min(1),
  text: z.string().default(""),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().default(220),
  height: z.number().positive().default(90),
  style: z.enum(["note", "label", "legend"]).default("note"),
  color: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
});

/**
 * A diagram is a *view* over a model, not the model itself. One model can have many
 * diagrams showing different subsets, which is how large models stay comprehensible.
 */
export const DiagramSchema = BaseObjectSchema.extend({
  kind: z.literal("diagram"),
  /** The model this diagram views. */
  model: RefSchema,
  notation: NotationSchema.default("crowsFoot"),

  nodes: z.array(DiagramNodeSchema).default([]),
  edges: z.array(DiagramEdgeSchema).default([]),
  groups: z.array(DiagramGroupSchema).default([]),

  /** Free-form shapes and text. */
  shapes: z.array(DiagramShapeSchema).default([]),
  /** Hand-drawn connectors between shapes and boxes. */
  connectors: z.array(DiagramConnectorSchema).default([]),

  /** Legacy notes. Migrated into `shapes` on load; see `migrateDiagram`. */
  annotations: z.array(LegacyAnnotationSchema).default([]),

  viewport: z
    .object({
      x: z.number().default(0),
      y: z.number().default(0),
      zoom: z.number().positive().default(1),
    })
    .optional(),

  /**
   * When set, the diagram automatically includes every object in these subject areas,
   * so new objects appear without anyone editing the diagram file.
   */
  autoIncludeSubjectAreas: z.array(RefSchema).default([]),

  /** Detail level for rendering. */
  displayLevel: z
    .enum(["entityOnly", "keysOnly", "attributes", "attributesWithTypes"])
    .default("attributes"),

  /** Snap positions to this grid when moving. Zero disables snapping. */
  gridSize: z.number().nonnegative().default(0),
});
export type Diagram = z.infer<typeof DiagramSchema>;

/**
 * Fold legacy `annotations` into `shapes`.
 *
 * Run on load so the rest of the system only ever deals with shapes. Writing back
 * leaves `annotations` empty, which the serializer then omits, so a diagram
 * self-migrates the first time it is saved, with no explicit migration step.
 */
export function migrateDiagram(diagram: Diagram): Diagram {
  if (diagram.annotations.length === 0) return diagram;

  const migrated: DiagramShape[] = diagram.annotations.map((annotation) => ({
    id: annotation.id,
    shape: annotation.style === "label" ? "text" : annotation.style,
    text: annotation.text,
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height,
    format: {
      ...(annotation.color ? { fill: annotation.color } : {}),
      ...(annotation.fontSize ? { fontSize: annotation.fontSize } : {}),
      ...(annotation.bold ? { bold: annotation.bold } : {}),
    },
  }));

  const existing = new Set(diagram.shapes.map((shape) => shape.id));
  return {
    ...diagram,
    shapes: [...diagram.shapes, ...migrated.filter((shape) => !existing.has(shape.id))],
    annotations: [],
  };
}

/** Default look per shape kind, applied when the user has not overridden it. */
export const SHAPE_DEFAULTS: Record<ShapeKind, { width: number; height: number; format: Format }> = {
  note: { width: 220, height: 90, format: { fill: "#fffbeb", stroke: "#e0cf8a", textColor: "#7a6320", align: "left" } },
  text: { width: 180, height: 40, format: { fill: "none", stroke: "none", align: "left" } },
  rectangle: { width: 180, height: 90, format: { align: "center", verticalAlign: "middle" } },
  roundedRectangle: { width: 180, height: 90, format: { cornerRadius: 12, align: "center", verticalAlign: "middle" } },
  ellipse: { width: 160, height: 100, format: { align: "center", verticalAlign: "middle" } },
  diamond: { width: 160, height: 110, format: { align: "center", verticalAlign: "middle" } },
  cylinder: { width: 150, height: 110, format: { align: "center", verticalAlign: "middle" } },
  process: { width: 180, height: 90, format: { align: "center", verticalAlign: "middle" } },
  parallelogram: { width: 190, height: 90, format: { align: "center", verticalAlign: "middle" } },
  hexagon: { width: 180, height: 96, format: { align: "center", verticalAlign: "middle" } },
  // Left-aligned and top-anchored, because it is read as a list rather than a label.
  table: { width: 200, height: 130, format: { align: "left", verticalAlign: "top" } },
  legend: { width: 220, height: 140, format: { align: "left", verticalAlign: "top" } },
};
