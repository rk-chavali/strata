import type { JSX, ReactNode } from "react";
import { Icon, IconButton, Tabs, type TabItem } from "../ui";

/**
 * The page scaffold every route renders into.
 *
 * A single scaffold is most of why the redesigned app reads as one product rather than as
 * six unrelated screens. The title is always in the same place, tabs are always directly
 * under it, actions are always top-right, and the body is the only region that scrolls.
 *
 * Previously each view invented its own header, the start screen had a hero, the compare
 * view had a toolbar, the rail panels had a 28px title strip, and the canvas had no header
 * at all. Moving between them meant re-learning where you were and where the controls
 * were, which is the concrete form the "things flying around" complaint takes.
 */

interface Props<T extends string> {
  title: ReactNode;
  /** One line under the title. Say what this page is *for*, not what it is called. */
  subtitle?: ReactNode;
  /** Small element beside the title, a tier dot, a badge, a branch name. */
  badge?: ReactNode;
  /** Top-right controls. Primary action last, so it sits closest to the page edge. */
  actions?: ReactNode;
  tabs?: { items: TabItem<T>[]; active: T; onSelect: (id: T) => void };
  /**
   * The scope trail above the title: workspace › domain › model.
   *
   * Harness puts `Account › Organization › Project › Pipelines` here and it does real work
   *, it names every level you passed through and makes each one clickable, so "go back up
   * one" never requires guessing which sidebar item corresponds to where you are. The last
   * entry is the current page and is rendered as plain text rather than a link.
   */
  breadcrumb?: { label: string; onSelect?: () => void }[];
  /**
   * Sibling views of the same object, top-right of the breadcrumb row.
   *
   * Distinct from `tabs`, which switches what you are looking *at* within this page.
   * These switch to a *different page about the same thing*, the way Harness separates
   * `Pipeline Studio | Input Sets | Triggers | Analytics` from the studio's own contents.
   */
  views?: ReactNode;
  /**
   * The centre zone of the title row.
   *
   * Reserved for the one control that decides how the body is rendered, Harness's
   * `VISUAL | YAML`. Centring it is the whole point: it is not an action and it is not
   * page metadata, so putting it in either cluster miscategorises it, which is precisely
   * how five unrelated controls ended up in one undifferentiated strip of grey pills.
   */
  centre?: ReactNode;
  /**
   * Rename the thing this page is about, from its title.
   *
   * A pencil next to the name, as Harness has next to a pipeline's. The alternative, * hunting for a settings dialog to change a name that is on screen and selected, is the
   * gap that made `retail_warehouse` feel like a fixed label rather than something owned.
   */
  onRename?: () => void;
  /** Tag chips under the title, as on a Harness project. */
  tags?: string[];
  /** Small grey facts under the title: id, when it changed, what it derives from. */
  meta?: ReactNode;
  /**
   * Hands the body region to the child with no padding and no scrolling.
   *
   * For the canvas, which manages its own viewport and must fill the region exactly.
   */
  flush?: boolean;
  /** Caps content at a readable measure and centres it. For forms and prose. */
  narrow?: boolean;
  children: ReactNode;
}

export function Page<T extends string>({
  title,
  subtitle,
  badge,
  actions,
  tabs,
  breadcrumb,
  views,
  centre,
  onRename,
  tags,
  meta,
  flush,
  narrow,
  children,
}: Props<T>): JSX.Element {
  return (
    <div className="page">
      <header className={`page__head${tabs ? "" : " page__head--plain"}`}>
        {breadcrumb || views ? (
          <div className="page__scoperow">
            {breadcrumb ? <Breadcrumb entries={breadcrumb} /> : <span />}
            {views ? <div className="page__views">{views}</div> : null}
          </div>
        ) : null}

        {/*
          Three zones, and the middle one is the reason this is not a flex row with
          `margin-left: auto`. Identity, mode and actions are different kinds of thing, and
          giving the mode switch the centre of the header says so without a caption.
        */}
        <div className="page__titlerow">
          <div className="page__heading">
            <h1 className="page__title">
              <span className="truncate">{title}</span>
              {badge}
              {onRename ? (
                <IconButton icon="edit" label="Rename" size="sm" onClick={onRename} />
              ) : null}
            </h1>
            {meta ? <div className="page__meta">{meta}</div> : null}
            {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
            {tags && tags.length > 0 ? (
              <div className="page__tags">
                {tags.map((tag) => (
                  <span key={tag} className="page__tag">
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {centre ? <div className="page__centre">{centre}</div> : null}
          {actions ? <div className="page__actions">{actions}</div> : null}
        </div>

        {tabs ? <Tabs items={tabs.items} active={tabs.active} onSelect={tabs.onSelect} /> : null}
      </header>

      <div
        className={`page__body${flush ? " page__body--flush" : ""}${
          narrow ? " page__body--narrow" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A titled block within a page body.
 *
 * Pages are long, settings, the overview, and an unbroken column of controls has no
 * hierarchy to navigate by. This is deliberately lighter than `Card`: a section groups
 * related content in the flow of a page, where a card is a discrete object you might
 * click.
 */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="stack" style={{ gap: "var(--s5)" }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <h2 style={{ fontSize: "var(--fs-md)", color: "var(--text-1)" }}>{title}</h2>
          {description ? (
            <p className="muted small" style={{ marginTop: "var(--s2)" }}>
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * The scope trail.
 *
 * The final entry is the page you are on, so it is text rather than a link, a breadcrumb
 * whose last crumb navigates to itself teaches people that crumbs do nothing.
 */
function Breadcrumb({
  entries,
}: {
  entries: { label: string; onSelect?: () => void }[];
}): JSX.Element {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {entries.map((entry, index) => (
        <span key={`${entry.label}-${index}`} className="crumbs__item">
          {index > 0 ? <Icon name="chevronRight" size={11} className="crumbs__sep" /> : null}
          {entry.onSelect && index < entries.length - 1 ? (
            <button type="button" className="crumbs__link" onClick={entry.onSelect}>
              {entry.label}
            </button>
          ) : (
            <span className="crumbs__here">{entry.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
