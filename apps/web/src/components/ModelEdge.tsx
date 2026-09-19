import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import { Icon } from "../ui";
import { useCanvas } from "./canvasContext";

/**
 * An interactive edge.
 *
 * Two things make a line usable rather than decorative:
 *
 *  - **A hit area far wider than the stroke.** A 1.5px line is essentially unclickable;
 *    `interactionWidth` gives it a transparent 24px band so it can be hit at any zoom.
 *  - **A toolbar on the line itself.** Once selected, the actions appear where the user
 *    is already looking, rather than in a panel across the screen.
 *
 * Relationship edges and hand-drawn connectors share this component but offer different
 * actions, because deleting one drops a foreign key and deleting the other erases a
 * doodle, and they must never look interchangeable.
 */

export interface ModelEdgeData extends Record<string, unknown> {
  kind: "relationship" | "foreignKey" | "connector";
  /** Object owning the edge: the relationship, or the child table holding the FK. */
  ownerId?: string;
  /** Foreign key name, when this edge is a foreign key. */
  foreignKeyName?: string;
  /** Connector id, when hand-drawn. */
  connectorId?: string;
  label?: string;
  /** Plain language, shown in a tooltip. The glyphs carry it on the line itself. */
  cardinalityText?: string;
  dashed?: boolean;
  arrowEnd?: boolean;
  /**
   * Text at the ends: UML multiplicity (`0..1`, `1..*`) or an IDEF1X cardinality code
   * (`P`, `Z`, `1`). Distinct from `label`, which is the verb phrase in the middle.
   */
  startLabel?: string;
  endLabel?: string;
  /**
   * Barker only: which half of the line is dashed.
   *
   * Barker carries optionality in the line rather than in a glyph, the half touching an
   * optional end is dashed, the half touching a mandatory end is solid. A line can
   * therefore be dashed at one end and solid at the other, which no single
   * `stroke-dasharray` can express, so the edge is drawn as two half-paths instead.
   */
  splitLine?: { startHalfDashed: boolean; endHalfDashed: boolean };
}

export function ModelEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  style,
  data,
  selected,
}: EdgeProps): JSX.Element {
  const edgeData = (data ?? {}) as ModelEdgeData;
  const { canEdit, onEdgeAction } = useCanvas();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edgeData.label ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(edgeData.label ?? ""), [edgeData.label]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const straight = edgeData.kind === "connector" && style?.strokeDasharray === undefined;
  const [path, labelX, labelY] = straight
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  function commitLabel(): void {
    setEditing(false);
    if (draft !== (edgeData.label ?? "")) onEdgeAction({ type: "label", edgeId: id, value: draft });
  }

  const isConnector = edgeData.kind === "connector";

  const selectedStyle = selected
    ? { stroke: "var(--accent)", strokeWidth: 2.5, color: "var(--accent)" }
    : {};

  /**
   * Barker's half-dashed line.
   *
   * Drawn as two copies of the same path, each revealed for half its length by a dash
   * pattern built from `pathLength`. Normalising `pathLength` to 100 is what makes this
   * work without measuring: the halves are then "50 units on, 50 off" and "50 off, 50 on"
   * regardless of the curve's real length, so it holds as boxes move and the bezier
   * changes shape.
   *
   * The dashed half uses a second pattern *inside* its visible run, which is why the
   * values are expressed against the same 100-unit scale.
   */
  const split = edgeData.splitLine;

  /**
   * Dash patterns for Barker's split line, in `pathLength`-normalised units.
   *
   * Each edge is drawn twice over the same geometry, and each copy reveals exactly half of
   * it. With `pathLength={100}` the halves are always 0 to 50 and 50 to 100 whatever the curve's
   * real length, so the patterns hold as boxes move and the bezier reshapes.
   *
   * **Every pattern must sum to exactly 100.** A dash array tiles, so one that sums to
   * anything else restarts partway along and paints dashes into the half it was supposed
   * to leave empty. The first attempt here used `0 50 3 3`, which sums to 56, it tiled
   * twice across the line and drew essentially nothing in the right place.
   *
   * A dashed half is therefore ten `2.5 on / 2.5 off` pairs, which fill precisely 50, plus
   * a zero-length dash and a 50-unit gap to skip the other half.
   */
  const DASH_PAIRS = Array.from({ length: 10 }, () => "2.5 2.5").join(" ");
  const FIRST_HALF_SOLID = "50 50";
  const SECOND_HALF_SOLID = "0 50 50 0";
  const FIRST_HALF_DASHED = `${DASH_PAIRS} 0 50`;
  const SECOND_HALF_DASHED = `0 50 ${DASH_PAIRS}`;

  return (
    <>
      {split ? (
        <>
          {/* First half: from the parent end to the midpoint. */}
          <path
            d={path}
            fill="none"
            pathLength={100}
            style={{ ...style, ...selectedStyle }}
            strokeDasharray={split.startHalfDashed ? FIRST_HALF_DASHED : FIRST_HALF_SOLID}
            markerStart={markerStart}
          />
          {/* Second half: midpoint to the child end. */}
          <path
            d={path}
            fill="none"
            pathLength={100}
            style={{ ...style, ...selectedStyle }}
            strokeDasharray={split.endHalfDashed ? SECOND_HALF_DASHED : SECOND_HALF_SOLID}
            markerEnd={markerEnd}
          />
          {/* Invisible band so the two thin halves are still clickable as one edge. */}
          <path
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={24}
            className="react-flow__edge-interaction"
          />
        </>
      ) : (
        <BaseEdge
          id={id}
          path={path}
          markerStart={markerStart}
          markerEnd={markerEnd}
          // A thin line needs a fat invisible band or it cannot be clicked.
          interactionWidth={24}
          style={{
            ...style,
            // Selecting recolours the glyphs too, since they inherit `currentColor`.
            ...selectedStyle,
          }}
        />
      )}

      <EdgeLabelRenderer>
        {/*
          Cardinality text at the ends, for the notations that put it there.
          Positioned by interpolating a short way from each end toward the middle of the
          line, rather than at a fixed pixel offset: the ends attach to different sides of a
          box as it moves, and a fixed offset that reads well on a horizontal line sits on
          top of the glyph on a vertical one.
        */}
        {edgeData.startLabel ? (
          <div
            className="edgeend nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${sourceX + (labelX - sourceX) * 0.22}px, ${sourceY + (labelY - sourceY) * 0.22}px)`,
            }}
          >
            {edgeData.startLabel}
          </div>
        ) : null}

        {edgeData.endLabel ? (
          <div
            className="edgeend nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${targetX + (labelX - targetX) * 0.22}px, ${targetY + (labelY - targetY) * 0.22}px)`,
            }}
          >
            {edgeData.endLabel}
          </div>
        ) : null}

        {editing ? (
          <input
            ref={inputRef}
            className="edgelabel__input nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitLabel();
              if (event.key === "Escape") {
                setDraft(edgeData.label ?? "");
                setEditing(false);
              }
            }}
          />
        ) : edgeData.label ? (
          <div
            className={`edgelabel nodrag nopan${selected ? " edgelabel--sel" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={edgeData.cardinalityText ? `to ${edgeData.cardinalityText}` : undefined}
            onDoubleClick={() => canEdit && setEditing(true)}
          >
            {edgeData.label}
          </div>
        ) : null}

        {selected && canEdit && !editing ? (
          <div
            className="edgetool nodrag nopan"
            style={{ transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 14}px)` }}
          >
            <button type="button" title="Edit label" onClick={() => setEditing(true)}>
              <Icon name="edit" size={13} />
            </button>

            {isConnector ? (
              <>
                <button
                  type="button"
                  title={edgeData.dashed ? "Solid line" : "Dashed line"}
                  onClick={() => onEdgeAction({ type: "toggleDash", edgeId: id })}
                >
                  <Icon name="minus" size={13} />
                </button>
                <button
                  type="button"
                  title={edgeData.arrowEnd ? "Remove arrowhead" : "Add arrowhead"}
                  onClick={() => onEdgeAction({ type: "toggleArrow", edgeId: id })}
                >
                  <Icon name="connector" size={13} />
                </button>
                <button
                  type="button"
                  title="Reverse direction"
                  onClick={() => onEdgeAction({ type: "reverse", edgeId: id })}
                >
                  <Icon name="refresh" size={13} />
                </button>
              </>
            ) : (
              <button
                type="button"
                title="Change cardinality"
                onClick={() => onEdgeAction({ type: "cardinality", edgeId: id })}
              >
                <Icon name="link" size={13} />
              </button>
            )}

            <span className="edgetool__sep" />
            <button
              type="button"
              className="edgetool__danger"
              title={
                edgeData.kind === "foreignKey"
                  ? "Delete the foreign key"
                  : edgeData.kind === "relationship"
                    ? "Delete the relationship"
                    : "Delete the connector"
              }
              onClick={() => onEdgeAction({ type: "delete", edgeId: id })}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}
