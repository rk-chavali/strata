import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Icon, IconButton, type IconName } from "../ui";

/**
 * A docked, resizable side panel.
 *
 * The studio's shape comes from this: an explorer on the left, properties on the right,
 * the canvas taking whatever is left. Both were modals before, and a modal is the wrong
 * container for either, you cannot see the box you are editing while its dialog covers
 * the canvas, and you cannot navigate a tree that closes the moment you click the thing
 * you were navigating to.
 *
 * Three things make a dock feel native rather than bolted on, and all three are easy to
 * skip:
 *
 *   1. **The width persists.** A panel that resets to 260px on every navigation trains
 *      you not to resize it.
 *   2. **Collapsing keeps the handle.** Collapse to a labelled spine, not to nothing, *      a panel that vanishes entirely leaves no way back except a menu you have to find.
 *   3. **The drag is on the inner edge.** The edge against the canvas, not the window,
 *      because that is the boundary you are actually moving.
 */

/** Where the panel lives, which decides which edge the drag handle is on. */
export type PanelSide = "left" | "right";

const MIN_WIDTH = 200;
const MAX_WIDTH = 560;

/**
 * Remembered width, per panel.
 *
 * `localStorage` rather than a workspace setting: this is a property of *this person's
 * screen*, not of the model, and writing it to the repo would put one modeller's window
 * layout in another modeller's diff.
 */
export function usePanelWidth(key: string, fallback: number): [number, (next: number) => void] {
  const storageKey = `strata.panel.${key}`;

  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : fallback;
  });

  const set = useCallback(
    (next: number) => {
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next)));
      setWidth(clamped);
      localStorage.setItem(storageKey, String(clamped));
    },
    [storageKey],
  );

  return [width, set];
}

/** Remembered open/closed state, per panel. Same reasoning as the width. */
export function usePanelOpen(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const storageKey = `strata.panel.${key}.open`;

  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? fallback : stored === "1";
  });

  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      localStorage.setItem(storageKey, next ? "1" : "0");
    },
    [storageKey],
  );

  return [open, set];
}

interface Props {
  side: PanelSide;
  title: string;
  icon: IconName;
  width: number;
  onWidthChange: (next: number) => void;
  onClose: () => void;
  /** Rendered in the panel's header, right of the title, filters, a kind switch, an action. */
  toolbar?: ReactNode;
  /** Shown under the header, above the scrolling body. Does not scroll away. */
  sticky?: ReactNode;
  children: ReactNode;
}

export function StudioPanel({
  side,
  title,
  icon,
  width,
  onWidthChange,
  onClose,
  toolbar,
  sticky,
  children,
}: Props): JSX.Element {
  const dragging = useRef(false);

  /**
   * Resize on the document, not on the handle.
   *
   * A `mousemove` bound to the handle stops firing the moment the pointer outruns the
   * 6px grab strip, which it always does, the result is a drag that "sticks" whenever
   * you move quickly. Binding to the document for the life of the gesture is what makes
   * it track the pointer instead of the element.
   */
  useEffect(() => {
    function move(event: MouseEvent): void {
      if (!dragging.current) return;
      event.preventDefault();
      const next = side === "left" ? event.clientX : window.innerWidth - event.clientX;
      onWidthChange(next);
    }

    function up(): void {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("is-resizing");
    }

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [side, onWidthChange]);

  /**
   * Keyboard resize, because a drag handle is unusable without a pointer.
   *
   * The handle is a real `button` with `separator` semantics for the same reason: a
   * 6px hit target that only responds to a held mouse button is not reachable by
   * everyone, and the panel width is a genuine setting rather than decoration.
   */
  function onKeyDown(event: React.KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";

    if (event.key === grow) {
      event.preventDefault();
      onWidthChange(width + step);
    } else if (event.key === shrink) {
      event.preventDefault();
      onWidthChange(width - step);
    }
  }

  return (
    <aside className={`spanel spanel--${side}`} style={{ width }} aria-label={title}>
      <header className="spanel__head">
        <Icon name={icon} size={13} className="spanel__icon" />
        <h2 className="spanel__title">{title}</h2>
        <span className="grow" />
        {toolbar}
        <IconButton
          icon={side === "left" ? "chevronLeft" : "chevronRight"}
          label={`Hide ${title.toLowerCase()}`}
          size="sm"
          onClick={onClose}
        />
      </header>

      {sticky ? <div className="spanel__sticky">{sticky}</div> : null}

      <div className="spanel__body">{children}</div>

      <button
        type="button"
        className="spanel__grip"
        aria-label={`Resize ${title.toLowerCase()}`}
        title="Drag to resize"
        onMouseDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          document.body.classList.add("is-resizing");
        }}
        onKeyDown={onKeyDown}
      />
    </aside>
  );
}

/**
 * The spine a collapsed panel leaves behind.
 *
 * Rotated text rather than an icon alone, because "Explorer" and "Properties" are not
 * guessable from a glyph, and a 28px strip with a mystery icon is how a panel gets lost
 * for good.
 */
export function PanelSpine({
  side,
  title,
  icon,
  onOpen,
  badge,
}: {
  side: PanelSide;
  title: string;
  icon: IconName;
  onOpen: () => void;
  /** A count worth seeing while collapsed, e.g. how many problems are hiding in there. */
  badge?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`spine spine--${side}`}
      onClick={onOpen}
      title={`Show ${title.toLowerCase()}`}
    >
      <Icon name={icon} size={14} />
      <span className="spine__label">{title}</span>
      {badge ? <span className="spine__badge">{badge}</span> : null}
    </button>
  );
}
