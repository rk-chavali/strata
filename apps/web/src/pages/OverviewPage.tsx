import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Page } from "../app/Page";
import { linkProps, type Router } from "../app/routes";
import { useWorkspace } from "../app/WorkspaceContext";
import { Badge, Button, EmptyState, Icon, type IconName } from "../ui";
import type { HistorySummaryEntry, ModelView, Tier } from "../types";

/**
 * The workspace dashboard, the first screen anyone sees.
 *
 * Two rewrites happened here. The first fixed the *information order*: a "Finish setting up"
 * checklist permanently stuck at 4 of 5 sat in the best space on the page, the only urgent thing
 * on the screen was buried below it, and the same inventory appeared three times.
 *
 * This one fixes the fact that the page had **no graphics at all** while the rest of the product
 * does. Models renders activity as squares, tier as a pill, authorship as an avatar; the studio
 * is a canvas. Arriving at a flat wall of grey text from either of those reads as an unfinished
 * page, and for a *data modelling* tool, a home screen that never shows the shape of the model
 * is a wasted first impression.
 *
 * Every graphic here is driven by data the workspace already has, and each answers a question a
 * list of numbers cannot:
 *
 *   - **The tier bar** is the identity graphic. Conceptual → logical → physical is the spine of
 *     the product, and its proportions answer "is the physical layer keeping up with the design?"
 *     at a glance. Numbers in a table do not.
 *   - **Composition** says what kind of workspace this is, mostly tables, or mostly glossary and
 *     concepts, which is the difference between a warehouse project and a governance one.
 *   - **The activity chart** gives the page a sense of *time*, which it previously had none of.
 *   - **Domain rails** show which tiers a domain actually has, so a half-finished domain is
 *     visible without opening it.
 *
 * Nothing here is decorative. A chart of nothing would be exactly the filler this replaces.
 */

const TIER_ORDER: Tier[] = ["conceptual", "logical", "physical"];

const TIER_LABEL: Record<Tier, string> = {
  conceptual: "Conceptual",
  logical: "Logical",
  physical: "Physical",
};

const UNGROUPED = "Ungrouped";

/** How many weeks the activity chart covers. A quarter, long enough to show a lull. */
const ACTIVITY_WEEKS = 12;

interface Props {
  router: Router;
  onNewModel: () => void;
  onImport: () => void;
  onPropose: () => void;
}

export function OverviewPage({ router, onNewModel, onImport, onPropose }: Props): JSX.Element {
  const { workspace, git, gitLoaded, canEdit, refreshKey } = useWorkspace();
  const [activity, setActivity] = useState<HistorySummaryEntry[] | undefined>();

  /**
   * Recent history, workspace-wide.
   *
   * Fetched separately from the workspace because it is the one thing on this page that is
   * about *time* rather than state, and it is allowed to fail quietly: a workspace that is not
   * a git repository still has a perfectly good dashboard, just without this section.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .historySummary()
      .then((result) => {
        if (cancelled) return;
        /*
          The summary is keyed by model, so the same merge appears under every model it touched.
          Flattened and deduplicated by sha, newest first, a feed that listed one commit three
          times because it changed three models would be worse than no feed.
        */
        const bySha = new Map<string, HistorySummaryEntry>();
        for (const entries of Object.values(result.byModel)) {
          for (const entry of entries) bySha.set(entry.sha, entry);
        }
        setActivity(
          [...bySha.values()].sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const domains = useMemo(() => {
    const grouped = new Map<string, ModelView[]>();
    for (const model of workspace?.models ?? []) {
      const key = model.namespace ?? UNGROUPED;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(model);
      else grouped.set(key, [model]);
    }
    for (const [, models] of grouped) {
      models.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [workspace?.models]);

  const models = useMemo(() => workspace?.models ?? [], [workspace?.models]);

  /** Objects per tier, for the identity graphic. */
  const byTier = useMemo(() => tierTotals(models), [models]);

  /**
   * Objects by kind, merged across every model.
   *
   * Model-scoped `counts` deliberately exclude workspace-shared objects (attribute types,
   * glossary terms, naming standards), so this total is smaller than the workspace count. The
   * panel is headed "Composition" rather than a count, so it does not imply otherwise.
   */
  const byKind = useMemo(() => {
    const totals = new Map<string, number>();
    for (const model of models) {
      for (const [kind, value] of Object.entries(model.counts ?? {})) {
        totals.set(kind, (totals.get(kind) ?? 0) + value);
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [models]);

  if (!workspace) return <Page title="Overview">{null}</Page>;

  const errorCount = workspace.diagnostics.error;
  const warningCount = workspace.diagnostics.warning;
  const changeCount = git?.files.length ?? 0;
  /*
    The workspace's own count, not the sum of the models'.

    Summing `objectCount` across models undercounts, because shared objects, attribute types,
    glossary terms, naming standards, belong to no model. On the example workspace that showed
    "31 objects" in the header while the status bar said 48, which makes the page look wrong even
    though both numbers were individually true.
  */
  const objectCount = workspace.objectCount;

  return (
    <Page
      title={workspace.name || "Workspace"}
      subtitle={
        <>
          <span>
            {count(workspace.models.length, "model")} · {count(domains.length, "domain")} ·{" "}
            {count(objectCount, "object")}
          </span>
          {/*
            The separator is text, not a sibling element. `.page__subtitle` is an inline text
            container with no gap, so two adjacent spans render flush, which is how
            "31 objects·model/20260809-zjkg" happened.
          */}
          {git?.branch ? (
            <>
              {" · "}
              <span className="mono">{git.branch}</span>
            </>
          ) : null}
        </>
      }
      actions={
        canEdit ? (
          <>
            <Button icon="upload" onClick={onImport}>
              Import
            </Button>
            <Button variant="primary" icon="plus" onClick={onNewModel}>
              New model
            </Button>
          </>
        ) : null
      }
    >
      {workspace.models.length === 0 ? (
        <EmptyState
          icon="layers"
          title="Nothing modelled yet"
          body="Start from scratch, or bring in an existing schema from a DDL script, an erwin export or a spreadsheet."
          action={
            canEdit ? (
              <Button variant="primary" icon="plus" onClick={onNewModel}>
                New model
              </Button>
            ) : undefined
          }
          secondary={
            canEdit ? (
              <Button icon="upload" onClick={onImport}>
                Import a schema
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="ov">
          <Attention
            router={router}
            errorCount={errorCount}
            warningCount={warningCount}
            changeCount={changeCount}
            canEdit={canEdit}
            onPropose={onPropose}
          />

          <Pulse
            objectCount={objectCount}
            byTier={byTier}
            byKind={byKind}
            activity={activity}
            errorCount={errorCount}
            warningCount={warningCount}
          />

          <div className="ov__split">
            <section className="ov__main">
              <h2 className="ov__h">Domains</h2>
              <div className="ov__domains">
                {domains.map(([name, group]) => (
                  <DomainCard key={name} name={name} models={group} router={router} />
                ))}
              </div>
            </section>

            <Activity
              entries={activity}
              router={router}
              gitLoaded={gitLoaded}
              isRepo={git?.isRepo === true}
            />
          </div>

          <Setup workspace={workspace} git={git} gitLoaded={gitLoaded} />
        </div>
      )}
    </Page>
  );
}

/** Objects per tier, summed across the models at that tier. */
function tierTotals(models: readonly ModelView[]): { tier: Tier; count: number }[] {
  return TIER_ORDER.map((tier) => ({
    tier,
    count: models.filter((model) => model.tier === tier).reduce((sum, m) => sum + m.objectCount, 0),
  }));
}

/**
 * The masthead: what this workspace *is*, in three panels.
 *
 * Placed under Attention rather than above it, because "something is broken" outranks "here is
 * the shape of things", but above the domain list, because it is the fastest answer to "what am
 * I looking at" for someone who has just opened the tool.
 */
function Pulse({
  objectCount,
  byTier,
  byKind,
  activity,
  errorCount,
  warningCount,
}: {
  objectCount: number;
  byTier: { tier: Tier; count: number }[];
  byKind: [string, number][];
  activity: HistorySummaryEntry[] | undefined;
  errorCount: number;
  warningCount: number;
}): JSX.Element {
  return (
    <section className="pulse">
      <article className="pulse__panel">
        <h3 className="pulse__h">Model</h3>
        <p className="pulse__big">
          {objectCount}
          <span className="pulse__bigunit">objects</span>
        </p>
        <TierBar totals={byTier} />
        <ul className="pulse__legend">
          {byTier.map(({ tier, count: value }) => (
            <li key={tier}>
              <span className={`dot dot--${tier}`} />
              <span className="pulse__legendname">{TIER_LABEL[tier]}</span>
              <span className="pulse__legendvalue">{value}</span>
            </li>
          ))}
        </ul>
      </article>

      <article className="pulse__panel">
        <h3 className="pulse__h">Composition</h3>
        <Composition byKind={byKind} />
      </article>

      <article className="pulse__panel">
        <h3 className="pulse__h">Last {ACTIVITY_WEEKS} weeks</h3>
        <ActivityChart entries={activity} />
        <Contributors entries={activity} />
        {/*
          Health sits in this panel rather than getting its own, because it is a two-number
          answer and a whole panel for two numbers is how dashboards get padded.
        */}
        <p className="pulse__health">
          {errorCount === 0 && warningCount === 0 ? (
            <>
              <Icon name="check" size={12} className="pulse__healthok" />
              No problems
            </>
          ) : (
            <>
              {errorCount > 0 ? (
                <span className="pulse__healtherr">{count(errorCount, "error")}</span>
              ) : null}
              {errorCount > 0 && warningCount > 0 ? " · " : null}
              {warningCount > 0 ? (
                <span className="pulse__healthwarn">{count(warningCount, "warning")}</span>
              ) : null}
            </>
          )}
        </p>
      </article>
    </section>
  );
}

/**
 * The tier bar.
 *
 * A single stacked bar rather than three separate ones, because the interesting quantity is the
 * *ratio*: a physical layer far smaller than the logical design means the design has run ahead of
 * what was built, and that only reads when the segments share a baseline.
 *
 * Tiers with no objects still render a hairline segment so the tier is visibly absent rather than
 * silently missing, an empty conceptual layer is a fact about the workspace, not a rendering gap.
 */
function TierBar({ totals }: { totals: { tier: Tier; count: number }[] }): JSX.Element {
  const total = totals.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div
      className="tbar"
      role="img"
      aria-label={totals.map((entry) => `${TIER_LABEL[entry.tier]} ${entry.count}`).join(", ")}
    >
      {totals.map(({ tier, count: value }) => (
        <span
          key={tier}
          className={`tbar__seg tbar__seg--${tier}${value === 0 ? " is-empty" : ""}`}
          style={{ flexGrow: total > 0 ? value : 1 }}
          title={`${TIER_LABEL[tier]}: ${value} object${value === 1 ? "" : "s"}`}
        />
      ))}
    </div>
  );
}

/** Friendly names for object kinds. Anything unlisted is de-camelCased rather than shown raw. */
const KIND_LABEL: Record<string, string> = {
  table: "Tables",
  entity: "Entities",
  concept: "Concepts",
  relationship: "Relationships",
  mapping: "Mappings",
  diagram: "Diagrams",
  glossaryTerm: "Glossary terms",
  subjectArea: "Subject areas",
  domain: "Domains",
  attributeType: "Attribute types",
  namingStandard: "Naming standards",
  model: "Models",
};

function kindLabel(kind: string): string {
  const known = KIND_LABEL[kind];
  if (known) return known;
  const spaced = kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}s`;
}

/**
 * What kinds of thing this workspace is made of.
 *
 * Bars are scaled against the *largest* kind, not the total. Against the total, a workspace with
 * forty tables and two diagrams renders the diagrams as an invisible sliver, which loses the
 * only thing the row was there to say, that they exist.
 */
function Composition({ byKind }: { byKind: [string, number][] }): JSX.Element {
  const shown = byKind.slice(0, 6);
  const peak = shown.reduce((most, [, value]) => Math.max(most, value), 0);

  if (shown.length === 0) {
    return <p className="pulse__quiet">No objects inside models yet.</p>;
  }

  return (
    <ul className="comp">
      {shown.map(([kind, value]) => (
        <li key={kind} className="comp__row">
          <span className="comp__name truncate">{kindLabel(kind)}</span>
          <span className="comp__track">
            <span
              className="comp__fill"
              style={{ width: `${peak > 0 ? Math.max(4, (value / peak) * 100) : 0}%` }}
            />
          </span>
          <span className="comp__value">{value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Commits per week, oldest left.
 *
 * Columns rather than the square-per-change vocabulary the models list uses: those squares are
 * per-model and cap out at a handful, whereas this is workspace-wide over a quarter and needs a
 * shape rather than a count. Both are honest about the same underlying data.
 */
function ActivityChart({ entries }: { entries: HistorySummaryEntry[] | undefined }): JSX.Element {
  const weeks = useMemo(() => {
    const buckets = Array.from({ length: ACTIVITY_WEEKS }, () => 0);
    if (!entries) return buckets;

    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      const at = new Date(entry.date).getTime();
      if (!Number.isFinite(at)) continue;
      const index = ACTIVITY_WEEKS - 1 - Math.floor((now - at) / week);
      // Anything older than the window is dropped rather than piled into the first column,
      // which would invent a spike that never happened.
      if (index >= 0 && index < ACTIVITY_WEEKS) buckets[index] = (buckets[index] ?? 0) + 1;
    }
    return buckets;
  }, [entries]);

  const peak = Math.max(1, ...weeks);
  const total = weeks.reduce((sum, value) => sum + value, 0);

  if (entries === undefined) return <div className="achart achart--loading" aria-hidden />;

  return (
    <>
      <div
        className="achart"
        role="img"
        aria-label={`${total} change(s) in the last ${ACTIVITY_WEEKS} weeks`}
      >
        {weeks.map((value, index) => (
          <span
            key={index}
            className={`achart__col${value === 0 ? " is-zero" : ""}`}
            /* A floor so an empty week is still a visible tick on the baseline. */
            style={{ height: `${value === 0 ? 4 : Math.max(14, (value / peak) * 100)}%` }}
            title={`${weeksAgo(ACTIVITY_WEEKS - 1 - index)}: ${value} change${value === 1 ? "" : "s"}`}
          />
        ))}
      </div>
      <p className="pulse__sub">{count(total, "change")}</p>
    </>
  );
}

function weeksAgo(offset: number): string {
  if (offset === 0) return "This week";
  if (offset === 1) return "Last week";
  return `${offset} weeks ago`;
}

/**
 * Who has touched the model.
 *
 * Same initial-in-a-circle treatment the models list uses for "last change", so the two pages
 * read as one product. Capped at five with an overflow count, a stack of twenty circles stops
 * being a fact and becomes a texture.
 */
function Contributors({
  entries,
}: {
  entries: HistorySummaryEntry[] | undefined;
}): JSX.Element | null {
  const people = useMemo(() => {
    const seen = new Map<string, number>();
    for (const entry of entries ?? []) seen.set(entry.author, (seen.get(entry.author) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  if (people.length === 0) return null;

  return (
    <div className="people">
      {people.slice(0, 5).map(([name, changes]) => (
        <span key={name} className="people__one" title={`${name}, ${count(changes, "change")}`}>
          {name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {people.length > 5 ? <span className="people__more">+{people.length - 5}</span> : null}
    </div>
  );
}

/**
 * Anything that needs a person, and nothing else.
 *
 * Renders nothing at all when the workspace is clean. That is the difference between a
 * dashboard and a status bar: a permanently-present "0 problems" panel is a thing people learn
 * to skip, and then miss when it says 2.
 */
function Attention({
  router,
  errorCount,
  warningCount,
  changeCount,
  canEdit,
  onPropose,
}: {
  router: Router;
  errorCount: number;
  warningCount: number;
  changeCount: number;
  canEdit: boolean;
  onPropose: () => void;
}): JSX.Element | null {
  const items: JSX.Element[] = [];

  if (errorCount > 0) {
    items.push(
      <a key="errors" className="ov__alert ov__alert--err" {...linkProps(router, { name: "problems" })}>
        <Icon name="warn" size={15} />
        <span className="ov__alerttext">
          <strong>
            {count(errorCount, "validation error")} {errorCount === 1 ? "blocks" : "block"} merging
          </strong>
          <span>`strata check` would fail on this branch, so a pull request from here cannot merge.</span>
        </span>
        <Icon name="chevronRight" size={13} className="ov__alertgo" />
      </a>,
    );
  }

  if (changeCount > 0) {
    items.push(
      <div key="changes" className="ov__alert">
        <Icon name="branch" size={15} />
        <span className="ov__alerttext">
          <strong>{count(changeCount, "changed file")} not yet proposed</strong>
          <span>Edits live on this branch until you open a pull request.</span>
        </span>
        <span className="ov__alertactions">
          <Button size="sm" {...linkProps(router, { name: "changes" })}>
            Review
          </Button>
          {canEdit ? (
            <Button size="sm" variant="primary" icon="pr" onClick={onPropose}>
              Propose
            </Button>
          ) : null}
        </span>
      </div>,
    );
  }

  /*
    Warnings are mentioned only when there is nothing more urgent.

    They do not block anything, so leading with them next to an error would flatten the
    difference between "fix this before you merge" and "worth tidying up".
  */
  if (items.length === 0 && warningCount > 0) {
    items.push(
      <a key="warnings" className="ov__alert ov__alert--warn" {...linkProps(router, { name: "problems" })}>
        <Icon name="shield" size={15} />
        <span className="ov__alerttext">
          <strong>{count(warningCount, "warning")}</strong>
          <span>Nothing is blocked. Worth a look when you have a moment.</span>
        </span>
        <Icon name="chevronRight" size={13} className="ov__alertgo" />
      </a>,
    );
  }

  if (items.length === 0) return null;
  return <section className="ov__attention">{items}</section>;
}

/**
 * What happened, most recent first.
 *
 * The section the old page was missing entirely. A model is edited by several people through
 * pull requests, so "has anything changed since I was last here" is the first thing a returning
 * user wants, and it was unanswerable without opening a model and finding its History tab.
 */
function Activity({
  entries,
  router,
  gitLoaded,
  isRepo,
}: {
  entries: HistorySummaryEntry[] | undefined;
  router: Router;
  gitLoaded: boolean;
  isRepo: boolean;
}): JSX.Element {
  return (
    <section className="ov__side">
      <h2 className="ov__h">
        Recent activity
        {entries && entries.length > 0 ? (
          <a className="ov__more" {...linkProps(router, { name: "changes" })}>
            All changes
          </a>
        ) : null}
      </h2>

      {/* Absent until git has answered, so a slow first load does not flash "not a repository". */}
      {!gitLoaded || entries === undefined ? (
        <p className="ov__quiet">Loading…</p>
      ) : !isRepo ? (
        <p className="ov__quiet">
          This workspace is not a git repository yet, so there is no history to show. Model files
          are still saved normally.
        </p>
      ) : entries.length === 0 ? (
        <p className="ov__quiet">No commits yet. The first proposal will show up here.</p>
      ) : (
        <ol className="ov__feed">
          {entries.slice(0, 7).map((entry) => (
            <li key={entry.sha} className="ov__event">
              <span className="ov__eventavatar">{entry.author.slice(0, 1).toUpperCase()}</span>
              <span className="ov__eventbody">
                <span className="ov__eventtop">
                  <span className="ov__subject truncate">{entry.subject}</span>
                  {entry.pullRequest ? (
                    entry.pullRequestUrl ? (
                      <a
                        className="ov__pr"
                        href={entry.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        #{entry.pullRequest}
                      </a>
                    ) : (
                      <span className="ov__pr">#{entry.pullRequest}</span>
                    )
                  ) : (
                    /* A commit straight onto the branch, with no PR behind it. Worth marking:
                       it is the one change nobody reviewed. */
                    <Badge tone="warn" title="Committed directly, without a pull request">
                      direct
                    </Badge>
                  )}
                </span>
                <span className="ov__eventmeta">
                  {entry.author} · {relative(entry.date)} ·{" "}
                  <span className="mono">{entry.shortSha}</span>
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * One business domain, with a way in.
 *
 * The old cards listed tiers and counts and offered nothing to do with them. Each tier is now a
 * link straight to its studio, the row carries the problem count, because "which of these is
 * broken" is the question a list of domains should answer before you have to click, and the
 * rail shows the domain's own tier proportions, so a domain whose physical layer has run ahead
 * of its logical design is visible without opening anything.
 */
function DomainCard({
  name,
  models,
  router,
}: {
  name: string;
  models: ModelView[];
  router: Router;
}): JSX.Element {
  const objectCount = models.reduce((sum, model) => sum + model.objectCount, 0);
  const errors = models.reduce((sum, model) => sum + model.problems.error, 0);
  const warnings = models.reduce((sum, model) => sum + model.problems.warning, 0);
  const missing = TIER_ORDER.filter((tier) => !models.some((model) => model.tier === tier));

  return (
    <article className="dcard">
      <header className="dcard__head">
        <a
          className="dcard__name"
          {...linkProps(router, { name: "domain", domain: name, tab: "overview" })}
        >
          <Icon name="folder" size={14} />
          {name}
        </a>
        {errors > 0 ? (
          <Badge tone="err" title={`${errors} validation error(s) in this domain`}>
            {errors}
          </Badge>
        ) : warnings > 0 ? (
          <Badge tone="warn" title={`${warnings} warning(s) in this domain`}>
            {warnings}
          </Badge>
        ) : null}
        <span className="grow" />
        <span className="dcard__count">{count(objectCount, "object")}</span>
      </header>

      <TierBar totals={tierTotals(models)} />

      <div className="dcard__tiers">
        {TIER_ORDER.map((tier) => {
          const model = models.find((entry) => entry.tier === tier);

          if (!model) {
            /*
              A missing tier is rendered, not omitted.

              Omitting it makes a domain with only a physical model look complete. Naming the gap
              is the more useful default: "no conceptual model" may be a deliberate decision, but
              it is also the most common thing a half-finished domain is missing.
            */
            return (
              <span
                key={tier}
                className="dcard__tier is-missing"
                title={`No ${TIER_LABEL[tier].toLowerCase()} model`}
              >
                <span className={`dot dot--${tier}`} />
                <span className="dcard__tiername truncate">{TIER_LABEL[tier]}</span>
                <span className="dcard__tiercount">-</span>
              </span>
            );
          }

          return (
            <a
              key={tier}
              className="dcard__tier"
              {...linkProps(router, { name: "model", model: model.name, tab: "diagram" })}
              title={`Open ${model.name}`}
            >
              <span className={`dot dot--${tier}`} />
              <span className="dcard__tiername truncate">{TIER_LABEL[tier]}</span>
              <span className="dcard__tiercount">{model.objectCount}</span>
            </a>
          );
        })}
      </div>

      {missing.length > 0 ? (
        <p className="dcard__missing">
          No {missing.map((tier) => TIER_LABEL[tier].toLowerCase()).join(" or ")} model yet.
        </p>
      ) : null}
    </article>
  );
}

/**
 * Setup, reduced to one line when it can never be finished.
 *
 * The checklist still exists, on a genuinely fresh install it is the difference between "is
 * this working?" and "two steps to go". But `STRATA_AUTH=off` is a deliberate choice for local
 * work, not an unfinished step, so once it is the only thing left the whole section becomes a
 * single sentence stating the consequence.
 */
function Setup({
  workspace,
  git,
  gitLoaded,
}: {
  workspace: NonNullable<ReturnType<typeof useWorkspace>["workspace"]>;
  git: ReturnType<typeof useWorkspace>["git"];
  gitLoaded: boolean;
}): JSX.Element | null {
  if (!gitLoaded) return null;

  const isRepo = git?.isRepo === true;
  const hasRemote = Boolean(git?.remoteUrl);
  const hasModels = workspace.models.length > 0;

  const open = [
    ...(isRepo ? [] : [{ label: "Make the workspace a git repository", why: "Nothing is versioned or reviewable until it is." }]),
    ...(isRepo && !hasRemote
      ? [{ label: "Configure a git remote", why: "Needed to open pull requests and share the model." }]
      : []),
    ...(hasModels ? [] : [{ label: "Create or import a model", why: "There is nothing to model against yet." }]),
  ];

  if (open.length === 0) {
    return (
      <p className="ov__setupline">
        <Icon name="check" size={12} />
        Set up: git repository{hasRemote ? ", remote" : ""}, {count(workspace.models.length, "model")}.
        {/*
          Stated as a fact with its consequence, not as an unticked box. Someone running this
          locally has not forgotten to enable auth; they chose not to.
        */}
        <span className="ov__setupnote">
          Authentication is off, so anyone who can reach this port can edit. Fine locally, not on
          a shared network.
        </span>
      </p>
    );
  }

  return (
    <section className="ov__setup">
      <h2 className="ov__h">Finish setting up</h2>
      <ul className="ov__todo">
        {open.map((item) => (
          <li key={item.label}>
            <Icon name="minus" size={12} />
            <span>
              <strong>{item.label}</strong>
              <span className="ov__quiet"> {item.why}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `1 object`, `2 objects`, the pluralisation the old page got wrong. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * "3 hours ago".
 *
 * An absolute timestamp answers "when exactly", which nobody asks on a dashboard. The question
 * is "recently or not", and a relative time answers it without arithmetic.
 */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Kept for the icon map used elsewhere on the page. */
export const OVERVIEW_ICON: IconName = "grid";
