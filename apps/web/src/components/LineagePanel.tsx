import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { iconFor } from "../app/CommandPalette";
import { Badge, Icon } from "../ui";
import type { ImpactResult, LineageEdge, LineageResult, ImpactSeverity } from "../types";

/**
 * Where this came from, and what breaks if it changes.
 *
 * Two questions, one traversal, deliberately two sections. "Where does this value come from"
 * is asked by someone reading the model; "what breaks if I drop this" is asked by someone
 * about to change it. Merging them into one dependency list serves neither, the reader gets
 * consequences they did not ask about, and the changer has to work out which direction each
 * entry points.
 *
 * Both fetch **on expand, not on selection**. A traversal builds every edge in the workspace,
 * and doing that on every click through a diagram would make selection feel slow to pay for
 * a panel most clicks never open.
 */

const SEVERITY_LABEL: Record<ImpactSeverity, string> = {
  breaks: "Breaks",
  rewrites: "Needs a rewrite",
  informational: "Mentions it",
};

const EDGE_LABEL: Record<LineageEdge["kind"], string> = {
  mapping: "mapping",
  foreignKey: "foreign key",
  implements: "implements",
  derivedFrom: "derived from",
};

interface Props {
  objectId: string;
  /** When set, both questions are asked about this column rather than the whole object. */
  column?: string;
  onGoTo: (objectId: string) => void;
}

export function LineageSection({ objectId, column, onGoTo }: Props): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="props__section">
      <button
        type="button"
        className="props__sectionhead"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
        <span>Lineage{column ? `, ${column}` : ""}</span>
      </button>
      {open ? <Upstream objectId={objectId} {...(column ? { column } : {})} onGoTo={onGoTo} /> : null}
    </section>
  );
}

export function ImpactSection({ objectId, column, onGoTo }: Props): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="props__section">
      <button
        type="button"
        className="props__sectionhead"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
        <span>Impact{column ? `, ${column}` : ""}</span>
      </button>
      {open ? <Impact objectId={objectId} {...(column ? { column } : {})} onGoTo={onGoTo} /> : null}
    </section>
  );
}

/** The chain backwards, nearest source first. */
function Upstream({ objectId, column, onGoTo }: Props): JSX.Element {
  const [result, setResult] = useState<LineageResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    api
      .lineage(objectId, { ...(column ? { column } : {}), direction: "upstream" })
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [objectId, column]);

  if (error) return <p className="props__note small">{error}</p>;
  if (!result) return <p className="props__note small muted">Tracing…</p>;

  if (result.edges.length === 0) {
    return (
      <p className="props__note small muted">
        Nothing feeds this{column ? " column" : ""}. It is either a source table or produced
        outside the modelled pipelines.
      </p>
    );
  }

  return (
    <div className="lin">
      {result.edges.map((edge, index) => (
        <div key={`${edge.from.objectId}:${edge.from.column ?? ""}:${index}`} className="lin__hop">
          <button type="button" className="lin__node" onClick={() => onGoTo(edge.from.objectId)}>
            <Icon name={iconFor(edge.from.kind)} size={11} />
            <span className="truncate">
              {edge.from.objectName}
              {edge.from.column ? <span className="lin__col">.{edge.from.column}</span> : null}
            </span>
          </button>

          <span className="lin__arrow">
            <Icon name="arrowRight" size={11} />
            <span className="lin__via">{edge.via?.name ?? EDGE_LABEL[edge.kind]}</span>
          </span>

          <span className="lin__node lin__node--target">
            <Icon name={iconFor(edge.to.kind)} size={11} />
            <span className="truncate">
              {edge.to.objectName}
              {edge.to.column ? <span className="lin__col">.{edge.to.column}</span> : null}
            </span>
          </span>

          {/*
            The expression is the part a table-level lineage graph cannot show, and usually
            the part someone is actually looking for, "is this trimmed?", "is this coalesced
            to zero?". Shown in full rather than truncated: a half-visible SQL expression
            answers nothing.
          */}
          {edge.expression ? <code className="lin__expr">{edge.expression}</code> : null}
          {edge.rule ? <span className="lin__rule">{edge.rule}</span> : null}
        </div>
      ))}

      <Caveats truncated={result.truncated} opaque={result.opaque} />
    </div>
  );
}

/** What depends on this, worst first. */
function Impact({ objectId, column, onGoTo }: Props): JSX.Element {
  const [result, setResult] = useState<ImpactResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    api
      .impact(objectId, (column ? { column } : {}))
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [objectId, column]);

  if (error) return <p className="props__note small">{error}</p>;
  if (!result) return <p className="props__note small muted">Checking…</p>;

  if (result.entries.length === 0) {
    return (
      <p className="props__note small muted">
        Nothing reads this{column ? " column" : ""}. Safe to change as far as this model knows.
      </p>
    );
  }

  return (
    <div className="imp">
      {/*
        Lead with the count that decides whether to read further. "3 break" is the sentence
        someone needs before a merge; the list is what they read once they know it is not zero.
      */}
      <div className="imp__summary">
        {(["breaks", "rewrites", "informational"] as ImpactSeverity[]).map((severity) =>
          result.counts[severity] > 0 ? (
            <span key={severity} className={`imp__count imp__count--${severity}`}>
              {result.counts[severity]} {SEVERITY_LABEL[severity].toLowerCase()}
            </span>
          ) : null,
        )}
      </div>

      {result.entries.map((entry) => (
        <div key={`${entry.objectId}:${entry.column ?? ""}`} className={`imp__row imp__row--${entry.severity}`}>
          <button type="button" className="imp__name" onClick={() => onGoTo(entry.objectId)}>
            <Icon name={iconFor(entry.kind)} size={11} />
            <span className="truncate">
              {entry.objectName}
              {entry.column ? <span className="lin__col">.{entry.column}</span> : null}
            </span>
          </button>
          <Badge tone={entry.severity === "breaks" ? "err" : entry.severity === "rewrites" ? "warn" : "neutral"}>
            {SEVERITY_LABEL[entry.severity]}
          </Badge>
          <p className="imp__reason">{entry.reason}</p>
        </div>
      ))}

      <Caveats truncated={result.truncated} opaque={result.opaque} />
    </div>
  );
}

/**
 * What this answer does not cover.
 *
 * Stated rather than omitted. A traversal that stops at a depth limit or cannot read a
 * hand-written SQL block has an incomplete answer, and an incomplete answer presented as a
 * complete one is the failure mode that gets a column dropped in production.
 */
function Caveats({
  truncated,
  opaque,
}: {
  truncated: boolean;
  opaque: { id: string; name: string; target: string }[];
}): JSX.Element | null {
  if (!truncated && opaque.length === 0) return null;

  return (
    <div className="lin__caveat">
      {truncated ? <p>Stopped at the depth limit, there may be more beyond this.</p> : null}
      {opaque.length > 0 ? (
        <p>
          {opaque.length === 1 ? "One mapping" : `${opaque.length} mappings`} in this chain use
          hand-written SQL, which is not parsed:{" "}
          {opaque.map((entry) => entry.name).join(", ")}. Columns inside it are not traced.
        </p>
      ) : null}
    </div>
  );
}
