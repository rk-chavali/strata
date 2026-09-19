import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon, type IconName } from "../ui";
import type { Format } from "../types";

/**
 * Formatting for the selected shape.
 *
 * A conceptual diagram is a document people argue over in a room, and emphasis carries
 * as much of the argument as the boxes do. Without bold text and colour, people export
 * to PowerPoint to make the version they actually present, and then the diagram under
 * version control is not the one anyone looks at.
 */

/** A restrained palette. Arbitrary colour pickers produce diagrams nobody can read. */
const SWATCHES = [
  { name: "None", value: "none" },
  { name: "White", value: "#ffffff" },
  { name: "Grey", value: "#eef1f5" },
  { name: "Blue", value: "#dbeafe" },
  { name: "Green", value: "#dcfce7" },
  { name: "Amber", value: "#fef3c7" },
  { name: "Red", value: "#fee2e2" },
  { name: "Purple", value: "#ede9fe" },
];

const TEXT_COLOURS = [
  { name: "Default", value: "" },
  { name: "Black", value: "#1a2029" },
  { name: "Grey", value: "#5a6472" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Green", value: "#15803d" },
  { name: "Amber", value: "#b45309" },
  { name: "Red", value: "#b91c1c" },
];

const FONT_SIZES = [10, 11, 12, 13, 15, 18, 22, 28];

interface Props {
  x: number;
  y: number;
  format: Format;
  /** Shown only when several objects are selected. */
  selectionCount: number;
  onFormat: (patch: Partial<Format>) => void;
  onAlign: (axis: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function FormatToolbar({
  x,
  y,
  format,
  selectionCount,
  onFormat,
  onAlign,
  onDistribute,
  onDuplicate,
  onDelete,
}: Props): JSX.Element {
  const [open, setOpen] = useState<"fill" | "text" | "size" | undefined>();
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Popovers stay open until you click outside the toolbar.
   *
   * Closing after every choice made trying three colours in a row needlessly tedious, * you had to reopen the panel each time. Now it stays put until you are done with it.
   */
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) setOpen(undefined);
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return (
    <div
      ref={ref}
      className="fmtbar"
      style={{ left: x, top: y - 10 }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <Toggle active={format.bold} label="Bold" icon="bold" onClick={() => onFormat({ bold: !format.bold })} />
      <Toggle active={format.italic} label="Italic" icon="italic" onClick={() => onFormat({ italic: !format.italic })} />
      <Toggle
        active={format.underline}
        label="Underline"
        icon="underline"
        onClick={() => onFormat({ underline: !format.underline })}
      />

      <span className="fmtbar__sep" />

      <Popover
        label={`${format.fontSize ?? 13}`}
        title="Font size"
        open={open === "size"}
        onToggle={() => setOpen(open === "size" ? undefined : "size")}
      >
        {/* A free number field, because the presets are shortcuts and not a limit. */}
        <label className="fmtbar__sizefield">
          <span className="fmtbar__caption">Size</span>
          <input
            className="input"
            type="number"
            min={6}
            max={200}
            value={format.fontSize ?? 13}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 6 && next <= 200) onFormat({ fontSize: next });
            }}
          />
          <span className="fmtbar__caption">px</span>
        </label>

        <div className="fmtbar__grid">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`fmtbar__opt${(format.fontSize ?? 13) === size ? " fmtbar__opt--on" : ""}`}
              onClick={() => onFormat({ fontSize: size })}
            >
              {size}
            </button>
          ))}
        </div>
      </Popover>

      <Popover
        swatch={format.textColor || "#1a2029"}
        title="Text colour"
        open={open === "text"}
        onToggle={() => setOpen(open === "text" ? undefined : "text")}
      >
        <div className="fmtbar__swatches">
          {TEXT_COLOURS.map((colour) => (
            <button
              key={colour.name}
              type="button"
              className="fmtbar__swatch"
              style={{ background: colour.value || "var(--n9)" }}
              title={colour.name}
              onClick={() => {
                onFormat({ textColor: colour.value || undefined });
                setOpen(undefined);
              }}
            />
          ))}
        </div>
      </Popover>

      <Popover
        swatch={format.fill && format.fill !== "none" ? format.fill : undefined}
        title="Fill"
        open={open === "fill"}
        onToggle={() => setOpen(open === "fill" ? undefined : "fill")}
      >
        <div className="fmtbar__swatches">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch.name}
              type="button"
              className={`fmtbar__swatch${swatch.value === "none" ? " fmtbar__swatch--none" : ""}`}
              style={swatch.value === "none" ? undefined : { background: swatch.value }}
              title={swatch.name}
              onClick={() => {
                onFormat({ fill: swatch.value });
                setOpen(undefined);
              }}
            />
          ))}
        </div>
        <div className="fmtbar__row">
          <span className="fmtbar__caption">Border</span>
          <button type="button" className="fmtbar__opt" onClick={() => onFormat({ strokeStyle: "solid" })}>
            Solid
          </button>
          <button type="button" className="fmtbar__opt" onClick={() => onFormat({ strokeStyle: "dashed" })}>
            Dashed
          </button>
          <button type="button" className="fmtbar__opt" onClick={() => onFormat({ stroke: "none" })}>
            None
          </button>
        </div>
      </Popover>

      <span className="fmtbar__sep" />

      <Toggle
        active={format.align === "left"}
        label="Align left"
        icon="alignLeft"
        onClick={() => onFormat({ align: "left" })}
      />
      <Toggle
        active={format.align === "center" || !format.align}
        label="Align centre"
        icon="alignCenter"
        onClick={() => onFormat({ align: "center" })}
      />
      <Toggle
        active={format.align === "right"}
        label="Align right"
        icon="alignRight"
        onClick={() => onFormat({ align: "right" })}
      />

      {/* Aligning one object against itself is meaningless, so this only appears
          once there is a second thing to align it to. */}
      {selectionCount > 1 ? (
        <>
          <span className="fmtbar__sep" />
          <IconAction label="Align left edges" icon="objLeft" onClick={() => onAlign("left")} />
          <IconAction label="Centre horizontally" icon="objCenterX" onClick={() => onAlign("centerX")} />
          <IconAction label="Align right edges" icon="objRight" onClick={() => onAlign("right")} />
          <IconAction label="Align tops" icon="objTop" onClick={() => onAlign("top")} />
          <IconAction label="Centre vertically" icon="objCenterY" onClick={() => onAlign("centerY")} />
          <IconAction label="Align bottoms" icon="objBottom" onClick={() => onAlign("bottom")} />
          {selectionCount > 2 ? (
            <>
              <IconAction label="Distribute horizontally" icon="distH" onClick={() => onDistribute("horizontal")} />
              <IconAction label="Distribute vertically" icon="distV" onClick={() => onDistribute("vertical")} />
            </>
          ) : null}
        </>
      ) : null}

      <span className="fmtbar__sep" />
      <IconAction label="Duplicate" icon="copy" onClick={onDuplicate} />
      <IconAction label="Delete" icon="trash" onClick={onDelete} />
    </div>
  );
}

function Toggle({
  active,
  label,
  icon,
  onClick,
}: {
  active?: boolean;
  label: string;
  icon: IconName;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`fmtbar__btn${active ? " fmtbar__btn--on" : ""}`}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function IconAction({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="fmtbar__btn" title={label} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  );
}

function Popover({
  label,
  swatch,
  title,
  open,
  onToggle,
  children,
}: {
  label?: string;
  swatch?: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <span className="fmtbar__pop">
      <button type="button" className={`fmtbar__btn${open ? " fmtbar__btn--on" : ""}`} title={title} onClick={onToggle}>
        {swatch !== undefined ? (
          <span className="fmtbar__chip" style={{ background: swatch || "transparent" }} />
        ) : (
          <span className="fmtbar__num">{label}</span>
        )}
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? <div className="fmtbar__panel">{children}</div> : null}
    </span>
  );
}
