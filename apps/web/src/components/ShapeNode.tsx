import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useCanvas } from "./canvasContext";
import type { DiagramShape } from "../types";

/**
 * A free-form shape.
 *
 * The node **fills its React Flow wrapper** rather than sizing itself from its own
 * data. That is what makes resizing feel immediate: the resizer changes the wrapper,
 * and the shape follows in the same frame, instead of snapping only once the new size
 * has round-tripped through the server.
 *
 * Geometry is drawn in a normalised 0 to 100 viewBox with `preserveAspectRatio="none"`,
 * so it stretches to any size without the component needing to know its pixel
 * dimensions. Rectangles use CSS instead, because a stretched SVG corner radius turns
 * into an ellipse.
 *
 * Shapes carry no meaning to the validator or the DDL generator, which is what lets
 * someone sketch a boundary without inventing metamodel concepts.
 */

export interface ShapeNodeData extends Record<string, unknown> {
  shape: DiagramShape;
}

/** Shapes drawn with CSS, because their corners must not distort when stretched. */
const CSS_SHAPES = new Set(["rectangle", "roundedRectangle", "note", "legend", "text", "table"]);

/**
 * A sketched table: first line is the title, the rest are rows.
 *
 * Typed as one block of text rather than as structured rows, because the point is to
 * sketch faster than the real editor allows. Editing is the same plain textarea every
 * other shape uses, a row grid with add and delete buttons would be a worse version of
 * the actual table editor, which is one right-click away when the sketch is worth
 * promoting.
 */
function TableSketch({ text, canEdit }: { text: string; canEdit: boolean }): JSX.Element {
  const [title, ...rows] = text.split("\n");

  if (!text.trim()) {
    return (
      <div className="tablesketch">
        <div className="tablesketch__head">table_name</div>
        {canEdit
          ? ["double-click to edit", "column", "column"].map((hint, index) => (
              <div key={index} className="tablesketch__row shape__placeholder">
                {hint}
              </div>
            ))
          : null}
        <div className="tablesketch__fill" />
      </div>
    );
  }

  return (
    <div className="tablesketch">
      <div className="tablesketch__head">{title}</div>
      {rows.map((row, index) => (
        <div key={`${row}-${index}`} className="tablesketch__row">
          {row || " "}
        </div>
      ))}
      {/* Ruled space below the rows, so it keeps reading as a table when stretched. */}
      <div className="tablesketch__fill" />
    </div>
  );
}

export function ShapeNode({ data, selected }: NodeProps): JSX.Element {
  const { shape } = data as ShapeNodeData;
  const { canEdit, onShapeTextChange, onContextMenu } = useCanvas();

  const [editing, setEditing] = useState(shape.text.length === 0 && shape.shape !== "legend");
  const [text, setText] = useState(shape.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setText(shape.text), [shape.text]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit(): void {
    setEditing(false);
    if (text !== shape.text) onShapeTextChange(shape.id, text);
  }

  const format = shape.format;
  const isCss = CSS_SHAPES.has(shape.shape);
  const stroke = format.stroke ?? "var(--n5)";
  const fill = format.fill ?? "var(--n0)";

  const textStyle: React.CSSProperties = {
    color: format.textColor ?? "var(--n9)",
    fontSize: format.fontSize ?? 13,
    fontWeight: format.bold ? 700 : 400,
    fontStyle: format.italic ? "italic" : "normal",
    textDecoration: format.underline ? "underline" : "none",
    textAlign: format.align ?? "center",
    justifyContent:
      format.verticalAlign === "top" ? "flex-start" : format.verticalAlign === "bottom" ? "flex-end" : "center",
  };

  return (
    <div
      className={`shape shape--${shape.shape}${selected ? " shape--sel" : ""}`}
      style={{
        // Fill the wrapper. The resizer sizes the wrapper; this follows it live.
        width: "100%",
        height: "100%",
        opacity: format.opacity ?? 1,
        ...(isCss && shape.shape !== "text"
          ? {
              background: fill === "none" ? "transparent" : fill,
              border: stroke === "none" ? "none" : `${format.strokeWidth ?? 1}px ${format.strokeStyle ?? "solid"} ${stroke}`,
              borderRadius:
                format.cornerRadius ?? (shape.shape === "roundedRectangle" ? 12 : shape.shape === "note" ? 4 : 2),
            }
          : {}),
      }}
      onDoubleClick={() => canEdit && setEditing(true)}
      onContextMenu={(event) => onContextMenu(event, `shape:${shape.id}`)}
    >
      {/* Generous handles: a 4px target is unhittable at any zoom. */}
      <NodeResizer
        isVisible={Boolean(selected) && canEdit}
        minWidth={48}
        minHeight={28}
        lineClassName="resize__line"
        handleClassName="resize__handle"
      />

      {/* Handles let a hand-drawn connector attach to any side of any shape. */}
      <Handle type="target" position={Position.Left} className="shape__handle" />
      <Handle type="source" position={Position.Right} className="shape__handle" />
      <Handle type="target" position={Position.Top} id="t" className="shape__handle" />
      <Handle type="source" position={Position.Bottom} id="b" className="shape__handle" />

      {!isCss ? <ShapeBackground shape={shape} /> : null}

      <div className="shape__label" style={textStyle}>
        {editing ? (
          <textarea
            ref={inputRef}
            className="shape__input"
            style={{ ...textStyle, textAlign: format.align ?? "center" }}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setText(shape.text);
                setEditing(false);
              }
              // Enter inserts a newline; these are paragraphs. Commit with the modifier.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
            }}
          />
        ) : shape.shape === "table" ? (
          <TableSketch text={shape.text} canEdit={canEdit} />
        ) : (
          <span className="shape__text">
            {shape.text || (canEdit ? <span className="shape__placeholder">Double-click to type</span> : "")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Non-rectangular geometry, drawn in a normalised 0 to 100 box.
 *
 * `preserveAspectRatio="none"` lets it stretch to whatever the wrapper is, so the
 * component never needs the pixel size. `vectorEffect="non-scaling-stroke"` keeps the
 * outline one pixel wide however far it is stretched, without it, a wide shape gets a
 * thick left and right border and thin top and bottom.
 */
function ShapeBackground({ shape }: { shape: DiagramShape }): JSX.Element {
  const { format } = shape;
  const common = {
    fill: format.fill ?? "var(--n0)",
    stroke: format.stroke ?? "var(--n5)",
    strokeWidth: format.strokeWidth ?? 1,
    strokeDasharray:
      format.strokeStyle === "dashed" ? "4 3" : format.strokeStyle === "dotted" ? "1 2" : undefined,
    vectorEffect: "non-scaling-stroke" as const,
  };

  return (
    <svg className="shape__bg" viewBox="0 0 100 100" preserveAspectRatio="none">
      {shape.shape === "ellipse" ? (
        <ellipse cx={50} cy={50} rx={49.5} ry={49.5} {...common} />
      ) : shape.shape === "diamond" ? (
        <polygon points="50,0.5 99.5,50 50,99.5 0.5,50" {...common} />
      ) : shape.shape === "parallelogram" ? (
        <polygon points="18,0.5 99.5,0.5 82,99.5 0.5,99.5" {...common} />
      ) : shape.shape === "hexagon" ? (
        <polygon points="16,0.5 84,0.5 99.5,50 84,99.5 16,99.5 0.5,50" {...common} />
      ) : shape.shape === "cylinder" ? (
        <g {...common}>
          <path d="M0.5,12 v76 a49.5,12 0 0 0 99,0 v-76" />
          <ellipse cx={50} cy={12} rx={49.5} ry={11.5} />
        </g>
      ) : (
        <g {...common}>
          <rect x={0.5} y={0.5} width={99} height={99} />
          <line x1={12} y1={0.5} x2={12} y2={99.5} />
          <line x1={88} y1={0.5} x2={88} y2={99.5} />
        </g>
      )}
    </svg>
  );
}
