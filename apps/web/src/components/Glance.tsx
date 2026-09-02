import type { JSX } from "react";
import { Icon } from "../ui";
import { linkProps, type Route, type Router } from "../app/routes";

/**
 * A row of counts, each one a way in.
 *
 * The pattern Harness opens a project with: `Services 9 · Environments 4 · Pipelines 36`, where
 * the number is the link. Two things make it work, and both are easy to lose. The counts are the
 * *first* thing on the page, so "what is in here" is answered before anything asks you to act;
 * and every count navigates, so reading one never leaves you hunting for the list behind it.
 *
 * A count with nowhere to go is rendered as plain text rather than a dead link, an underline
 * that does nothing costs more trust than a number that never claimed to be clickable.
 */

export interface GlanceItem {
  label: string;
  value: number;
  /** Where the number leads. Omit for a count that is a fact rather than a destination. */
  route?: Route;
  /** One short line under the value, for the context the number needs. */
  hint?: string;
  /** Colours the value. Use sparingly, everything accented is nothing accented. */
  tone?: "neutral" | "err" | "warn" | "accent";
}

export function Glance({
  items,
  router,
  title = "At a glance",
}: {
  items: GlanceItem[];
  router: Router;
  /** Pass an empty string to render the cards with no heading. */
  title?: string;
}): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <section className="stack">
      {title ? <h2 className="glance__title">{title}</h2> : null}

      <div className="glance">
        {items.map((item) =>
          item.route ? (
            <a
              key={item.label}
              className="glance__card glance__card--link"
              {...linkProps(router, item.route)}
            >
              <Body item={item} />
              <Icon name="chevronRight" size={12} className="glance__go" />
            </a>
          ) : (
            <div key={item.label} className="glance__card">
              <Body item={item} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function Body({ item }: { item: GlanceItem }): JSX.Element {
  return (
    <>
      <span className="glance__label">{item.label}</span>
      <span className={`glance__value${item.tone && item.tone !== "neutral" ? ` glance__value--${item.tone}` : ""}`}>
        {item.value}
      </span>
      {item.hint ? <span className="glance__hint">{item.hint}</span> : null}
    </>
  );
}
