import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Icon, type IconName } from "../ui";
import { modifierKey } from "./TopBar";
import type { Route, Router } from "./routes";
import type { SearchHit } from "../types";
import { useWorkspace } from "./WorkspaceContext";

/**
 * ⌘K.
 *
 * The single highest-leverage addition to the navigation, because it makes the *depth* of
 * the app free. A modeller who knows a table is called `dim_customer` should not have to
 * know which product, tier and object-kind folder it lives under in order to open it, * and it was that requirement that forced the old four-level explorer tree, which in turn
 * is what made the sidebar feel like a filesystem browser rather than navigation.
 *
 * It also gives every command one discoverable home. That is what allowed a ribbon's worth
 * of buttons to come off the chrome: an action nobody can find is not "in the ribbon", it
 * is lost, and an action in here is one keystroke and three letters away.
 *
 * Three result kinds, in priority order:
 *   1. **Commands**, go somewhere, create something, toggle something.
 *   2. **Models**, jump straight to a tier of a domain.
 *   3. **Objects**, every entity, table, domain and mapping, searched on the server.
 *
 * Commands rank first because they are a closed, memorable set: someone typing "set"
 * wants Settings, not a table with "set" in its name. Objects are unbounded and would
 * otherwise bury them.
 */

/**
 * Facet to heading.
 *
 * "Mentions" rather than "Descriptions": the row is not the description, it is the object that
 * happens to mention what you typed, and the excerpt beside it already shows the text.
 */
const HIT_GROUP: Record<SearchHit["kind"], string> = {
  model: "Models",
  object: "Objects",
  field: "Fields",
  glossary: "Glossary",
  description: "Mentions",
};

interface Command {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  meta?: string;
  /** Keywords that should match this command but do not appear in its label. */
  keywords?: string;
  run: () => void;
}

interface Props {
  router: Router;
  onClose: () => void;
  onNewModel: () => void;
  onImport: () => void;
  onPropose: () => void;
  onToggleTheme: () => void;
}

export function CommandPalette({
  router,
  onClose,
  onNewModel,
  onImport,
  onPropose,
  onToggleTheme,
}: Props): JSX.Element {
  const { workspace, canEdit, isAdmin, git } = useWorkspace();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /**
   * Workspace search results, from the server.
   *
   * Replaces a name-only object lookup. The palette used to answer "what is this thing called"
   * and nothing else; the questions people actually type, "which table holds the email
   * address", "where did we write down what this rule is", need fields, descriptions and
   * mapping rules in the index, none of which a list of object names contains.
   */
  const [hits, setHits] = useState<SearchHit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (route: Route) => {
      onClose();
      router.go(route);
    },
    [onClose, router],
  );

  // ------------------------------------------------------------ commands

  const commands = useMemo<Command[]>(() => {
    const items: Command[] = [
      {
        id: "go-overview",
        label: "Go to Overview",
        icon: "grid",
        group: "Navigate",
        keywords: "home start dashboard",
        run: () => go({ name: "overview" }),
      },
      {
        id: "go-problems",
        label: "Go to Problems",
        icon: "shield",
        group: "Navigate",
        keywords: "validation errors warnings lint check",
        ...(workspace && workspace.diagnostics.error > 0
          ? { meta: `${workspace.diagnostics.error} errors` }
          : {}),
        run: () => go({ name: "problems" }),
      },
      {
        id: "go-changes",
        label: "Go to Changes",
        icon: "branch",
        group: "Navigate",
        keywords: "git diff uncommitted source control",
        ...(git && git.files.length > 0 ? { meta: `${git.files.length} files` } : {}),
        run: () => go({ name: "changes" }),
      },
      {
        id: "go-compare",
        label: "Go to Compare",
        icon: "compare",
        group: "Navigate",
        keywords: "drift difference tiers",
        run: () => go({ name: "compare" }),
      },
      {
        id: "go-output",
        label: "Go to Generated output",
        icon: "doc",
        group: "Navigate",
        keywords: "ddl sql codeowners generate",
        run: () => go({ name: "output" }),
      },
      {
        id: "go-settings",
        label: "Go to Settings",
        icon: "settings",
        group: "Navigate",
        keywords: "preferences configuration options",
        run: () => go({ name: "settings", section: isAdmin ? "general" : "appearance" }),
      },
      {
        id: "theme",
        label: "Toggle light / dark theme",
        icon: "moon",
        group: "View",
        keywords: "dark light appearance colour color",
        run: () => {
          onClose();
          onToggleTheme();
        },
      },
    ];

    if (canEdit) {
      items.unshift(
        {
          id: "new-model",
          label: "New model",
          icon: "plus",
          group: "Create",
          keywords: "add create product domain tier conceptual logical physical",
          run: () => {
            onClose();
            onNewModel();
          },
        },
        {
          id: "import",
          label: "Import from DDL, erwin or a spreadsheet",
          icon: "upload",
          group: "Create",
          keywords: "reverse engineer sql csv migrate erwin xml",
          run: () => {
            onClose();
            onImport();
          },
        },
      );

      if (git && git.files.length > 0) {
        items.unshift({
          id: "propose",
          label: "Propose changes as a pull request",
          icon: "pr",
          group: "Create",
          meta: `${git.files.length} files`,
          keywords: "commit push pr branch review",
          run: () => {
            onClose();
            onPropose();
          },
        });
      }
    }

    if (isAdmin) {
      items.push({
        id: "users",
        label: "Manage users",
        icon: "users",
        group: "Navigate",
        keywords: "accounts roles permissions admin",
        run: () => go({ name: "settings", section: "users" }),
      });
    }

    return items;
  }, [canEdit, git, go, isAdmin, onClose, onImport, onNewModel, onPropose, onToggleTheme, workspace]);

  // ------------------------------------------------------------ object search

  /**
   * Objects come from the server, because the client never holds the whole workspace.
   *
   * Debounced, and only past two characters: a request per keystroke is wasteful, and a
   * one-character query matches most of a real model, which is not a useful answer.
   */
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .search(trimmed)
        .then((result) => {
          if (!cancelled) setHits(result.hits);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  // ------------------------------------------------------------ results

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const rows: { key: string; group: string; label: string; icon: IconName; meta?: string; run: () => void }[] =
      [];

    for (const command of commands) {
      // Filtering happens before grouping, so an empty group never renders a header.
      if (trimmed && !`${command.label} ${command.keywords ?? ""}`.toLowerCase().includes(trimmed)) {
        continue;
      }
      rows.push({
        key: command.id,
        group: command.group,
        label: command.label,
        icon: command.icon,
        ...(command.meta ? { meta: command.meta } : {}),
        run: command.run,
      });
    }

    for (const model of workspace?.models ?? []) {
      const haystack = `${model.name} ${model.namespace ?? ""} ${model.tier}`.toLowerCase();
      if (trimmed && !haystack.includes(trimmed)) continue;
      rows.push({
        key: `model-${model.id}`,
        group: "Models",
        label: model.name,
        icon: "layers",
        meta: `${model.tier}${model.namespace ? ` · ${model.namespace}` : ""}`,
        run: () => go({ name: "model", model: model.name, tab: "diagram" }),
      });
    }

    for (const hit of hits) {
      /*
        Each facet lands where its answer lives, which is the point of separating them.

        A **field** hit goes to the dictionary, where the column is a row you can read and edit
        in place. An **object** hit goes to the objects table, because two-thirds of object
        kinds have no box on a diagram. A **model** hit opens the studio. Sending everything to
        one destination would make half the results a dead end.
      */
      rows.push({
        key: `hit-${hit.kind}-${hit.objectId}-${hit.path ?? ""}`,
        group: HIT_GROUP[hit.kind],
        label: hit.label,
        icon: hit.kind === "field" ? "key" : iconFor(hit.objectKind),
        meta: [hit.excerpt ?? hit.meta, hit.model].filter(Boolean).join(" · "),
        run: () => {
          if (hit.kind === "model") {
            go({ name: "model", model: hit.objectName, tab: "diagram" });
          } else if (hit.model && (hit.kind === "field" || hit.path)) {
            go({ name: "model", model: hit.model, tab: "dictionary" });
          } else if (hit.model) {
            go({ name: "model", model: hit.model, tab: "objects" });
          } else {
            go({ name: "models" });
          }
        },
      });
    }

    /**
     * Sort into contiguous groups.
     *
     * The header is drawn whenever a row's group differs from the previous row's, so a
     * group that appears in two separate runs renders its header twice, which is exactly
     * what happened with "Manage users" sitting in `Navigate` after a `View` command.
     *
     * A stable sort on the declared group order fixes it without disturbing the order
     * within each group, which is deliberate: `Create` before `Navigate` puts the
     * destructive-ish actions where they are expected, and `Objects` last keeps an
     * unbounded result set from burying the commands.
     */
    const order = ["Create", "Navigate", "View", "Models", "Objects", "Fields", "Glossary", "Mentions"];
    const rank = (group: string): number => {
      const at = order.indexOf(group);
      return at === -1 ? order.length : at;
    };
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index)
      .map(({ row }) => row);
  }, [commands, go, hits, query, workspace]);

  // Reset the cursor whenever the result set changes, or Enter fires whatever used to be
  // at that index, which is how a palette deletes the wrong thing.
  useEffect(() => setCursor(0), [query, results.length]);

  const activate = useCallback(
    (index: number) => {
      const row = results[index];
      if (row) row.run();
    },
    [results],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((current) =>
          results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        activate(cursor);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activate, cursor, onClose, results.length]);

  // Keep the cursor in view when arrowing past the visible window.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  let lastGroup = "";

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__search">
          <Icon name="search" size={16} className="muted" />
          <input
            className="palette__input"
            autoFocus
            value={query}
            placeholder="Search models, objects and commands…"
            aria-label="Search models, objects and commands"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="palette__results" ref={listRef}>
          {results.length === 0 ? (
            <p className="muted small" style={{ padding: "var(--s6)", textAlign: "center" }}>
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            results.map((row, index) => {
              const heading = row.group === lastGroup ? null : row.group;
              lastGroup = row.group;

              return (
                <div key={row.key}>
                  {heading ? <div className="palette__group">{heading}</div> : null}
                  <button
                    type="button"
                    className="palette__row"
                    data-active={index === cursor ? "true" : undefined}
                    // Mouseover moves the cursor rather than applying a competing hover
                    // highlight, so there is exactly one current row at all times.
                    onMouseMove={() => setCursor(index)}
                    onClick={() => activate(index)}
                  >
                    <Icon name={row.icon} size={14} className="palette__row__icon" />
                    <span className="palette__row__label">{row.label}</span>
                    {row.meta ? <span className="palette__row__meta">{row.meta}</span> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="palette__foot">
          <span className="palette__hint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className="palette__hint">
            <kbd>↵</kbd> open
          </span>
          <span className="palette__hint">
            <kbd>esc</kbd> dismiss
          </span>
          <span className="grow" />
          <span className="palette__hint">
            <kbd>{modifierKey()}K</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

export function iconFor(kind: string): IconName {
  switch (kind) {
    case "table":
      return "table";
    case "entity":
      return "entity";
    case "concept":
      return "concept";
    case "mapping":
      return "flow";
    case "relationship":
      return "link";
    case "diagram":
      return "grid";
    case "domain":
      return "code";
    case "subjectArea":
      return "folder";
    case "glossaryTerm":
      return "doc";
    case "namingStandard":
      return "shield";
    case "model":
      return "layers";
    default:
      return "list";
  }
}
