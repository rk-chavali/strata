import { useRef } from "react";
import type { JSX } from "react";
import { Icon, type IconName } from "../ui";
import type { ShapeKind } from "../types";

/**
 * The shape palette: a toolbar docked above the canvas.
 *
 * It used to be a floating vertical strip over the diagram's left edge, 39px wide and
 * 434px tall, growing with every shape added, covering whatever happened to be beneath
 * it. Being on top of the canvas bought nothing: the tools are no further from the
 * pointer in a docked row, and now every pixel below the bar is unambiguously diagram.
 *
 * Shapes are dragged onto the canvas, or clicked to arm the tool and then placed.
 *
 * The palette is deliberately short. A hundred shapes is a diagramming tool; a dozen
 * is enough to draw a conceptual model, and every extra one is a decision the user has
 * to make before they can get on with the thing they came to do.
 */

export type Tool = "select" | "connect" | ShapeKind;

const SHAPES: { kind: ShapeKind; icon: IconName; label: string }[] = [
  // First, because on a logical or physical canvas it is the shape you reach for most.
  { kind: "table", icon: "table", label: "Table sketch, title, then a row per line" },
  { kind: "rectangle", icon: "shapeRect", label: "Rectangle" },
  { kind: "roundedRectangle", icon: "shapeRounded", label: "Rounded rectangle" },
  { kind: "ellipse", icon: "shapeEllipse", label: "Ellipse" },
  { kind: "diamond", icon: "shapeDiamond", label: "Diamond, a decision or a weak entity" },
  { kind: "hexagon", icon: "shapeHexagon", label: "Hexagon" },
  { kind: "parallelogram", icon: "shapeParallelogram", label: "Parallelogram, input or output" },
  { kind: "cylinder", icon: "shapeCylinder", label: "Cylinder, a data store" },
  { kind: "process", icon: "shapeProcess", label: "Process" },
  { kind: "text", icon: "shapeText", label: "Text" },
  { kind: "note", icon: "shapeNote", label: "Sticky note" },
];

interface Props {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  disabled: boolean;
}

export function ShapePalette({ tool, onToolChange, disabled }: Props): JSX.Element {
  /**
   * Whether the gesture that just ended was a drag.
   *
   * A drag from this button ends with the browser firing `click` on it as well. That
   * click would arm the tool, so after dropping a shape you would be left holding
   * another one, and your next click on the canvas would place it. Dragging and
   * arming are two ways to do the same thing; doing both at once means doing it twice.
   */
  const dragged = useRef(false);

  return (
    <div className="shapebar">
      <button
        type="button"
        className={`shapebar__btn${tool === "select" ? " shapebar__btn--on" : ""}`}
        title="Select and move (Esc)"
        disabled={disabled}
        onClick={() => onToolChange("select")}
      >
        <Icon name="cursor" />
      </button>

      <button
        type="button"
        className={`shapebar__btn${tool === "connect" ? " shapebar__btn--on" : ""}`}
        title="Draw a connector, drag between two objects"
        disabled={disabled}
        onClick={() => onToolChange(tool === "connect" ? "select" : "connect")}
      >
        <Icon name="connector" />
      </button>

      <span className="shapebar__sep" />

      {SHAPES.map((entry) => (
        <button
          key={entry.kind}
          type="button"
          className={`shapebar__btn${tool === entry.kind ? " shapebar__btn--on" : ""}`}
          title={`${entry.label}, click, then click the canvas. Or drag it across.`}
          disabled={disabled}
          draggable={!disabled}
          onDragStart={(event) => {
            dragged.current = true;
            event.dataTransfer.setData("application/strata-shape", entry.kind);
            event.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={() => {
            // Cleared on the next tick, after the trailing click has been swallowed.
            window.setTimeout(() => {
              dragged.current = false;
            }, 0);
          }}
          /*
           * Arm the tool rather than placing a shape immediately.
           *
           * Placing on click had two faults: it dropped the shape in the middle of the
           * screen instead of where the user wanted it, and a short drag makes the
           * browser fire `click` as well as `drop`, which placed two shapes. Arming
           * makes the click harmless and the placement deliberate.
           */
          onClick={() => {
            if (dragged.current) return;
            onToolChange(tool === entry.kind ? "select" : entry.kind);
          }}
        >
          <Icon name={entry.icon} />
        </button>
      ))}
    </div>
  );
}
