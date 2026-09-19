import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import { linkProps, type Router } from "../app/routes";
import {
  Badge,
  Button,
  Count,
  EmptyState,
  Icon,
  IconButton,
  Input,
  MenuTrigger,
  Segmented,
  type MenuEntry,
} from "../ui";
import { ModelSettingsDialog } from "../components/ModelSettingsDialog";
import type { HistorySummaryEntry, ModelView, Tier } from "../types";

/**
 * Every model in the workspace, grouped by domain.
 *
 * **Why grouped and not a flat table with a domain column.** A column tells you which domain
 * each row belongs to; a group tells you what the domains *are*. Those are different
 * questions, and at three hundred models across twenty domains the second one is the one
 * being asked, you arrive here to find a domain, then a model within it. A sortable column
 * also lets a sort scatter one domain's models across the whole page, which is exactly the
 * arrangement that makes a derivation chain unreadable.
 *
 * Groups collapse, and the state persists, because twenty collapsed domains is a table of
 * contents and twenty expanded ones is the wall of rows this replaced.
 *
 * **Why this is a page and not the sidebar tree it replaced.** The sidebar nested
 * domain → tier and listed every model in a 248px column. That reads fine with four and
 * fails completely at the scale the tool is for. A set that large needs search, filters and
 * sort, which is a page, the same relationship Harness has between its sidebar and its
 * pipeline list, and Harness has thirty-four pipelines and puts none of them in its sidebar.
 */

const TIER_LABEL: Record<Tier, string> = {
  conceptual: "Conceptual",
  logical: "Logical",
  physical: "Physical",
};

const TIER_ORDER: Tier[] = ["conceptual", "logical", "physical"];

const UNGROUPED = "Ungrouped";

type Sort = "tier" | "name" | "objects";

const COLLAPSED_KEY = "strata.models.collapsed";

export function ModelsPage({
  router,
  onNewModel,
  onImport,
}: {
  router: Router;
  onNewModel: () => void;
  onImport: () => void;
}): JSX.Element {
  const { workspace, canEdit, refresh, refreshKey } = useWorkspace();
  const models = workspace?.models ?? [];

  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<string>("");
  const [sort, setSort] = useState<Sort>("tier");
  const [editing, setEditing] = useState<ModelView | undefined>();

  /**
   * Recent changes for every model, fetched once.
   *
   * One request for the page rather than one per row: a row-level fetch would mean three
   * hundred requests and three hundred `git log` processes to draw one list. `undefined`
   * means still loading, which the squares render as a placeholder rather than as "no
   * changes", those are different facts and showing one as the other is a lie.
   */
  const [changes, setChanges] = useState<Record<string, HistorySummaryEntry[]> | undefined>();

  useEffect(() => {
    let cancelled = false;
    api
      .historySummary()
      .then((result) => {
        if (!cancelled) setChanges(result.byModel);
      })
      .catch(() => {
        // No repo, or no git. The rows simply show no changes; the page still works.
        if (!cancelled) setChanges({});
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  /**
   * Which domains are collapsed, persisted.
   *
   * Someone who collapsed eighteen of twenty domains to concentrate on two has expressed a
   * working preference, and making them redo it on every navigation would teach them not to
   * bother collapsing at all.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_KEY);
      return new Set<string>(stored ? (JSON.parse(stored) as string[]) : []);
    } catch {
      // A corrupt or unreadable preference is not worth failing a page load over.
      return new Set<string>();
    }
  });

  function toggleDomain(domain: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const domainNames = useMemo(
    () => [...new Set(models.map((model) => model.namespace).filter(Boolean))] as string[],
    [models],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return models.filter((model) => {
      if (tier && model.tier !== tier) return false;
      if (!needle) return true;
      /**
       * Search covers the domain and the tags as well as the name.
       *
       * Typing "retail" should find the domain's models even when none of them is literally
       * called retail, and typing "gold" should find everything tagged gold, a tag you
       * cannot search for is a tag that only decorates.
       */
      return (
        model.name.toLowerCase().includes(needle) ||
        (model.namespace ?? "").toLowerCase().includes(needle) ||
        (model.description ?? "").toLowerCase().includes(needle) ||
        (model.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [models, query, tier]);

  /** The visible models, bucketed by domain, each bucket in the chosen order. */
  const groups = useMemo(() => {
    const byDomain = new Map<string, ModelView[]>();
    for (const model of visible) {
      const domain = model.namespace ?? UNGROUPED;
      const bucket = byDomain.get(domain);
      if (bucket) bucket.push(model);
      else byDomain.set(domain, [model]);
    }

    for (const bucket of byDomain.values()) {
      bucket.sort((a, b) => {
        switch (sort) {
          case "objects":
            // Descending: "which are the big ones" is the question being asked.
            return b.objectCount - a.objectCount;
          case "name":
            return a.name.localeCompare(b.name);
          case "tier":
          default:
            /**
             * Tier order, not alphabetical.
             *
             * Within a domain the models are one chain with a direction: conceptual derives
             * to logical derives to physical. Alphabetical puts physical in the middle and
             * makes the derivation unreadable.
             */
            return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
        }
      });
    }

    // `Ungrouped` last: it is the absence of a domain, not a domain called U.
    return [...byDomain.entries()].sort(([a], [b]) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
    );
  }, [visible, sort]);

  const filtering = Boolean(query.trim() || tier);

  return (
    <Page
      title="Models"
      /*
        Ancestors only, never the current page.
        `Models › Models` was the first draft, and it read as a bug because it is one: a
        breadcrumb names where you came from, and the title already says where you are.
        Harness shows `Account › Organization › Project` above a page titled `Pipelines`.
      */
      breadcrumb={[
        { label: workspace?.name ?? "Workspace", onSelect: () => router.go({ name: "overview" }) },
      ]}
      meta={
        models.length === 0 ? undefined : (
          <>
            <span>
              {models.length} model{models.length === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>
              {domainNames.length} domain{domainNames.length === 1 ? "" : "s"}
            </span>
          </>
        )
      }
      actions={
        <>
          <Button variant="ghost" icon="upload" onClick={onImport}>
            Import
          </Button>
          {canEdit ? (
            <Button variant="primary" icon="plus" onClick={onNewModel}>
              New model
            </Button>
          ) : null}
        </>
      }
    >
      {models.length === 0 ? (
        <EmptyState
          icon="layers"
          title="No models yet"
          body="A model is one modelling effort at one tier, conceptual, logical or physical. Create one, or import an existing schema from DDL or an erwin export."
          action={
            canEdit ? (
              <Button variant="primary" icon="plus" onClick={onNewModel}>
                New model
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="stack">
          {/*
            Search, filter and sort, which is the whole reason this is a page and not a tree.
            At three hundred models the list is only usable through them.
          */}
          <div className="models__controls">
            <div className="models__search">
              <Icon name="search" size={14} />
              <Input
                value={query}
                placeholder="Search models, domains, tags…"
                aria-label="Search models"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            <Segmented
              value={tier}
              onChange={setTier}
              options={[
                { value: "", label: "All tiers" },
                ...TIER_ORDER.map((value) => ({ value, label: TIER_LABEL[value] })),
              ]}
            />

            <Segmented
              value={sort}
              onChange={setSort}
              options={[
                { value: "tier", label: "Tier", title: "Conceptual, then logical, then physical" },
                { value: "name", label: "Name", title: "Alphabetical within each domain" },
                { value: "objects", label: "Size", title: "Largest first" },
              ]}
            />

            {filtering ? (
              <span className="muted small">
                {visible.length} of {models.length}
              </span>
            ) : null}
          </div>

          {groups.length === 0 ? (
            <EmptyState
              icon="search"
              title="No models match"
              body="Nothing here fits those filters."
              action={
                <Button
                  variant="ghost"
                  onClick={() => {
                    setQuery("");
                    setTier("");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="stack" style={{ gap: "var(--s5)" }}>
              {groups.map(([domain, entries]) => (
                <DomainGroup
                  key={domain}
                  domain={domain}
                  models={entries}
                  changes={changes}
                  router={router}
                  canEdit={canEdit}
                  collapsed={collapsed.has(domain)}
                  onToggle={() => toggleDomain(domain)}
                  onEdit={setEditing}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {editing ? (
        <ModelSettingsDialog
          model={editing}
          domains={domainNames}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------- one domain

/**
 * One domain and the models in it.
 *
 * The header is a twisty plus a link, deliberately two separate targets. Collapsing a domain
 * and opening it are different intentions, and a header that did both depending on where you
 * clicked would make one of them an accident.
 */
function DomainGroup({
  domain,
  models,
  changes,
  router,
  canEdit,
  collapsed,
  onToggle,
  onEdit,
}: {
  domain: string;
  models: ModelView[];
  changes: Record<string, HistorySummaryEntry[]> | undefined;
  router: Router;
  canEdit: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (model: ModelView) => void;
}): JSX.Element {
  const objectCount = models.reduce((sum, model) => sum + model.objectCount, 0);
  const tags = [...new Set(models.flatMap((model) => model.tags ?? []))].sort();
  const real = domain !== UNGROUPED;

  return (
    <section className="dgroup">
      <header className="dgroup__head">
        <button
          type="button"
          className="dgroup__twisty"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${domain}` : `Collapse ${domain}`}
          onClick={onToggle}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
        </button>

        {real ? (
          <a className="dgroup__name" {...linkProps(router, { name: "domain", domain, tab: "overview" })}>
            <Icon name="folder" size={13} />
            {domain}
          </a>
        ) : (
          <span className="dgroup__name dgroup__name--none">
            <Icon name="folder" size={13} />
            {domain}
          </span>
        )}

        <span className="dgroup__counts muted small">
          {models.length} model{models.length === 1 ? "" : "s"} · {objectCount} object
          {objectCount === 1 ? "" : "s"}
        </span>

        {tags.length > 0 ? (
          <span className="page__tags dgroup__tags">
            {tags.slice(0, 4).map((tag) => (
              <span key={tag} className="page__tag">
                {tag}
              </span>
            ))}
            {tags.length > 4 ? <span className="muted small">+{tags.length - 4}</span> : null}
          </span>
        ) : null}

        {real ? (
          <a className="dgroup__open" {...linkProps(router, { name: "domain", domain, tab: "overview" })}>
            Open domain
            <Icon name="chevronRight" size={11} />
          </a>
        ) : null}
      </header>

      {collapsed ? null : (
        <>
          <div className="dgroup__cols">
            <span>Model</span>
            <span>Tier</span>
            <span>
              <span className="dgroup__hint">latest one on right side &rarr;</span>
              Recent changes
            </span>
            <span>Last change</span>
            <span>Objects</span>
          </div>

        <div className="dgroup__rows">
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              changes={changes === undefined ? undefined : (changes[model.name] ?? [])}
              router={router}
              canEdit={canEdit}
              onEdit={() => onEdit(model)}
            />
          ))}
        </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- one model

/**
 * One model, in the shape of a Harness pipeline row.
 *
 * Name and id together as the identity, a chip for the tier, ten squares for recent changes
 * with the newest on the right, then who changed it last. The whole row navigates; the kebab
 * sits outside the anchor so opening the menu is not also a navigation.
 */
function ModelRow({
  model,
  changes,
  router,
  canEdit,
  onEdit,
}: {
  model: ModelView;
  changes: HistorySummaryEntry[] | undefined;
  router: Router;
  canEdit: boolean;
  onEdit: () => void;
}): JSX.Element {
  const menu: MenuEntry[] = [
    { heading: model.name },
    { label: "Settings", icon: "settings", disabled: !canEdit, onSelect: onEdit },
    {
      label: "Objects",
      icon: "list",
      onSelect: () => router.go({ name: "model", model: model.name, tab: "objects" }),
    },
    {
      label: "History",
      icon: "branch",
      onSelect: () => router.go({ name: "model", model: model.name, tab: "history" }),
    },
    {},
    /*
      Compare needs two models, so it is an action taken *from* one rather than a place. As a
      sidebar destination it opened onto two empty pickers and no context.
    */
    { label: "Compare with…", icon: "compare", onSelect: () => router.go({ name: "compare" }) },
  ];

  const last = changes?.[0];
  const loading = changes === undefined;

  return (
    <div className="mrow">
      {/*
        One overlay link covering the row, beneath the cells.

        The row has to be a real link, middle-click and ⌘-click must open a tab, but it also
        contains links of its own, one per change square, and `<a>` inside `<a>` is invalid
        HTML that browsers silently unnest, which is what stopped the squares rendering at all.
        An absolutely-positioned overlay gives the whole row one link target while leaving the
        nested ones as siblings rather than descendants.
      */}
      <a
        className="mrow__overlay"
        aria-label={`Open ${model.name}`}
        {...linkProps(router, { name: "model", model: model.name, tab: "diagram" })}
      />

      <span className="mrow__identity">
        <span className="mrow__top">
          <span className="mrow__name">{model.name}</span>
          {(model.tags ?? []).length > 0 ? (
            <span className="mrow__tagcount" title={model.tags.join(", ")}>
              <Icon name="tag" size={12} />
              {model.tags.length}
            </span>
          ) : null}

          {/*
            Problems, on the model they belong to.
            The point of dropping the sidebar's Problems item is that a workspace-level count
            tells you something is wrong but not where; a count on the row does both. Errors
            win over warnings when a model has some of each, because that is what blocks a
            merge.
          */}
          {model.problems.error > 0 ? (
            <Count value={model.problems.error} tone="err" />
          ) : model.problems.warning > 0 ? (
            <Count value={model.problems.warning} tone="warn" />
          ) : null}
        </span>
        <span className="mrow__id">Id: {model.id}</span>
      </span>

      <span className="mrow__cell">
        <Badge tone={model.tier === "physical" ? "accent" : "neutral"} icon="layers">
          {TIER_LABEL[model.tier]}
        </Badge>
      </span>

      <span className="mrow__cell">
        <ChangeSquares changes={changes} />
      </span>

      <span className="mrow__cell mrow__last">
        {loading ? (
          <span className="mrow__skeleton" aria-hidden />
        ) : last ? (
          <>
            <span className="mrow__avatar">{last.author.slice(0, 1).toUpperCase()}</span>
            <span className="mrow__lastbody">
              <span className="mrow__lastname">{last.author}</span>
              <time className="muted small" dateTime={last.date}>
                {relative(last.date)}
              </time>
            </span>
          </>
        ) : (
          <span className="muted small">no changes yet</span>
        )}
      </span>

      <span className="mrow__cell mono muted small">{model.objectCount}</span>

      <span className="mrow__side">
        <MenuTrigger entries={menu} align="right" width={190}>
          {({ open, toggle }) => (
            <IconButton
              icon="kebab"
              label={`${model.name} actions`}
              size="sm"
              active={open}
              onClick={toggle}
            />
          )}
        </MenuTrigger>
      </span>
    </div>
  );
}

/**
 * Ten squares: the model's recent changes, oldest on the left.
 *
 * Reversed from the order the server sends, which is newest first, because left-to-right is
 * how time reads, Harness even captions the column "latest one on right side →". A change
 * that arrived through a pull request is filled; one pushed straight to the branch is
 * outlined, which is a distinction worth seeing at a glance on a governed repository.
 */
function ChangeSquares({ changes }: { changes: HistorySummaryEntry[] | undefined }): JSX.Element {
  if (changes === undefined) return <span className="squares squares--loading" aria-hidden />;
  if (changes.length === 0) return <span className="muted small">-</span>;

  const oldestFirst = [...changes].reverse();

  return (
    <span className="squares">
      {oldestFirst.map((change) => {
        const label = `${change.pullRequest ? `#${change.pullRequest}, ` : ""}${change.subject} · ${
          change.author
        } · ${relative(change.date)}`;
        const className = `square${change.pullRequest ? " square--pr" : " square--direct"}`;

        return change.pullRequestUrl ?? change.commitUrl ? (
          <a
            key={change.sha}
            className={className}
            href={change.pullRequestUrl ?? change.commitUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={label}
            aria-label={label}
          />
        ) : (
          <span key={change.sha} className={className} title={label} />
        );
      })}
    </span>
  );
}

/** A relative time, largest unit first. Recomputed per render; nothing here ticks. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (seconds >= size) return formatter.format(-Math.round(seconds / size), unit);
  }
  return "just now";
}
