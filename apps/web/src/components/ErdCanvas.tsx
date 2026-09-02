import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getNodesBounds,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api";
import { publishCanvasStatus, resetCanvasStatus } from "../app/canvasStatus";
import { CanvasContext, type CanvasContextValue, type EdgeAction } from "./canvasContext";
import {
  EntityNode,
  visibleMemberPaths,
  type DisplayLevel,
  type EntityNodeData,
  type MemberEdit,
} from "./EntityNode";
import { edgeStyleFor, type Notation } from "./notation";
import { ModelEdge, type ModelEdgeData } from "./ModelEdge";
import { ShapeNode, type ShapeNodeData } from "./ShapeNode";
import type { Tool } from "./ShapePalette";
import type { DiagramConnector, DiagramShape, Format, GraphView, Lock, ShapeKind } from "../types";

const nodeTypes = { entity: EntityNode, shape: ShapeNode };
const edgeTypes = { model: ModelEdge };

/**
 * Which sides of two boxes face each other.
 *
 * With a connection point on all four sides, an edge has to say which one it leaves from
 * and which it arrives at, or React Flow falls back to the first handle and every line in
 * the diagram sprouts from the same corner regardless of where the boxes are.
 *
 * The rule is the obvious one: whichever axis the two boxes are further apart on wins, and
 * the sides that face each other along it are the ones used. It is what erwin does and it
 * is the difference between lines that look routed and lines that look thrown.
 *
 * Recomputed from saved geometry, so a line settles onto its new sides when a box is
 * dropped rather than following it live, which is the right trade: re-routing mid-drag
 * makes the whole diagram twitch while you are trying to place one box.
 */
function facingSides(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): { source: string; target: string } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: "r", target: "l" } : { source: "l", target: "r" };
  }
  return dy >= 0 ? { source: "b", target: "t" } : { source: "t", target: "b" };
}

/** Plain-language cardinality, for tooltips and the edge toolbar. */
const CARDINALITY_TEXT: Record<string, string> = {
  "zero-or-one": "zero or one",
  "exactly-one": "exactly one",
  "zero-or-more": "zero or more",
  "one-or-more": "one or more",
};

/**
 * Every marker any notation can ask for, defined once.
 *
 * All four notations' glyphs live in one `<defs>` rather than being swapped per notation.
 * Markers are referenced by `url(#id)` from a stylesheet-free attribute, so they must
 * exist in the document at the moment an edge renders, mounting and unmounting sets of
 * them as the notation changes would leave edges pointing at ids that had just been
 * removed, and SVG's response to a missing marker is to silently draw nothing.
 *
 * `markerUnits="userSpaceOnUse"` keeps a glyph a constant size rather than scaling with
 * stroke width, and `orient="auto-start-reverse"` makes a marker at the start end point
 * back down the line instead of forwards.
 */
function NotationDefs(): JSX.Element {
  const stroke = { stroke: "currentColor", strokeWidth: 1.4, fill: "none" };
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden>
      <defs>
        {/* ---------------- crow's foot (Information Engineering) ---------------- */}

        {/* Exactly one: a single crossbar. */}
        <marker id="cf-one" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M12 4 V16" {...stroke} />
        </marker>

        {/* Zero or one: circle plus crossbar. */}
        <marker id="cf-zero-one" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <circle cx="5.5" cy="10" r="3.2" {...stroke} fill="var(--bg-surface)" />
          <path d="M12 4 V16" {...stroke} />
        </marker>

        {/* Zero or more: circle plus crow's foot. */}
        <marker id="cf-zero-many" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <circle cx="5.5" cy="10" r="3.2" {...stroke} fill="var(--bg-surface)" />
          <path d="M10 10 L18 3 M10 10 H18 M10 10 L18 17" {...stroke} />
        </marker>

        {/* One or more: crossbar plus crow's foot. */}
        <marker id="cf-one-many" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M7 4 V16" {...stroke} />
          <path d="M10 10 L18 3 M10 10 H18 M10 10 L18 17" {...stroke} />
        </marker>

        {/* Bare crow's foot, no optionality bar, Barker carries that in the line itself. */}
        <marker id="cf-many-plain" viewBox="0 0 20 20" refX="18" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M10 10 L18 3 M10 10 H18 M10 10 L18 17" {...stroke} />
        </marker>

        {/* ---------------- IDEF1X ---------------- */}

        {/*
          The child end: a filled circle, always.
          IDEF1X does not vary this glyph by cardinality, the count is a letter written
          beside it, so one marker serves every relationship in the notation.
        */}
        <marker id="idef-child" viewBox="0 0 20 20" refX="16" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <circle cx="11" cy="10" r="4" fill="currentColor" />
        </marker>

        {/*
          An optional parent on a non-identifying relationship: a hollow diamond.
          This is IDEF1X's statement that the migrated foreign key is nullable.
        */}
        <marker id="idef-optional-parent" viewBox="0 0 20 20" refX="2" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M2 10 L8 5.5 L14 10 L8 14.5 z" {...stroke} fill="var(--bg-surface)" />
        </marker>

        {/* ---------------- UML ---------------- */}

        {/*
          Composition, for an identifying relationship: a filled diamond at the parent.
          "The child cannot exist independently of the parent" is what composition means,
          which makes it the honest translation of identifying into UML's vocabulary.
        */}
        <marker id="uml-composition" viewBox="0 0 20 20" refX="2" refY="10" markerWidth="20" markerHeight="20"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M2 10 L8 5.5 L14 10 L8 14.5 z" fill="currentColor" />
        </marker>

        {/* ---------------- shared ---------------- */}

        {/* Plain arrow, for hand-drawn connectors. Not part of any notation. */}
        <marker id="cf-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12"
          markerUnits="userSpaceOnUse" orient="auto-start-reverse">
          <path d="M1 1 L10 6 L1 11 z" fill="currentColor" />
        </marker>
      </defs>
    </svg>
  );
}

/** Defaults per shape, mirroring SHAPE_DEFAULTS on the server. */
const SHAPE_SIZES: Record<string, { width: number; height: number; format: Format }> = {
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
  legend: { width: 220, height: 140, format: { align: "left", verticalAlign: "top" } },
};

const SAVE_DEBOUNCE_MS = 700;

export interface CanvasHandle {
  fitView: () => void;
  /**
   * Zoom, driven from outside.
   *
   * The zoom control now lives in the status bar, which is rendered by the shell and is
   * nowhere near this component's tree. React Flow's zoom functions only exist inside
   * its provider, so they are exposed here rather than lifted, the alternative is a
   * second `ReactFlowProvider` around the status bar, which would be a second canvas.
   */
  zoomIn: () => void;
  zoomOut: () => void;
  addShape: (kind: ShapeKind) => void;
  alignSelection: (axis: AlignAxis) => void;
  distributeSelection: (axis: "horizontal" | "vertical") => void;
  duplicateSelection: () => void;
  deleteSelectedShapes: () => void;
}

/** Whether the diagram's position writes are in flight, settled, or failed. */
export type SaveState = "idle" | "saving" | "saved" | "error";

export type AlignAxis = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

export interface SelectionInfo {
  /** Screen position of the selection's top-centre. */
  x: number;
  y: number;
  shapeIds: string[];
  format: Format;
  count: number;
}

interface Props {
  graph: GraphView;
  displayLevel: DisplayLevel;
  /**
   * The notation to draw in.
   *
   * A prop rather than read from `graph.diagram`, so switching notation repaints
   * immediately instead of waiting for a write and a refetch. The page owns the state and
   * persists it; the canvas only draws what it is told.
   */
  notation: Notation;
  selectedId: string | undefined;
  canEdit: boolean;
  tool: Tool;
  snapToGrid: boolean;
  onToolUsed: () => void;
  onSelect: (id: string | undefined) => void;
  onChanged: () => void;
  onMemberEdit: (objectId: string, edit: MemberEdit) => void;
  onMemberAdd: (objectId: string) => void;
  onRename: (objectId: string, name: string) => void;
  onContextMenu: (event: React.MouseEvent, objectId: string, memberIndex?: number) => void;
  onCanvasContextMenu: (event: React.MouseEvent) => void;
  onSelectionAnchor: (anchor: { x: number; y: number } | undefined) => void;
  onShapeSelection: (info: SelectionInfo | undefined) => void;
  /** A drag between two model objects: offer to create a real relationship. */
  onRelate: (parentId: string, childId: string) => void;
  /** An action on a semantic edge, which changes the model rather than the drawing. */
  onEdgeCommand: (action: EdgeAction, edge: ModelEdgeData) => void;
  /** Advisory locks held across the instance, so a box can show who else is in it. */
  locks: Lock[];
  /** This tab's stream id, used to tell our own locks from everyone else's. */
  connectionId: string | undefined;
}

export const ErdCanvas = forwardRef<CanvasHandle, Props>(function ErdCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} forwardedRef={ref} />
    </ReactFlowProvider>
  );
});

function Canvas({
  graph,
  displayLevel,
  notation,
  selectedId,
  canEdit,
  tool,
  snapToGrid,
  onToolUsed,
  onSelect,
  onChanged,
  onMemberEdit,
  onMemberAdd,
  onRename,
  onContextMenu,
  onCanvasContextMenu,
  onSelectionAnchor,
  onShapeSelection,
  onRelate,
  onEdgeCommand,
  locks,
  connectionId,
  forwardedRef,
}: Props & { forwardedRef: React.ForwardedRef<CanvasHandle> }): JSX.Element {
  const {
    screenToFlowPosition,
    flowToScreenPosition,
    fitView,
    setViewport,
    zoomIn,
    zoomOut,
  } = useReactFlow();
  const viewport = useViewport();

  /**
   * The armed shape tool, mirrored where it can be read and cleared without a render.
   *
   * The `tool` prop is the source of truth for what the palette shows; this is what the
   * canvas actually consults when placing, so that placing once cannot place twice.
   */
  const armed = useRef<Tool>(tool);
  useEffect(() => {
    armed.current = tool;
  }, [tool]);

  const [shapes, setShapes] = useState<DiagramShape[]>(graph.shapes);
  const [connectors, setConnectors] = useState<DiagramConnector[]>(graph.connectors);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef(new Map<string, { x: number; y: number; width?: number; height?: number }>());
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => setShapes(graph.shapes), [graph.shapes]);
  useEffect(() => setConnectors(graph.connectors), [graph.connectors]);

  const persist = useCallback(
    async (patch: { shapes?: DiagramShape[]; connectors?: DiagramConnector[] }) => {
      setSaveState("saving");
      try {
        await api.saveLayout(graph.model.name, patch);
        setSaveState("saved");
        onChanged();
      } catch {
        setSaveState("error");
      }
    },
    [graph.model.name, onChanged],
  );

  const writeShapes = useCallback(
    (next: DiagramShape[]) => {
      setShapes(next);
      void persist({ shapes: next });
    },
    [persist],
  );

  const writeConnectors = useCallback(
    (next: DiagramConnector[]) => {
      setConnectors(next);
      void persist({ connectors: next });
    },
    [persist],
  );

  /** Positions are debounced, a drag emits a change every frame. */
  const flushPositions = useCallback(async () => {
    const positions = [...pending.current.entries()].map(([objectId, point]) => ({ objectId, ...point }));
    pending.current.clear();
    if (positions.length === 0) return;

    setSaveState("saving");
    try {
      await api.saveLayout(graph.model.name, { positions });
      setSaveState("saved");
      onChanged();
    } catch {
      setSaveState("error");
    }
  }, [graph.model.name, onChanged]);

  const scheduleFlush = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushPositions(), SAVE_DEBOUNCE_MS);
  }, [flushPositions]);

  const addShapeAt = useCallback(
    (kind: ShapeKind, x: number, y: number) => {
      const defaults = SHAPE_SIZES[kind] ?? SHAPE_SIZES.rectangle!;
      writeShapes([
        ...shapes,
        {
          id: `shp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          shape: kind,
          text: "",
          x: Math.round(x - defaults.width / 2),
          y: Math.round(y - defaults.height / 2),
          width: defaults.width,
          height: defaults.height,
          format: { ...defaults.format },
        },
      ]);
      // Consume the armed tool *synchronously*. `onToolUsed` sets state in the parent,
      // which does not take effect until the next render, and a drop is followed by a
      // pane click within the same gesture, which would still read the stale value and
      // place a second shape. That is the duplicate.
      armed.current = "select";
      onToolUsed();
    },
    [onToolUsed, shapes, writeShapes],
  );

  // ---------------------------------------------------------------- nodes

  /**
   * Node arrays depend on the model and the shapes, nothing else.
   *
   * React Flow keys its measurements off this array, so rebuilding it on every
   * selection change would discard them, and without measurements it will not route a
   * single edge. Display state goes through context instead.
   */
  const entityNodes = useMemo<Node<EntityNodeData>[]>(
    () =>
      graph.nodes.map((view) => ({
        id: view.id,
        type: "entity",
        position: { x: view.x, y: view.y },
        // Seed the dimensions so edges route on the first frame rather than waiting for
        // a ResizeObserver that never fires in a background tab.
        initialWidth: view.width,
        initialHeight: view.height,
        measured: { width: view.width, height: view.height },
        // A fixed size only once the user has chosen one. Until then the box sizes to
        // its content, so adding a column still grows it.
        ...(view.userSized ? { width: view.width, height: view.height } : {}),
        data: { view },
      })),
    [graph.nodes],
  );

  const shapeNodes = useMemo<Node<ShapeNodeData>[]>(
    () =>
      shapes.map((shape) => ({
        id: `shape:${shape.id}`,
        type: "shape",
        position: { x: shape.x, y: shape.y },
        // `width`/`height` rather than `initialWidth`: the resizer writes to these, and
        // the node fills its wrapper, so dragging a handle resizes the shape live.
        width: shape.width,
        height: shape.height,
        measured: { width: shape.width, height: shape.height },
        // Shapes sit behind entity boxes unless explicitly raised, so a background
        // rectangle never swallows a click meant for a table.
        zIndex: shape.z ?? -1,
        data: { shape },
      })),
    [shapes],
  );

  /**
   * Which member rows each box is currently drawing.
   *
   * Recomputed when the detail level changes, which is exactly when an edge may have to
   * stop anchoring to a column and fall back to the box edge.
   */
  const drawnMembers = useMemo(
    () =>
      new Map(
        graph.nodes.map((view) => [view.id, visibleMemberPaths(view.members, displayLevel)]),
      ),
    [graph.nodes, displayLevel],
  );

  /**
   * Anchor an edge end to a column row when that row is on screen.
   *
   * Falls back to the facing box edge in three cases, all of them normal rather than
   * exceptional: a conceptual model carries no attributes at all, a collapsed or
   * keys-only box is not drawing the row, and a composite key has several pairs of which
   * only the first is used to place the line. The last is a deliberate simplification, * drawing one line per column pair would put three parallel lines between the same two
   * boxes for a three-part key, which is noise rather than information.
   *
   * The member is matched case-insensitively because the relationship stores the name a
   * human typed and the column stores the name the table declares, and warehouses are not
   * consistent about case.
   */
  const anchorFor = useCallback(
    (nodeId: string, memberName: string | undefined, direction: "in" | "out"): string | undefined => {
      if (!memberName) return undefined;
      const drawn = drawnMembers.get(nodeId);
      const members = graph.nodes.find((view) => view.id === nodeId)?.members;
      if (!drawn || !members) return undefined;

      const match = members.find(
        (member) => member.name.toLowerCase() === memberName.toLowerCase(),
      );
      if (!match || !drawn.has(match.path)) return undefined;
      return `${direction}:${match.path}`;
    },
    [drawnMembers, graph.nodes],
  );

  /** Box geometry by id, so an edge can work out which sides face each other. */
  const nodeBoxes = useMemo(
    () =>
      new Map(
        graph.nodes.map((view) => [
          view.id,
          { x: view.x, y: view.y, width: view.width, height: view.height },
        ]),
      ),
    [graph.nodes],
  );

  const relationshipEdges = useMemo<Edge<ModelEdgeData>[]>(
    () =>
      graph.edges.map((edge) => {
        // Everything notation-specific comes from one place, so adding a notation never
        // means hunting through the canvas for the places that assumed crow's foot.
        const glyphs = edgeStyleFor(notation, edge);
        const colour =
          edge.origin === "foreignKey" ? "var(--tier-physical)" : "var(--tier-logical)";

        const from = nodeBoxes.get(edge.sourceId);
        const to = nodeBoxes.get(edge.targetId);
        const sides = from && to ? facingSides(from, to) : undefined;

        // Prefer the column row; fall back to the facing box edge when it is not drawn.
        const sourceHandle =
          anchorFor(edge.sourceId, edge.sourceMembers[0], "out") ?? sides?.source;
        const targetHandle =
          anchorFor(edge.targetId, edge.targetMembers[0], "in") ?? sides?.target;

        return {
          id: edge.id,
          type: "model",
          source: edge.sourceId,
          target: edge.targetId,
          ...(sourceHandle ? { sourceHandle } : {}),
          ...(targetHandle ? { targetHandle } : {}),
          /**
           * The bare marker id, **not** `url(#id)`.
           *
           * React Flow wraps a string marker itself, so passing `url(#cf-one)` produced
           * the attribute `url('#url(#cf-one)')`, a reference to an element id that
           * cannot exist. SVG's response to a missing marker is to draw nothing and say
           * nothing, so every cardinality glyph in this app has silently not rendered
           * since the markers were written: the `<defs>` were all present and correct and
           * no edge could reach them.
           */
          ...(glyphs.markerStart ? { markerStart: glyphs.markerStart } : {}),
          ...(glyphs.markerEnd ? { markerEnd: glyphs.markerEnd } : {}),
          style: {
            stroke: colour,
            // Barker draws its own two half-paths, so the base line must not also be
            // dashed, the pattern would fight the halves.
            ...(glyphs.dash && !glyphs.splitLine ? { strokeDasharray: glyphs.dash } : {}),
            strokeWidth: 1.5,
            // Markers inherit `currentColor`, so this tints the glyphs to match the line.
            color: colour,
          },
          data: {
            kind: edge.origin === "foreignKey" ? "foreignKey" : "relationship",
            // A foreign key belongs to the child table, so that is what an edit targets.
            ownerId: edge.origin === "foreignKey" ? edge.targetId : edge.id,
            ...(edge.origin === "foreignKey" ? { foreignKeyName: edge.name } : {}),
            // Only the verb phrase is drawn as the mid-line label. Cardinality goes at the
            // ends, where the notation puts it.
            ...(edge.label ? { label: edge.label } : {}),
            cardinalityText: CARDINALITY_TEXT[edge.targetCardinality] ?? "",
            ...(glyphs.startLabel ? { startLabel: glyphs.startLabel } : {}),
            ...(glyphs.endLabel ? { endLabel: glyphs.endLabel } : {}),
            ...(glyphs.splitLine ? { splitLine: glyphs.splitLine } : {}),
          },
        };
      }),
    /**
     * `anchorFor` belongs here, and leaving it out was a real bug.
     *
     * It closes over the detail level through `drawnMembers`, so without it this memo kept
     * handing React Flow the column handles it had computed at `Fields` even after the
     * user switched to `Names`, where those rows, and therefore those handles, no longer
     * exist. React Flow cannot resolve a handle that is not mounted, so it dropped every
     * edge and the diagram lost all its relationships on a detail-level change.
     */
    [graph.edges, nodeBoxes, notation, anchorFor],
  );

  /** Hand-drawn connectors, kept visually distinct from semantic relationships. */
  const connectorEdges = useMemo<Edge<ModelEdgeData>[]>(
    () =>
      connectors.map((connector) => ({
        id: `conn:${connector.id}`,
        type: "model",
        source: endToNodeId(connector.from) ?? "",
        target: endToNodeId(connector.to) ?? "",
        // Bare id, for the same reason as the relationship markers above.
        markerEnd: connector.arrowEnd === "none" ? undefined : "cf-arrow",
        style: {
          stroke: connector.format.stroke ?? "var(--n6)",
          strokeWidth: connector.format.strokeWidth ?? 1.5,
          strokeDasharray:
            connector.format.strokeStyle === "dashed"
              ? "6 4"
              : connector.format.strokeStyle === "dotted"
                ? "2 3"
                : undefined,
        },
        data: {
          kind: "connector",
          connectorId: connector.id,
          ...(connector.label ? { label: connector.label } : {}),
          dashed: connector.format.strokeStyle === "dashed",
          arrowEnd: connector.arrowEnd !== "none",
        },
      })),
    [connectors],
  );

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node>([...entityNodes, ...shapeNodes]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([...relationshipEdges, ...connectorEdges]);


  /**
   * Rebuild the node array, carrying selection across.
   *
   * Every save refetches the model, which produces a fresh node array, and a fresh
   * array has nothing selected. That is why the format toolbar vanished the moment you
   * changed a colour: applying the format saved, the save refreshed, the refresh
   * dropped the selection, and the toolbar had nothing to attach to.
   */
  useEffect(() => {
    setNodes((current) => {
      const selectedIds = new Set(current.filter((node) => node.selected).map((node) => node.id));
      if (selectedIds.size === 0) return [...entityNodes, ...shapeNodes];
      return [...entityNodes, ...shapeNodes].map((node) =>
        selectedIds.has(node.id) ? { ...node, selected: true } : node,
      );
    });
  }, [entityNodes, shapeNodes, setNodes]);

  useEffect(() => {
    setEdges([...relationshipEdges, ...connectorEdges]);
  }, [relationshipEdges, connectorEdges, setEdges]);

  // ---------------------------------------------------------------- selection

  const selectedShapeNodes = useMemo(
    () => nodes.filter((node) => node.selected && node.type === "shape"),
    [nodes],
  );

  /**
   * Window coordinates into the coordinate space the floating toolbars are positioned in.
   *
   * `flowToScreenPosition` returns *viewport* coordinates, measured from the top-left of
   * the window. The toolbars are `position: absolute`, so the numbers they receive are read
   * as offsets inside their containing block, which is the canvas wrapper. Those two spaces
   * only coincide when the wrapper sits at the window origin, and it never does: there is a
   * sidebar to its left and a page header above it. Handing one to the other put the
   * toolbar exactly the wrapper's page offset too far right and too far down, far enough,
   * once the docked panels narrowed the canvas, to land on top of the properties panel.
   *
   * Derived from the live geometry rather than from any constant, so it stays correct when
   * a panel is resized, the sidebar collapses, or the toolbar row above the canvas changes
   * height. `offsetLeft`/`offsetTop` supply the canvas's own position inside the wrapper,
   * which is what the second term accounts for.
   */
  const toLocal = useCallback(
    (point: { x: number; y: number }): { x: number; y: number } => {
      const host = wrapperRef.current;
      if (!host) return point;

      const rect = host.getBoundingClientRect();
      const x = point.x - rect.left + host.offsetLeft;
      const y = point.y - rect.top + host.offsetTop;

      /*
        Clamped to the canvas, with room for the toolbar's own half-width.

        The toolbar is centred on the anchor via `translate(-50%, -100%)`, so an anchor near
        an edge would hang the toolbar over whatever is beyond it. Panning a selected box
        off the side of the canvas is the ordinary way to hit this, and a control floating
        over the explorer belongs to neither surface.

        140 is half the widest toolbar, `Rename · Column · YAML · delete` measures about
        260px. An earlier 90 was measured against nothing in particular and still let the
        toolbar overhang the properties panel by 40px, which is the exact bug this clamp
        exists to prevent.
      */
      const margin = 140;
      return {
        x: Math.min(Math.max(x, host.offsetLeft + margin), host.offsetLeft + rect.width - margin),
        y: Math.min(Math.max(y, host.offsetTop + 44), host.offsetTop + rect.height),
      };
    },
    [],
  );

  // Keep the floating toolbars glued to the selection through pan and zoom.
  useEffect(() => {
    const node = selectedId ? nodes.find((candidate) => candidate.id === selectedId) : undefined;
    if (!node || node.type !== "entity") {
      onSelectionAnchor(undefined);
    } else {
      const width = (node.measured?.width ?? node.initialWidth ?? 232) as number;
      onSelectionAnchor(
        toLocal(flowToScreenPosition({ x: node.position.x + width / 2, y: node.position.y })),
      );
    }
  }, [selectedId, nodes, viewport, flowToScreenPosition, toLocal, onSelectionAnchor]);

  useEffect(() => {
    if (selectedShapeNodes.length === 0) {
      onShapeSelection(undefined);
      return;
    }
    const ids = selectedShapeNodes.map((node) => node.id.slice("shape:".length));
    const boxes = selectedShapeNodes.map((node) => ({
      x: node.position.x,
      y: node.position.y,
      w: (node.measured?.width ?? 180) as number,
    }));
    const left = Math.min(...boxes.map((box) => box.x));
    const right = Math.max(...boxes.map((box) => box.x + box.w));
    const top = Math.min(...boxes.map((box) => box.y));
    // Same coordinate-space conversion as the selection toolbar; see `toLocal`.
    const point = toLocal(flowToScreenPosition({ x: (left + right) / 2, y: top }));

    const first = shapes.find((shape) => shape.id === ids[0]);
    onShapeSelection({ ...point, shapeIds: ids, format: first?.format ?? {}, count: ids.length });
  }, [selectedShapeNodes, shapes, viewport, flowToScreenPosition, toLocal, onShapeSelection]);

  // ---------------------------------------------------------------- changes

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      onNodesChangeBase(changes);
      if (!canEdit) return;

      let nextShapes: DiagramShape[] | undefined;

      for (const change of changes) {
        // A resize arrives as a `dimensions` change with `resizing: false` on release.
        if (change.type === "dimensions" && change.resizing === false && change.dimensions) {
          const size = {
            width: Math.round(change.dimensions.width),
            height: Math.round(change.dimensions.height),
          };
          if (change.id.startsWith("shape:")) {
            const id = change.id.slice("shape:".length);
            nextShapes = (nextShapes ?? shapes).map((shape) =>
              shape.id === id ? { ...shape, ...size } : shape,
            );
          } else {
            const current = nodes.find((node) => node.id === change.id);
            pending.current.set(change.id, {
              x: Math.round(current?.position.x ?? 0),
              y: Math.round(current?.position.y ?? 0),
              ...size,
            });
            scheduleFlush();
          }
          continue;
        }

        if (change.type !== "position" || !change.position || change.dragging !== false) continue;

        const snapped = snapToGrid
          ? { x: Math.round(change.position.x / 20) * 20, y: Math.round(change.position.y / 20) * 20 }
          : { x: Math.round(change.position.x), y: Math.round(change.position.y) };

        if (change.id.startsWith("shape:")) {
          const id = change.id.slice("shape:".length);
          nextShapes = (nextShapes ?? shapes).map((shape) =>
            shape.id === id ? { ...shape, ...snapped } : shape,
          );
        } else {
          pending.current.set(change.id, snapped);
          scheduleFlush();
        }
      }

      if (nextShapes) writeShapes(nextShapes);
    },
    [canEdit, nodes, onNodesChangeBase, scheduleFlush, shapes, snapToGrid, writeShapes],
  );

  /**
   * Act on a selected edge.
   *
   * Deliberately different per kind. Deleting a connector erases a drawing; deleting a
   * relationship drops a foreign key from a table and the assertion that checked it, so
   * that goes through the API and lands in the diff for review.
   */
  const handleEdgeAction = useCallback(
    (action: EdgeAction) => {
      const edge = edges.find((candidate) => candidate.id === action.edgeId);
      const data = edge?.data as ModelEdgeData | undefined;
      if (!data) return;

      if (data.kind === "connector" && data.connectorId) {
        const id = data.connectorId;
        switch (action.type) {
          case "label":
            writeConnectors(
              connectors.map((c) => (c.id === id ? { ...c, label: action.value || undefined } : c)),
            );
            return;
          case "delete":
            writeConnectors(connectors.filter((c) => c.id !== id));
            return;
          case "toggleDash":
            writeConnectors(
              connectors.map((c) =>
                c.id === id
                  ? { ...c, format: { ...c.format, strokeStyle: c.format.strokeStyle === "dashed" ? "solid" : "dashed" } }
                  : c,
              ),
            );
            return;
          case "toggleArrow":
            writeConnectors(
              connectors.map((c) => (c.id === id ? { ...c, arrowEnd: c.arrowEnd === "none" ? "arrow" : "none" } : c)),
            );
            return;
          case "reverse":
            writeConnectors(connectors.map((c) => (c.id === id ? { ...c, from: c.to, to: c.from } : c)));
            return;
          default:
            return;
        }
      }

      onEdgeCommand(action, data);
    },
    [connectors, edges, onEdgeCommand, writeConnectors],
  );

  /**
   * A drag between two handles.
   *
   * Between two model objects it means "these are related", and the caller opens a
   * dialog to turn it into a real relationship or foreign key. Anything involving a
   * shape is decorative and becomes a plain connector, the two must never be confused,
   * because one generates DDL and the other does not.
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!canEdit || !connection.source || !connection.target) return;
      const involvesShape =
        connection.source.startsWith("shape:") || connection.target.startsWith("shape:");

      if (involvesShape || tool === "connect") {
        const next: DiagramConnector = {
          id: `cnx_${Date.now().toString(36)}`,
          from: toEnd(connection.source),
          to: toEnd(connection.target),
          waypoints: [],
          lineStyle: "curved",
          arrowStart: "none",
          arrowEnd: "arrow",
          format: {},
        };
        writeConnectors([...connectors, next]);
        setEdges((current) => addEdge({ ...connection, id: `conn:${next.id}` }, current));
        onToolUsed();
        return;
      }

      onRelate(connection.source, connection.target);
    },
    [canEdit, connectors, onRelate, onToolUsed, setEdges, tool, writeConnectors],
  );

  // ---------------------------------------------------------------- imperative

  const alignSelection = useCallback(
    (axis: AlignAxis) => {
      const ids = new Set(selectedShapeNodes.map((node) => node.id.slice("shape:".length)));
      const chosen = shapes.filter((shape) => ids.has(shape.id));
      if (chosen.length < 2) return;

      const lefts = chosen.map((shape) => shape.x);
      const rights = chosen.map((shape) => shape.x + shape.width);
      const tops = chosen.map((shape) => shape.y);
      const bottoms = chosen.map((shape) => shape.y + shape.height);

      const target = {
        left: Math.min(...lefts),
        right: Math.max(...rights),
        top: Math.min(...tops),
        bottom: Math.max(...bottoms),
        centerX: (Math.min(...lefts) + Math.max(...rights)) / 2,
        centerY: (Math.min(...tops) + Math.max(...bottoms)) / 2,
      };

      writeShapes(
        shapes.map((shape) => {
          if (!ids.has(shape.id)) return shape;
          switch (axis) {
            case "left": return { ...shape, x: Math.round(target.left) };
            case "right": return { ...shape, x: Math.round(target.right - shape.width) };
            case "centerX": return { ...shape, x: Math.round(target.centerX - shape.width / 2) };
            case "top": return { ...shape, y: Math.round(target.top) };
            case "bottom": return { ...shape, y: Math.round(target.bottom - shape.height) };
            case "centerY": return { ...shape, y: Math.round(target.centerY - shape.height / 2) };
          }
        }),
      );
    },
    [selectedShapeNodes, shapes, writeShapes],
  );

  const distributeSelection = useCallback(
    (axis: "horizontal" | "vertical") => {
      const ids = new Set(selectedShapeNodes.map((node) => node.id.slice("shape:".length)));
      const chosen = shapes.filter((shape) => ids.has(shape.id));
      if (chosen.length < 3) return;

      // Space the centres evenly between the two outermost, which stay put.
      const sorted = [...chosen].sort((a, b) => (axis === "horizontal" ? a.x - b.x : a.y - b.y));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const startCentre = axis === "horizontal" ? first.x + first.width / 2 : first.y + first.height / 2;
      const endCentre = axis === "horizontal" ? last.x + last.width / 2 : last.y + last.height / 2;
      const step = (endCentre - startCentre) / (sorted.length - 1);

      const moved = new Map<string, DiagramShape>();
      sorted.forEach((shape, index) => {
        if (index === 0 || index === sorted.length - 1) return;
        const centre = startCentre + step * index;
        moved.set(
          shape.id,
          axis === "horizontal"
            ? { ...shape, x: Math.round(centre - shape.width / 2) }
            : { ...shape, y: Math.round(centre - shape.height / 2) },
        );
      });

      writeShapes(shapes.map((shape) => moved.get(shape.id) ?? shape));
    },
    [selectedShapeNodes, shapes, writeShapes],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      fitView: () => void fitView({ padding: 0.2, maxZoom: 1 }),
      zoomIn: () => void zoomIn(),
      zoomOut: () => void zoomOut(),
      addShape: (kind) => {
        // Centre of the *canvas*, not the window, the rail and panel offset it, and
        // using window coordinates dropped shapes off to one side.
        const bounds = wrapperRef.current?.getBoundingClientRect();
        const point = bounds
          ? screenToFlowPosition({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
          : { x: 0, y: 0 };
        addShapeAt(kind, point.x, point.y);
      },
      alignSelection,
      distributeSelection,
      duplicateSelection: () => {
        const ids = new Set(selectedShapeNodes.map((node) => node.id.slice("shape:".length)));
        const copies = shapes
          .filter((shape) => ids.has(shape.id))
          .map((shape) => ({
            ...shape,
            id: `shp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            x: shape.x + 24,
            y: shape.y + 24,
          }));
        if (copies.length > 0) writeShapes([...shapes, ...copies]);
      },
      deleteSelectedShapes: () => {
        const ids = new Set(selectedShapeNodes.map((node) => node.id.slice("shape:".length)));
        if (ids.size === 0) return;
        writeShapes(shapes.filter((shape) => !ids.has(shape.id)));
        writeConnectors(
          connectors.filter((connector) => !ids.has(connector.from.shape ?? "") && !ids.has(connector.to.shape ?? "")),
        );
      },
    }),
    [
      addShapeAt,
      alignSelection,
      connectors,
      distributeSelection,
      fitView,
      screenToFlowPosition,
      selectedShapeNodes,
      shapes,
      writeConnectors,
      writeShapes,
      zoomIn,
      zoomOut,
    ],
  );

  /**
   * Publish the diagram's ambient state to the status bar.
   *
   * Three separate effects because the three values change on completely different
   * cadences: zoom on every wheel tick, save state only when a write starts or settles,
   * and the controls once per mount. Publishing them together would push a controls
   * update through on every frame of a pinch-zoom.
   */
  useEffect(() => {
    publishCanvasStatus({ zoom: viewport.zoom });
  }, [viewport.zoom]);

  useEffect(() => {
    publishCanvasStatus({ saveState });
  }, [saveState]);

  useEffect(() => {
    publishCanvasStatus({
      controls: {
        zoomIn: () => void zoomIn(),
        zoomOut: () => void zoomOut(),
        fitView: () => void fitView({ padding: 0.2, maxZoom: 1 }),
      },
    });
  }, [zoomIn, zoomOut, fitView]);

  /**
   * Withdraw everything when the diagram goes away.
   *
   * Without this, navigating off mid-save leaves "Saving…" in the status bar for the rest
   * of the session, because the component that would have cleared it is gone. Clearing
   * `controls` is what makes the zoom widget disappear on Problems and Changes rather
   * than sitting there reporting the last diagram's zoom next to no diagram.
   */
  useEffect(() => resetCanvasStatus, []);

  /**
   * Open at 100%, anchored on the top-left of the content.
   *
   * `fitView` on mount is the obvious choice and the wrong one. It scales to whatever
   * makes everything fit, which on a real model means opening at 48%, column names
   * too small to read, and the first thing you do every time is zoom back in. Modelling
   * tools open at 1:1 and let you pan; the fit button is still one click away when you
   * actually want the overview.
   *
   * Keyed on the model and diagram so switching between them re-anchors, but panning
   * and zooming within one is never yanked back.
   */
  const openedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${graph.model.id}:${graph.diagram?.id ?? ""}`;
    if (openedKey.current === key) return;

    const placed = [...entityNodes, ...shapeNodes];
    if (placed.length === 0) return;
    openedKey.current = key;

    const bounds = getNodesBounds(placed);
    const margin = 48;
    setViewport({ x: margin - bounds.x, y: margin - bounds.y, zoom: 1 });
  }, [entityNodes, shapeNodes, graph.model.id, graph.diagram?.id, setViewport]);

  const context = useMemo<CanvasContextValue>(
    () => ({
      displayLevel,
      notation,
      selectedId,
      canEdit,
      onRename,
      onMemberChange: onMemberEdit,
      onMemberAdd,
      onContextMenu,
      onShapeTextChange: (shapeId, text) =>
        writeShapes(shapes.map((shape) => (shape.id === shapeId ? { ...shape, text } : shape))),
      onEdgeAction: handleEdgeAction,
      lockedBy: (objectId: string) =>
        locks.find((lock) => lock.objectId === objectId && lock.connectionId !== connectionId),
    }),
    [
      canEdit,
      connectionId,
      displayLevel,
      handleEdgeAction,
      locks,
      onContextMenu,
      onMemberAdd,
      onMemberEdit,
      onRename,
      notation,
      selectedId,
      shapes,
      writeShapes,
    ],
  );

  /**
   * What the current selection is related to.
   *
   * Everything else is dimmed. The set is the selected box plus every box on the other end
   * of one of its relationships, one hop, not the transitive closure: two hops out from a
   * conformed dimension is most of the warehouse, which dims nothing and helps no one.
   *
   * Undefined when nothing is selected, which leaves the diagram at full contrast. Focus is
   * something you ask for; a diagram that dims itself the moment you glance at it is worse
   * than one that never dims.
   */
  const focus = useMemo(() => {
    if (!selectedId) return undefined;

    const nodes = new Set<string>([selectedId]);
    const edgeIds = new Set<string>();

    for (const edge of graph.edges) {
      if (edge.sourceId !== selectedId && edge.targetId !== selectedId) continue;
      edgeIds.add(edge.id);
      nodes.add(edge.sourceId);
      nodes.add(edge.targetId);
    }

    return { nodes, edges: edgeIds };
  }, [selectedId, graph.edges]);

  /**
   * Tag the focused nodes and edges so CSS can dim the rest.
   *
   * A class on each element rather than a per-element opacity, so the dimming is one rule
   * in the stylesheet instead of a style object rebuilt on every selection change, and so
   * the *un*focused case costs nothing at all: with no selection these map straight back to
   * the originals, and React Flow sees the same array identity it had before.
   */
  const focusedNodes = useMemo(
    () =>
      focus
        ? nodes.map((node) =>
            focus.nodes.has(node.id)
              ? { ...node, className: `${node.className ?? ""} node--related`.trim() }
              : node,
          )
        : nodes,
    [nodes, focus],
  );

  const focusedEdges = useMemo(
    () =>
      focus
        ? edges.map((edge) =>
            focus.edges.has(edge.id)
              ? { ...edge, className: `${edge.className ?? ""} edge--related`.trim() }
              : edge,
          )
        : edges,
    [edges, focus],
  );

  const empty = graph.nodes.length === 0 && shapes.length === 0;

  return (
    <CanvasContext.Provider value={context}>
      <div
        ref={wrapperRef}
        className={`canvas${tool !== "select" ? " canvas--placing" : ""}${focus ? " canvas--focused" : ""}`}
      >
        <NotationDefs />
        {/*
          The hint is an overlay, not a replacement.

          Rendering it *instead of* the canvas meant an empty model had no React Flow
          instance at all, so there was no drop target, no pane to click, and dragging a
          shape from the palette silently did nothing. The one state where you most need
          to add something was the one state where you could not.
        */}
        {empty ? (
          <div className="canvas__hint">
            <p style={{ margin: 0, fontSize: "var(--fs-lg)", fontWeight: 600 }}>
              {graph.model.name} is empty
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Right-click to add{" "}
              {graph.model.tier === "conceptual"
                ? "a concept"
                : graph.model.tier === "logical"
                  ? "an entity"
                  : "a table"}
              , or drag a shape from the palette.
            </p>
          </div>
        ) : null}

        <ReactFlow
            nodes={focusedNodes}
            edges={focusedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            elementsSelectable
            multiSelectionKeyCode="Shift"
            selectionKeyCode="Shift"
            /**
             * Disable React Flow's own delete handling entirely.
             *
             * Left unset it defaults to Backspace/Delete and removes the selected node
             * from its *internal state only*, emitting a `remove` change that nothing
             * here listens for. The result is the worst possible outcome: the shape
             * vanishes from the screen, the diagram file is never touched, and the next
             * refetch brings it straight back, so the delete looks like it worked and
             * silently did not.
             *
             * Deletion is routed explicitly instead, because the two kinds are not
             * equivalent: a shape is drawing and can go immediately, while an entity or
             * table is a governed object whose removal lands in a pull request and
             * therefore has to be confirmed first.
             */
            deleteKeyCode={null}
            snapToGrid={snapToGrid}
            snapGrid={[20, 20]}
            onNodeClick={(_event, node) => {
              onSelect(node.type === "entity" ? node.id : undefined);
            }}
            onPaneClick={(event) => {
              onSelect(undefined);
              // A shape tool stays armed until used, so a click places one. Read from the
              // ref, not the prop: a drop consumed the tool moments ago and the prop has
              // not caught up yet.
              const current = armed.current;
              if (current !== "select" && current !== "connect" && canEdit) {
                const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
                addShapeAt(current, point.x, point.y);
              }
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              onCanvasContextMenu(event as React.MouseEvent);
            }}
            onDrop={(event) => {
              const kind = event.dataTransfer.getData("application/strata-shape");
              if (!kind || !canEdit) return;
              event.preventDefault();
              const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
              addShapeAt(kind as ShapeKind, point.x, point.y);
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("application/strata-shape")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            /**
             * Any connection point can start or finish a drag.
             *
             * The default is `strict`, where a `source` handle may only reach a `target`.
             * With one of each per box that made relationships drawable in one direction
             * only, left to right, which is not how anyone lays out a model. Loose mode
             * plus a point on every side means you drag from whichever edge is nearest and
             * confirm the direction in the dialog, which is where it belongs anyway.
             */
            connectionMode={ConnectionMode.Loose}
            /**
             * Snap to a connection point from 28px away.
             *
             * The default of 20 is measured from the handle itself, and these are small
             * targets on a diagram people work at 60% zoom. Widening it is the difference
             * between "drag onto the box" and "hit the dot".
             */
            connectionRadius={28}
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--canvas-grid)" />
        </ReactFlow>

        {/*
          Nothing is rendered over the diagram here on purpose.

          The zoom control and the save-state chip used to sit in this spot, pinned to the
          canvas's bottom-right corner, the chip at a hardcoded `bottom: 58px` so it
          cleared the zoom box below it. Both are ambient state, both are now in the
          status bar, and the only things still allowed to float over this surface are the
          selection and format toolbars, which position against the selection rather than
          against the viewport.
        */}
      </div>
    </CanvasContext.Provider>
  );
}

function endToNodeId(end: DiagramConnector["from"]): string | undefined {
  if (end.shape) return `shape:${end.shape}`;
  return end.ref;
}

function toEnd(nodeId: string): DiagramConnector["from"] {
  return nodeId.startsWith("shape:")
    ? { shape: nodeId.slice("shape:".length), side: "auto" }
    : { ref: nodeId, side: "auto" };
}
