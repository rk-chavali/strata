import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Page } from "../app/Page";
import { iconFor } from "../app/CommandPalette";
import { useWorkspace } from "../app/WorkspaceContext";
import { Badge, Button, Callout, EmptyState, Icon, Loading, Segmented, SeverityTag } from "../ui";
import type { Diagnostic, Severity } from "../types";

/**
 * Validation and naming findings.
 *
 * A page rather than a 280px panel, because a diagnostic is three pieces of information, * the rule, the message, and the file, and in a narrow panel the message wrapped to four
 * lines and the file was truncated to uselessness. Width is what this content needed.
 *
 * The framing matters as much as the layout: this is **the same check that gates a pull
 * request in CI**, so the page says so. A list of warnings with no stated consequence gets
 * ignored; the same list labelled "this is what will block your merge" does not.
 */

type Filter = "all" | "error" | "warning";

export function ProblemsPage(): JSX.Element {
  const { refreshKey } = useWorkspace();
  const [items, setItems] = useState<Diagnostic[] | undefined>();
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let cancelled = false;
    setItems(undefined);
    api
      .diagnostics()
      .then((result) => {
        if (!cancelled) setItems(result.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const counts = useMemo(() => {
    const tally: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const item of items ?? []) tally[item.severity] += 1;
    return tally;
  }, [items]);

  /**
   * Grouped by rule code, not listed flat.
   *
   * One bad naming standard produces forty findings that are the same finding. Flat, that
   * buries the three unrelated problems underneath it; grouped, it reads as "one rule, 40
   * places" and the user fixes the rule.
   */
  const groups = useMemo(() => {
    const visible = (items ?? []).filter((item) =>
      filter === "all" ? true : item.severity === filter,
    );
    const byCode = new Map<string, Diagnostic[]>();
    for (const item of visible) {
      const bucket = byCode.get(item.code);
      if (bucket) bucket.push(item);
      else byCode.set(item.code, [item]);
    }
    // Errors first, then the largest groups, the order you would work through them in.
    return [...byCode.entries()].sort(([, a], [, b]) => {
      const severity = (list: Diagnostic[]): number =>
        list.some((entry) => entry.severity === "error") ? 0 : 1;
      return severity(a) - severity(b) || b.length - a.length;
    });
  }, [filter, items]);

  const total = items?.length ?? 0;

  return (
    <Page
      title="Problems"
      subtitle="Structural, referential and naming findings, the same check that gates a pull request in CI"
      actions={
        total > 0 ? (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${total}` },
              { value: "error", label: `Errors ${counts.error}` },
              { value: "warning", label: `Warnings ${counts.warning}` },
            ]}
          />
        ) : null
      }
    >
      {items === undefined ? (
        <Loading label="Checking the model…" />
      ) : total === 0 ? (
        <EmptyState
          icon="check"
          title="No problems"
          body="Every structural, referential and naming rule passes. `strata check` would exit clean on this branch, so a pull request from here will not be blocked by the model gate."
          action={
            <Button icon="pr" variant="primary" onClick={() => window.history.back()}>
              Back to work
            </Button>
          }
        />
      ) : (
        <div className="stack">
          {counts.error > 0 ? (
            <Callout tone="err" title={`${counts.error} error${counts.error === 1 ? "" : "s"} will block a merge`}>
              `strata check` exits non-zero while any error remains, so a pull request opened
              now cannot merge until these are fixed. Proposing is still allowed, a rename
              legitimately breaks references until the follow-up edit lands, but it needs
              an explicit override.
            </Callout>
          ) : (
            <Callout tone="warn" title="Warnings only">
              Nothing here blocks a merge unless your workspace runs lint in strict mode.
              Settings → Validation controls which rules are errors.
            </Callout>
          )}

          {groups.map(([code, findings]) => (
            <RuleGroup key={code} code={code} findings={findings} />
          ))}
        </div>
      )}
    </Page>
  );
}

function RuleGroup({ code, findings }: { code: string; findings: Diagnostic[] }): JSX.Element {
  // Large groups start collapsed; a group of one or two is not worth a click to open.
  const [open, setOpen] = useState(findings.length <= 3);
  const first = findings[0];
  const severity = first?.severity ?? "warning";

  return (
    <section className="card">
      <button
        type="button"
        className="card__head"
        style={{ width: "100%", textAlign: "left" }}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="muted" />
        <SeverityTag severity={severity} />
        <span className="mono">{code}</span>
        <span className="grow" />
        <Badge>{findings.length === 1 ? "1 place" : `${findings.length} places`}</Badge>
      </button>

      {open ? (
        <div className="card__body" style={{ padding: 0 }}>
          <table className="table">
            <tbody>
              {findings.map((finding, index) => (
                <tr key={`${finding.objectId ?? ""}-${finding.path ?? ""}-${index}`}>
                  <td style={{ width: "1%", paddingRight: 0 }}>
                    <Icon name={iconFor(finding.objectId ? "entity" : "doc")} size={13} className="muted" />
                  </td>
                  <td>{finding.message}</td>
                  <td className="mono muted truncate-start" style={{ maxWidth: 280 }}>
                    {finding.file ?? finding.path ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
