import { useCallback, useEffect, useId, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { IconButton } from "./Button";

/**
 * A modal dialog.
 *
 * Everything here exists because the previous hand-rolled overlays did not do it, and
 * each omission is something a user hits within a minute:
 *
 *   - **Escape closes.** Universal, and its absence makes a dialog feel like a trap.
 *   - **Focus moves in on open and back on close.** Without the return, dismissing a
 *     dialog dumps keyboard focus on `<body>` and the next Tab starts from the top of
 *     the page.
 *   - **Focus is trapped.** Tab must cycle within the dialog. Otherwise Tab walks
 *     behind the scrim into controls the user cannot see, which is completely
 *     disorienting with a screen reader.
 *   - **Background scroll is locked.** Scrolling the page under a modal is the classic
 *     tell of an overlay bolted on rather than designed.
 *   - **`aria-modal` + `aria-labelledby`.** Announces as a dialog with a name, instead
 *     of as an anonymous group of controls.
 *
 * The scrim closes on *mousedown* rather than click. A click fires on mouseup, so
 * selecting text inside the dialog and releasing outside it would dismiss and discard
 * whatever was being edited.
 */

type Size = "sm" | "md" | "lg" | "xl";

interface Props {
  title: string;
  /** One line under the title, for context the title cannot carry. */
  subtitle?: ReactNode;
  size?: Size;
  onClose: () => void;
  /** Footer content, typically the action buttons. */
  footer?: ReactNode;
  /** Set false for a dialog with unsaved work, so a stray click cannot discard it. */
  dismissible?: boolean;
  children: ReactNode;
}

const SIZE: Record<Size, string> = {
  sm: " dialog--sm",
  md: "",
  lg: " dialog--lg",
  xl: " dialog--xl",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  subtitle,
  size = "md",
  onClose,
  footer,
  dismissible = true,
  children,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Remember what was focused before we steal it, so it can be handed back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;

    /*
     * Focus the first control, not the dialog itself.
     *
     * Preferring an input means a dialog whose job is "type a branch name" is ready to
     * type into. Falling back to the container keeps focus inside the trap for a dialog
     * that is purely informational.
     */
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();

    return () => previous?.focus?.();
  }, []);

  // Lock background scroll, restoring whatever the page had rather than assuming "auto".
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }

      if (event.key !== "Tab") return;

      const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        // A control scrolled out of view is still focusable; one that is `display: none`
        // is not, and browsers disagree about which. Measuring is the reliable test.
        (element) => element.offsetParent !== null,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      // Wrap at both ends. Without this, Tab from the last control escapes the dialog.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [close]);

  return (
    <div className="scrim" onMouseDown={close}>
      <div
        ref={ref}
        className={`dialog${SIZE[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Stop clicks inside from reaching the scrim's dismiss handler.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__head">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          {dismissible ? <IconButton icon="close" label="Close" size="sm" onClick={onClose} /> : null}
        </header>

        {subtitle ? <div className="dialog__sub">{subtitle}</div> : null}

        <div className="dialog__body">{children}</div>

        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
