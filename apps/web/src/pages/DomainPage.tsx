import { useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import { linkProps, type Route, type Router } from "../app/routes";
import {
  Badge,
  Button,
  Count,
  EmptyState,
  Icon,
  IconButton,
  MenuTrigger,
  useFeedback,
  type MenuEntry,
} from "../ui";
import { ModelSettingsDialog } from "../components/ModelSettingsDialog";
import { HistoryList } from "../components/HistoryList";
import { Glance } from "../components/Glance";
import type { ModelView, Tier } from "../types";

/**
 * One business domain: what it holds, who owns it, and the models inside it.
 *
 * **Why a domain gets a page.** A domain is the level at which work is actually owned, a
 * team owns `retail`, not `retail_logical`, and until now it existed only as a string
 * repeated on each model, with nowhere to see it, tag it or rename it. That is the same
 * relationship Harness has between a project and its pipelines: the project page carries
 * the identity, the tags and the people, and the list of pipelines is its contents.
 *
 * The counts at the top are the "at a glance" grid, and they are links rather than
 * decoration. A number you cannot click is a number you have to go and find another way,
 * which is the thing that made the old sidebar tree feel like the only route to anything.
 */

const TIER_LABEL: Record<Tier, string> = {
  conceptual: "Conceptual",
  logical: "Logical",
  physical: "Physical",
};

const TIER_ORDER: Tier[] = ["conceptual", "logical", "physical"];

/** The object kinds worth counting for a whole domain, in a fixed reading order. */
const GLANCE: { kind: string; label: string }[] = [
  { kind: "concept", label: "Concepts" },
  { kind: "entity", label: "Entities" },
  { kind: "table", label: "Tables" },
  { kind: "relationship", label: "Relationships" },
  { kind: "mapping", label: "Mappings" },
  { kind: "diagram", label: "Diagrams" },
];

export function DomainPage({
  router,
  route,
  onNewModel,
}: {
  router: Router;
  route: Extract<Route, { name: "domain" }>;
  onNewModel: () => void;
}): JSX.Element {
  const ui = useFeedback();
  const { workspace, canEdit, refresh, refreshKey } = useWorkspace();
  const [editing, setEditing] = useState<ModelView | undefined>();

  const all = workspace?.models ?? [];
  const models = useMemo(
    () =>
      all
        .filter((model) => (model.namespace ?? "Ungrouped") === route.domain)
        .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)),
    [all, route.domain],
  );

  const domains = useMemo(
    () => [...new Set(all.map((model) => model.namespace).filter(Boolean))] as string[],
    [all],
  );

  /**
   * The domain's own tags and owners, gathered from its models.
   *
   * A domain has no file of its own to hold them, so they are the union of what its models
   * carry. That is a deliberate choice over inventing a `domain` object: it keeps the repo
   * format unchanged, and it means a tag applied to the physical model still describes the
   * domain it sits in, which is how people already use tags.
   */
  const tags = useMemo(
    () => [...new Set(models.flatMap((model) => model.tags ?? []))].sort(),
    [models],
  );

  const owners = useMemo(() => {
    const found = new Map<string, string>();
    for (const model of models) {
      const ownership = model.ownership;
      if (ownership?.owner) found.set(ownership.owner, "Owner");
      if (ownership?.steward) found.set(ownership.steward, "Steward");
      if (ownership?.team) found.set(ownership.team, "Team");
    }
    return [...found.entries()];
  }, [models]);

  const counts = useMemo(() => {
    const total: Record<string, number> = {};
    for (const model of models) {
      for (const [kind, count] of Object.entries(model.counts)) {
        total[kind] = (total[kind] ?? 0) + count;
      }
    }
    return total;
  }, [models]);

  const objectCount = models.reduce((sum, model) => sum + model.objectCount, 0);

  async function renameDomain(): Promise<void> {
    const next = await ui.prompt({
      title: "Rename domain",
      label: "Domain name",
      initialValue: route.domain,
      confirmLabel: "Rename",
    });
    if (!next || next === route.domain) return;

    const result = await ui.attempt(
      () => api.renameDomain(route.domain, next),
      "Could not rename the domain",
    );
    if (!result) return;

    ui.toast({
      tone: "success",
      message: `Renamed to ${next}, ${result.models.length} model${
        result.models.length === 1 ? "" : "s"
      } moved`,
    });
    refresh();
    router.go({ name: "domain", domain: next, tab: "overview" }, { replace: true });
  }

  const menu: MenuEntry[] = [
    { heading: route.domain },
    {
      label: "Rename domain",
      icon: "edit",
      disabled: !canEdit,
      onSelect: () => void renameDomain(),
    },
    { label: "New model here", icon: "plus", disabled: !canEdit, onSelect: onNewModel },
    {},
    {
      label: "All models",
      icon: "layers",
      onSelect: () => router.go({ name: "models" }),
    },
  ];

  if (models.length === 0) {
    return (
      <Page
        title={route.domain}
        breadcrumb={[
          { label: "Models", onSelect: () => router.go({ name: "models" }) },
          { label: route.domain },
        ]}
      >
        <EmptyState
          icon="folder"
          title="No such domain"
          body={`Nothing in this workspace is in a domain called “${route.domain}”. It may have been renamed.`}
          action={
            <Button variant="primary" icon="layers" onClick={() => router.go({ name: "models" })}>
              All models
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page
      title={route.domain}
      breadcrumb={[
        { label: "Models", onSelect: () => router.go({ name: "models" }) },
        { label: route.domain },
      ]}
      meta={
        <>
          <span>
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
          <span>·</span>
          <span>
            {objectCount} object{objectCount === 1 ? "" : "s"}
          </span>
        </>
      }
      tags={tags}
      tabs={{
        items: [
          { id: "overview", label: "Overview", icon: "grid" },
          { id: "pulls", label: "Pull requests", icon: "pr" },
        ],
        active: route.tab,
        onSelect: (tab) => router.go({ name: "domain", domain: route.domain, tab }),
      }}
      actions={
        <>
          {/*
            Owners, as Harness shows Admins and Collaborators on a project. Read-only for
            now and labelled as such rather than offered as a control that does nothing, ownership is stored per model in `ownership`, and editing it belongs in the
            model settings beside the field it writes.
          */}
          {owners.length > 0 ? (
            <div className="owners" title="Owners and stewards of this domain's models">
              <span className="owners__label">Owners</span>
              <div className="owners__list">
                {owners.map(([person, role]) => (
                  <span key={person} className="owners__avatar" title={`${person}, ${role}`}>
                    {person.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {canEdit ? (
            <Button variant="primary" icon="plus" onClick={onNewModel}>
              New model
            </Button>
          ) : null}

          <MenuTrigger entries={menu} align="right" width={210}>
            {({ open, toggle }) => (
              <IconButton
                icon="kebab"
                label="Domain actions"
                active={open}
                onClick={toggle}
              />
            )}
          </MenuTrigger>
        </>
      }
    >
      {route.tab === "pulls" ? (
        <HistoryList domain={route.domain} limit={30} refreshKey={refreshKey} />
      ) : (
      <div className="stack" style={{ gap: "var(--s7)" }}>
        {/* ---------------------------------------------------------- at a glance */}

        <Glance
          router={router}
          items={GLANCE.filter((entry) => (counts[entry.kind] ?? 0) > 0).map((entry) => ({
            label: entry.label,
            value: counts[entry.kind] as number,
          }))}
        />

        {/* ---------------------------------------------------------- the models */}

        <section className="stack">
          <h2 className="glance__title">Models</h2>

          <div className="domain__models">
            {models.map((model) => (
              <div key={model.id} className="domain__model">
                <a className="domain__model__main" {...linkProps(router, modelRoute(model))}>
                  <span className="domain__model__top">
                    <span className={`dot dot--${model.tier}`} />
                    <span className="domain__model__name">{model.name}</span>
                    <Badge tone={model.tier === "physical" ? "accent" : "neutral"}>
                      {TIER_LABEL[model.tier]}
                    </Badge>
                    {model.lifecycle ? (
                      <Badge tone="neutral" outline>
                        {model.lifecycle.replace("_", " ")}
                      </Badge>
                    ) : null}
                    {model.problems.error > 0 ? (
                      <Count value={model.problems.error} tone="err" />
                    ) : model.problems.warning > 0 ? (
                      <Count value={model.problems.warning} tone="warn" />
                    ) : null}
                  </span>

                  <span className="domain__model__sub muted small">
                    {model.description ??
                      `${model.objectCount} object${model.objectCount === 1 ? "" : "s"}`}
                    {model.derivedFrom ? ` · derived from ${model.derivedFrom}` : ""}
                  </span>

                  {(model.tags ?? []).length > 0 ? (
                    <span className="page__tags">
                      {model.tags.map((tag) => (
                        <span key={tag} className="page__tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </a>

                <div className="domain__model__side">
                  <span className="mono muted small">{model.objectCount}</span>
                  <Button
                    icon="edit"
                    variant="ghost"
                    size="sm"
                    disabled={!canEdit}
                    title={`Edit ${model.name}`}
                    onClick={() => setEditing(model)}
                  >
                    Edit
                  </Button>
                  <Icon name="chevronRight" size={13} className="muted" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      )}

      {editing ? (
        <ModelSettingsDialog
          model={editing}
          domains={domains}
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

function modelRoute(model: ModelView): Route {
  return { name: "model", model: model.name, tab: "diagram" };
}
