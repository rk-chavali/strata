import type { JSX, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * Non-interactive primitives: badges, callouts, empty states, cards, tabs, spinners.
 *
 * Grouped in one module because each is a handful of lines and they are almost always
 * imported together, a page that shows a callout also shows a badge and an empty state.
 * Splitting them into nine files would be more import lines than component code.
 */

// ---------------------------------------------------------------- badge

type Tone = "neutral" | "accent" | "ok" | "warn" | "err";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "",
  accent: " badge--accent",
  ok: " badge--ok",
  warn: " badge--warn",
  err: " badge--err",
};

export function Badge({
  children,
  tone = "neutral",
  icon,
  outline,
  pill,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
  outline?: boolean;
  pill?: boolean;
  /** Hover text. Needed when the badge is an abbreviation, `M` for modified. */
  title?: string;
}): JSX.Element {
  return (
    <span
      className={`badge${BADGE_TONE[tone]}${outline ? " badge--outline" : ""}${
        pill ? " badge--pill" : ""
      }`}
      {...(title ? { title } : {})}
    >
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

/** A numeric badge. Clamps rather than widening without limit, 2000 problems reads as 99+. */
export function Count({
  value,
  tone = "neutral",
}: {
  value: number;
  tone?: "neutral" | "accent" | "warn" | "err";
}): JSX.Element {
  return (
    <span className={`count${tone === "neutral" ? "" : ` count--${tone}`}`}>
      {value > 99 ? "99+" : value}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: "error" | "warning" | "info" }): JSX.Element {
  return <span className={`sev sev--${severity}`}>{severity}</span>;
}

// ---------------------------------------------------------------- callout

/**
 * Callout tones.
 *
 * Deliberately a different set from `Badge`'s: a callout is always making a *statement
 * about state*, so `info` is the right neutral-but-meaningful default and there is no
 * decorative `accent` variant. A badge labels a thing; a callout tells you something.
 */
type CalloutTone = "neutral" | "info" | "ok" | "warn" | "err";

const CALLOUT_ICON: Record<CalloutTone, IconName> = {
  neutral: "list",
  info: "list",
  ok: "check",
  warn: "warn",
  err: "warn",
};

export function Callout({
  tone = "neutral",
  title,
  children,
  icon,
  actions,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName;
  /** Buttons on the callout. A callout that states a problem should offer the fix. */
  actions?: ReactNode;
}): JSX.Element {
  return (
    /*
      `callout--icon` marks the component form, which is an icon beside a body.

      The bare `callout` class is also used directly in about thirty places with loose text
      inside, and the flex layout this needs turns every text run and every inline `<span>` in
      those into its own column. The layout belongs to the shape that has two children, not to
      the class name they share.
    */
    <div className={`callout callout--icon${tone === "neutral" ? "" : ` callout--${tone}`}`}>
      <span className="callout__icon">
        <Icon name={icon ?? CALLOUT_ICON[tone]} size={14} />
      </span>
      <div className="callout__body">
        {title ? <strong className="callout__title">{title}</strong> : null}
        {children}
        {actions ? (
          <div className="row" style={{ marginTop: "var(--s4)" }}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- empty state

/**
 * What a surface shows when it has nothing.
 *
 * `action` is not optional by accident, see the note in ui.css. An empty state without a
 * next step is a dead end, and dead ends are exactly what makes a tool feel confusing on
 * first run.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  secondary,
  inline,
}: {
  icon: IconName;
  title: string;
  body?: ReactNode;
  /**
   * The way out, when there is one.
   *
   * Optional because some empty states are genuinely terminal: "this model has no tables,
   * so there are no fields to document" has nothing to offer but the explanation. Forcing a
   * button there produces either a dead control or a fake one.
   */
  action?: ReactNode;
  secondary?: ReactNode;
  /** Tighter padding, for an empty state inside a panel rather than a whole page. */
  inline?: boolean;
}): JSX.Element {
  return (
    <div className={`empty${inline ? " empty--inline" : ""}`}>
      <span className="empty__icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="empty__title">{title}</div>
      {body ? <div className="empty__body">{body}</div> : null}
      {/* No actions at all means no row: an empty flex container still eats its gap. */}
      {action || secondary ? (
        <div className="empty__actions">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- card

export function Card({
  title,
  actions,
  footer,
  children,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Set false when the body is a table or list that should reach the card's edges. */
  padded?: boolean;
}): JSX.Element {
  return (
    <section className="card">
      {title ? (
        <header className="card__head">
          <h3 className="card__title grow truncate">{title}</h3>
          {actions}
        </header>
      ) : null}
      <div className={padded ? "card__body" : ""} style={padded ? undefined : { minWidth: 0 }}>
        {children}
      </div>
      {footer ? <footer className="card__foot">{footer}</footer> : null}
    </section>
  );
}

// ---------------------------------------------------------------- tabs

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
  count?: number;
  disabled?: boolean;
}

/**
 * A tab strip.
 *
 * Renders as a real tablist with arrow-key navigation, because tabs that only respond to
 * clicks are one of the most common accessibility failures in dashboards, and one of the
 * easiest to get right.
 */
export function Tabs<T extends string>({
  items,
  active,
  onSelect,
}: {
  items: TabItem<T>[];
  active: T;
  onSelect: (id: T) => void;
}): JSX.Element {
  function onKeyDown(event: React.KeyboardEvent): void {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();

    const usable = items.filter((item) => !item.disabled);
    const at = usable.findIndex((item) => item.id === active);
    const next = usable[(at + delta + usable.length) % usable.length];
    if (next) onSelect(next.id);
  }

  return (
    <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={item.id === active}
          // Only the active tab is in the tab order; arrows move between them. This is
          // the documented pattern, and it stops a 9-tab strip costing 9 presses to skip.
          tabIndex={item.id === active ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onSelect(item.id)}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : null}
          {item.label}
          {item.count !== undefined && item.count > 0 ? <Count value={item.count} /> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- segmented

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string; icon?: IconName; title?: string }[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__btn"
          aria-pressed={option.value === value}
          {...(option.title ? { title: option.title } : {})}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={13} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- loading

export function Spinner({ large }: { large?: boolean }): JSX.Element {
  return <span className={`spinner${large ? " spinner--lg" : ""}`} aria-hidden="true" />;
}

/**
 * A loading placeholder shaped like the content it stands in for.
 *
 * `rows` draws a list; the widths taper so it reads as text rather than as a stack of
 * identical bars.
 */
export function Skeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  const widths = ["92%", "78%", "85%", "64%", "88%", "72%"];
  return (
    <div aria-hidden="true" style={{ padding: "var(--s5)" }}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="skeleton skeleton--text"
          style={{ width: widths[index % widths.length] }}
        />
      ))}
    </div>
  );
}

/** Centred loading state for a whole page or panel. */
export function Loading({ label = "Loading…" }: { label?: string }): JSX.Element {
  return (
    <div className="empty" role="status">
      <Spinner large />
      <div className="empty__body">{label}</div>
    </div>
  );
}
