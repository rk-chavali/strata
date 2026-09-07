import { useMemo, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Button, Icon, IconButton, useFeedback } from "../ui";
import type { Diagnostic, GraphView, Severity } from "../types";

/**
 * What is wrong with this model, docked under its canvas.
 *
 * Problems used to live on their own page, which is the wrong place for them: you fix a
 * model by looking at the model, and a validation list on a different screen means every
 * fix is a round trip. Docking it puts the error and the thing it is about on one screen,
 * and clicking a row selects the object, so "unresolved reference on `fct_order_line`"
 * becomes a click rather than a search.
 *
 * Collapsed by default when the model is clean. A permanently-visible empty panel teaches
 * people to ignore the space, so when something does break there is nothing to notice.
 * When there *are* problems it opens itself, once, on arrival.
 */

const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"];

const SEVERITY_ICON: Record<Severity, "warn" | "shield" | "note"> = {
  error: "warn",
  warning: "shield",
  info: "note",
};

interface Props {
  /** Every diagnostic in the workspace; this component scopes them to the model itself. */
  all: Diagnostic[];
  graph: GraphView;
  onSelect: (objectId: string) => void;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Refetch after a fix lands, so the row it fixed disappears. */
  onFixed: () => void;
  canEdit: boolean;
}

export function DiagnosticsDock({
  all,
  graph,
  onSelect,
  open,
  onOpenChange,
  onFixed,
  canEdit,
}: Props): JSX.Element | null {
  const ui = useFeedback();
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [fixing, setFixing] = useState<string | undefined>();

  /**
   * Apply one finding's suggested correction.
   *
   * Routed through the server, which re-verifies the suggestion still applies before acting.
   * The alternative, trusting the value the row was rendered with, would let a fix computed
   * before two other edits rename something nobody is looking at.
   */
  async function applyFix(item: Diagnostic): Promise<void> {
    if (!item.fix || !item.objectId) return;
    const id = `${item.code}:${item.objectId}:${item.fix.path}`;
    setFixing(id);
    try {
      await api.applyFix({
        objectId: item.objectId,
        code: item.code,
        path: item.fix.path,
        value: item.fix.value,
      });
      ui.toast({ tone: "success", message: `Renamed to \`${String(item.fix.value)}\`` });
      onFixed();
    } catch (err) {
      ui.toast({
        tone: "error",
        message: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setFixing(undefined);
    }
  }

  /**
   * Which of the workspace's diagnostics belong to *this* model.
   *
   * Scoped by object id against the graph rather than by file path: a diagnostic about a
   * cross-model reference names the object, and matching on the path would attribute it to
   * whichever file happened to hold it. Diagnostics with no `objectId` at all are workspace
   * level, a bad config, a missing preset, and are deliberately excluded here rather than
   * shown on every model at once.
   */
  const mine = useMemo(() => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    ids.add(graph.model.name);
    return all.filter((item) => item.objectId && ids.has(item.objectId));
  }, [all, graph.nodes, graph.model.name]);

  const counts = useMemo(() => {
    const result: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const item of mine) result[item.severity] += 1;
    return result;
  }, [mine]);

  const visible = useMemo(() => {
    const chosen = filter === "all" ? mine : mine.filter((item) => item.severity === filter);
    return [...chosen].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
  }, [mine, filter]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph.nodes) map.set(node.id, node.name);
    return map;
  }, [graph.nodes]);

  // Nothing wrong and nothing to say: render no dock at all rather than an empty strip.
  if (mine.length === 0 && !open) return null;

  return (
    <section className={`dock${open ? " is-open" : ""}`} aria-label="Warnings and errors">
      <header className="dock__head">
        <button
          type="button"
          className="dock__toggle"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <Icon name={open ? "chevronDown" : "chevronUp"} size={11} />
          <span className="dock__title">Warnings &amp; Errors</span>
        </button>

        <div className="dock__counts">
          {SEVERITY_ORDER.map((severity) =>
            counts[severity] > 0 ? (
              <button
                type="button"
                key={severity}
                className={`dock__count dock__count--${severity}${filter === severity ? " is-active" : ""}`}
                title={`Show only ${severity}s`}
                onClick={() => {
                  setFilter(filter === severity ? "all" : severity);
                  if (!open) onOpenChange(true);
                }}
              >
                <Icon name={SEVERITY_ICON[severity]} size={11} />
                {counts[severity]}
              </button>
            ) : null,
          )}
          {mine.length === 0 ? <span className="dock__clean small">No problems</span> : null}
        </div>

        <span className="grow" />

        {filter !== "all" ? (
          <button type="button" className="dock__clear small" onClick={() => setFilter("all")}>
            Clear filter
          </button>
        ) : null}

        <IconButton
          icon="close"
          label="Hide warnings and errors"
          size="sm"
          onClick={() => onOpenChange(false)}
        />
      </header>

      {open ? (
        <div className="dock__body">
          {visible.length === 0 ? (
            <p className="dock__empty muted small">
              {mine.length === 0
                ? "This model validates cleanly."
                : `No ${filter}s in this model.`}
            </p>
          ) : (
            <table className="dock__table">
              <tbody>
                {visible.map((item, index) => (
                  <tr
                    key={`${item.code}:${item.objectId ?? ""}:${index}`}
                    className={`dock__row dock__row--${item.severity}`}
                    onClick={() => item.objectId && onSelect(item.objectId)}
                    /* A row that navigates is a button in everything but tag name; without
                       these it is unreachable from the keyboard entirely. */
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && item.objectId) {
                        event.preventDefault();
                        onSelect(item.objectId);
                      }
                    }}
                  >
                    <td className="dock__sev">
                      <Icon name={SEVERITY_ICON[item.severity]} size={11} />
                      {item.severity}
                    </td>
                    <td className="dock__obj truncate">
                      {item.objectId ? (nameById.get(item.objectId) ?? item.objectId) : ""}
                    </td>
                    <td className="dock__msg">{item.message}</td>
                    <td className="dock__code mono">{item.code}</td>
                    <td className="dock__fix">
                      {/*
                        Only rendered where a fix exists. A greyed-out "Fix" on every other row
                        would read as "this is broken too", when the truth is that the tool has
                        no safe suggestion for it.
                      */}
                      {item.fix && item.objectId ? (
                        <Button
                          size="sm"
                          variant="default"
                          disabled={!canEdit || fixing !== undefined}
                          title={`Rename to \`${String(item.fix.value)}\``}
                          onClick={(event) => {
                            // The row itself navigates; the button must not also do that.
                            event.stopPropagation();
                            void applyFix(item);
                          }}
                        >
                          {fixing === `${item.code}:${item.objectId}:${item.fix.path}`
                            ? "Fixing…"
                            : `Rename to ${String(item.fix.value)}`}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  );
}
