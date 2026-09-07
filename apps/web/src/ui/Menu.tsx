import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode, RefObject } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Dropdown menus, and the dismissal behaviour every floating surface needs.
 *
 * `useDismiss` is exported separately because popovers, pickers and the peer list all
 * need the same three rules and had each grown their own copy:
 *
 *   - outside mousedown closes, captured, the canvas stops propagation on its own
 *     handlers, so a bubbling listener never sees a click that landed on the diagram and
 *     the menu stays open behind whatever you clicked
 *   - Escape closes
 *   - focus leaving the container closes, so Tab does not leave an orphaned menu on screen
 */

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  close: () => void,
): void {
  useEffect(() => {
    if (!active) return;

    function onDown(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) close();
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }

    function onFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null;
      // A null `relatedTarget` means focus went to the document body, clicking empty
      // space, or the window losing focus. Neither should close the menu.
      if (next && !ref.current?.contains(next)) close();
    }

    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    ref.current?.addEventListener("focusout", onFocusOut);
    const node = ref.current;

    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      node?.removeEventListener("focusout", onFocusOut);
    };
  }, [active, close, ref]);
}

export interface MenuEntry {
  /** A section heading. Not focusable. */
  heading?: string;
  label?: string;
  icon?: IconName;
  /** Trailing text: a keyboard shortcut, a count, a hint. */
  meta?: string;
  danger?: boolean;
  /** Renders with the accent, for the currently-applied option in a set. */
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

/**
 * A menu anchored to a trigger.
 *
 * Keyboard handling is the reason this is a component and not a div: arrow keys move
 * between items and Enter activates, which is what people expect the moment a menu opens
 * with focus in it, and what nothing in the previous implementation supported.
 */
export function Menu({
  entries,
  onClose,
  align = "left",
  width,
}: {
  entries: MenuEntry[];
  onClose: () => void;
  align?: "left" | "right";
  width?: number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(-1);
  useDismiss(ref, true, onClose);

  // Indices of the entries a cursor can land on, skipping headings and separators.
  const selectable = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.label && !entry.disabled)
    .map(({ index }) => index);

  const move = useCallback(
    (delta: number) => {
      if (selectable.length === 0) return;
      const at = selectable.indexOf(cursor);
      // Wraps at both ends: Down from the last item returns to the first.
      const next = at < 0 ? (delta > 0 ? 0 : selectable.length - 1) : (at + delta + selectable.length) % selectable.length;
      setCursor(selectable[next] ?? -1);
    },
    [cursor, selectable],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter" && cursor >= 0) {
        event.preventDefault();
        const entry = entries[cursor];
        if (entry?.onSelect) {
          onClose();
          entry.onSelect();
        }
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cursor, entries, move, onClose]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{
        top: "calc(100% + var(--s3))",
        ...(align === "right" ? { right: 0 } : { left: 0 }),
        ...(width ? { minWidth: width } : {}),
      }}
    >
      {entries.map((entry, index) => {
        if (entry.heading) {
          return (
            <div key={`h-${index}`} className="menu__label">
              {entry.heading}
            </div>
          );
        }

        if (!entry.label) return <div key={`s-${index}`} className="menu__sep" role="separator" />;

        return (
          <button
            key={`${entry.label}-${index}`}
            type="button"
            role="menuitem"
            className={`menu__item${entry.danger ? " menu__item--danger" : ""}${
              entry.selected ? " menu__item--on" : ""
            }`}
            data-active={cursor === index ? "true" : undefined}
            disabled={entry.disabled}
            onMouseEnter={() => setCursor(index)}
            onClick={() => {
              onClose();
              entry.onSelect?.();
            }}
          >
            {entry.icon ? <Icon name={entry.icon} size={14} className="menu__icon" /> : null}
            <span className="truncate">{entry.label}</span>
            {entry.meta ? <span className="menu__meta">{entry.meta}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A trigger that owns its menu's open state.
 *
 * Saves every call site from declaring the same `useState`, ref and dismiss wiring, the
 * repetition that let the old top bar grow three near-identical dropdown implementations
 * that behaved subtly differently.
 */
export function MenuTrigger({
  entries,
  align,
  width,
  children,
}: {
  entries: MenuEntry[];
  align?: "left" | "right";
  width?: number;
  children: (props: { open: boolean; toggle: () => void }) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      {children({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <Menu
          entries={entries}
          onClose={() => setOpen(false)}
          {...(align ? { align } : {})}
          {...(width ? { width } : {})}
        />
      ) : null}
    </div>
  );
}
