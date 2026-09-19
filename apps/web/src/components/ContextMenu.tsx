import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Icon, type IconName } from "../ui";

/**
 * Right-click menu.
 *
 * The counterpart to in-place editing: typing handles the common changes, this covers
 * everything else without sending the user to a panel. It flips away from the viewport
 * edges, because a menu that opens half off-screen is worse than no menu.
 */

export interface MenuItem {
  /** A separator when both label and heading are absent. */
  label?: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** A non-interactive section heading. */
  heading?: string;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.min(x, window.innerWidth - width - margin),
      top: Math.min(y, window.innerHeight - height - margin),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    function onDown(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    // Capture phase, so the menu closes even when the click lands on something that
    // stops propagation.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx" style={position} role="menu">
      {items.map((item, index) => {
        if (item.heading) {
          return (
            <div key={`heading-${index}`} className="ctx__label">
              {item.heading}
            </div>
          );
        }
        if (!item.label) return <div key={`sep-${index}`} className="ctx__sep" />;

        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            className={`ctx__item${item.danger ? " ctx__item--danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : <span style={{ width: 14 }} />}
            <span>{item.label}</span>
            {item.hint ? <span className="ctx__hint">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
