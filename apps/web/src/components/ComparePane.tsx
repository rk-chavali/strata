import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Icon, type IconName } from "../ui";
import type {
  CompareResult,
  ComparePair,
  Difference,
  DifferenceKind,
  MigrationResult,
} from "../types";

/**
 * What has drifted between two models.
 *
 * Takes the full canvas rather than a rail panel: a difference list is a table with four
 * columns of prose, and squeezing it into 320px turns every row into three wrapped lines.
 * This is also a thing you sit and read, not something you glance at while drawing.
 *
 * Grouped by object rather than listed flat. Twelve differences across three tables is a
 * different problem from twelve differences on one, and a flat list hides which of those
 * you have, the shape of the drift matters more than the count.
 */

interface Props {
  /** Model currently open, used to pick a sensible default pairing. */
  currentModel: string | undefined;
  onOpenModel: (name: string) => void;
}

const KIND_META: Record<DifferenceKind, { icon: IconName; tone: string; label: string }> = {
  onlyInLeft: { icon: "minus", tone: "left", label: "not implemented" },
  onlyInRight: { icon: "plus", tone: "right", label: "not modelled" },
  memberOnlyInLeft: { icon: "minus", tone: "left", label: "missing" },
  memberOnlyInRight: { icon: "plus", tone: "right", label: "extra" },
  typeChanged: { icon: "code", tone: "changed", label: "type" },
  requiredChanged: { icon: "warn", tone: "changed", label: "nullability" },
  keyChanged: { icon: "key", tone: "changed", label: "key" },
};

export function ComparePane({ currentModel, onOpenModel }: Props): JSX.Element {
  const [pairs, setPairs] = useState<ComparePair[]>([]);
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [models, setModels] = useState<{ name: string; tier: string; namespace?: string }[]>([]);
  const [result, setResult] = useState<CompareResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .comparePairs()
      .then((data) => {
        setPairs(data.pairs);
        setModels(data.models);
        // Prefer a pairing involving whatever is already open, that is almost always
        // what someone came here to check.
        const preferred =
          data.pairs.find((pair) => pair.left === currentModel || pair.right === currentModel) ??
          data.pairs[0];
        if (preferred) {
          setLeft(preferred.left);
          setRight(preferred.right);
        }
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [currentModel]);

  const run = useCallback(async () => {
    if (!left || !right) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.compare({ left, right }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }, [left, right]);

  useEffect(() => {
    void run();
  }, [run]);

  /**
   * One group per matched pair, not per object name.
   *
   * `Customer` and `dim_customer` are one pairing; grouping by whichever side a
   * difference happened to sit on split them into two cards that looked like unrelated
   * objects, and doubled the apparent number of problems.
   */
  const byPair = new Map<string, { left: string; right?: string; rows: Difference[]; matchedBy?: string }>();
  for (const difference of result?.differences ?? []) {
    const group = byPair.get(difference.object);
    if (group) group.rows.push(difference);
    else
      byPair.set(difference.object, {
        left: difference.object,
        ...(difference.counterpart ? { right: difference.counterpart } : {}),
        ...(difference.matchedBy ? { matchedBy: difference.matchedBy } : {}),
        rows: [difference],
      });
  }

  /**
   * Whether a migration is even meaningful.
   *
   * ALTER statements are about warehouse objects, so both sides have to be physical models. The
   * server refuses otherwise; checking here as well means the control is simply absent rather
   * than present and guaranteed to fail.
   */
  const bothPhysical =
    models.find((model) => model.name === left)?.tier === "physical" &&
    models.find((model) => model.name === right)?.tier === "physical";

  return (
    <div className="compare">
      <div className="compare__inner">
        <h1 className="start__title">Compare models</h1>
        <p className="start__lede">
          Two models designed together drift apart, a column added straight to the warehouse, an
          entity nobody implemented. This finds them.
        </p>

        <div className="compare__pick">
          <Side label="Left" value={left} models={models} onChange={setLeft} />
          <Icon name="arrowRight" size={16} />
          <Side label="Right" value={right} models={models} onChange={setRight} />

          {pairs.length > 0 ? (
            <select
              className="input"
              style={{ maxWidth: 260 }}
              value={`${left}|${right}`}
              onChange={(event) => {
                const [nextLeft, nextRight] = event.target.value.split("|");
                setLeft(nextLeft ?? "");
                setRight(nextRight ?? "");
              }}
            >
              <option value={`${left}|${right}`}>Suggested pairings…</option>
              {pairs.map((pair) => (
                <option key={`${pair.left}|${pair.right}`} value={`${pair.left}|${pair.right}`}>
                  {pair.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {error ? <div className="callout callout--err">{error}</div> : null}
        {busy ? <p className="muted">Comparing…</p> : null}

        {result && !busy ? (
          <>
            <div
              className={`callout ${result.differences.length === 0 ? "callout--ok" : "callout--warn"}`}
            >
              {result.differences.length === 0 ? (
                <>
                  <strong>No drift.</strong> {result.summary.matched} object(s) matched and agree.
                </>
              ) : (
                <>
                  <strong>{result.differences.length} difference(s)</strong> across{" "}
                  {byPair.size} object(s). {result.summary.matched} matched ·{" "}
                  {result.summary.onlyInLeft} only in <span className="mono">{result.left}</span> ·{" "}
                  {result.summary.onlyInRight} only in <span className="mono">{result.right}</span>.
                </>
              )}
            </div>

            {[...byPair.values()].map((group) => (
              <div key={group.left} className="cmpgroup">
                <button
                  type="button"
                  className="cmpgroup__head"
                  onClick={() => onOpenModel(result.left)}
                  title="Open the model"
                >
                  <Icon name="table" size={13} />
                  <span className="truncate">{group.left}</span>
                  {group.right ? (
                    <>
                      <Icon name="arrowRight" size={11} />
                      <span className="truncate mono cmpgroup__right">{group.right}</span>
                    </>
                  ) : null}
                  {/*
                    The pairing is a fact about the *objects*, so it belongs on the header
                    once rather than repeated on every row, where it was pure noise.
                  */}
                  {group.matchedBy === "normalisedName" ? (
                    <span className="cmprow__guess" title="Paired by name similarity, not an explicit reference">
                      inferred
                    </span>
                  ) : null}
                  <span className="picker__meta">{group.rows.length}</span>
                </button>

                {group.rows.map((difference, index) => {
                  const meta = KIND_META[difference.kind];
                  return (
                    <div key={index} className={`cmprow cmprow--${meta.tone}`}>
                      <span className="cmprow__icon">
                        <Icon name={meta.icon} size={11} />
                      </span>
                      <span className="cmprow__tag">{meta.label}</span>
                      <span className="cmprow__member mono truncate">{difference.member ?? "-"}</span>
                      <span className="cmprow__detail truncate">
                        {difference.left && difference.right ? (
                          <>
                            <span className="mono">{difference.left}</span>
                            <Icon name="arrowRight" size={10} />
                            <span className="mono">{difference.right}</span>
                          </>
                        ) : difference.kind === "memberOnlyInRight" ? (
                          <span className="muted">only in {result.right}</span>
                        ) : difference.kind === "memberOnlyInLeft" ? (
                          <span className="muted">only in {result.left}</span>
                        ) : (
                          <span className="muted">{difference.message}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        ) : null}

        {/*
          The migration, below the differences and only for two physical models.
          A conceptual model has no tables to alter, so offering one there would be a feature
          that cannot work. Loaded on demand rather than with the compare: most visits here are
          to read the drift, and generating DDL nobody asked for costs a round trip every time.
        */}
        {bothPhysical ? (
          <Migration from={left} to={right} models={models} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The DDL that makes the left model's tables match the right's.
 *
 * Deliberately shows the refusals as prominently as the statements. BigQuery cannot narrow a
 * type, add NOT NULL, or repartition, and a migration panel that only listed what it *could* do
 * would read as complete, leaving whoever ran it believing the tables now match the model.
 */
function Migration({
  from,
  to,
  models,
}: {
  from: string;
  to: string;
  models: { name: string; tier: string }[];
}): JSX.Element | null {
  const [result, setResult] = useState<MigrationResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [dropColumns, setDropColumns] = useState(false);

  // Reset when the pairing changes, so a stale migration is never shown against new models.
  useEffect(() => {
    setResult(undefined);
    setFailure(undefined);
  }, [from, to]);

  const load = useCallback(async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      setResult(await api.migration({ from, to, dropColumns }));
    } catch (err: unknown) {
      setFailure(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [from, to, dropColumns]);

  if (models.length === 0) return null;

  const blocked = result?.scripts.filter((script) => script.requiresRecreate).length ?? 0;

  return (
    <section className="migration">
      <div className="row">
        <h2 className="glance__title grow">Migration</h2>
        <label className="row small muted" style={{ gap: "var(--s2)" }}>
          <input
            type="checkbox"
            checked={dropColumns}
            onChange={(event) => setDropColumns(event.target.checked)}
          />
          include DROP COLUMN
        </label>
        <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? "Generating…" : result ? "Regenerate" : "Generate DDL"}
        </button>
      </div>

      <p className="muted small">
        The statements that would make <span className="mono">{from}</span> match{" "}
        <span className="mono">{to}</span>. Nothing is run, this is a script to review.
      </p>

      {failure ? <p className="err-text small">{failure}</p> : null}

      {result ? (
        result.scripts.length === 0 ? (
          <p className="muted small">
            No table-level differences to migrate.
          </p>
        ) : (
          <div className="stack">
            {blocked > 0 ? (
              <p className="small" style={{ color: "var(--warn-text)" }}>
                <Icon name="warn" size={12} /> {blocked} table
                {blocked === 1 ? "" : "s"} cannot be migrated in place and need rebuilding. The
                reasons are in the scripts below.
              </p>
            ) : null}

            {result.extraTables.length > 0 ? (
              <p className="muted small">
                {result.extraTables.length === 1
                  ? `1 table in ${from} has`
                  : `${result.extraTables.length} tables in ${from} have`}{" "}
                no counterpart in {to} and {result.extraTables.length === 1 ? "is" : "are"} left
                alone:{" "}
                <span className="mono">{result.extraTables.join(", ")}</span>
              </p>
            ) : null}

            {result.scripts.map((script) => (
              <details key={script.table} className="migration__table">
                <summary>
                  <span className="mono">{script.table}</span>
                  <span className="muted small">
                    {script.missing
                      ? "does not exist yet"
                      : `${script.changes.length} change${script.changes.length === 1 ? "" : "s"}`}
                  </span>
                  {script.requiresRecreate ? (
                    <span className="badge badge--warn">needs rebuild</span>
                  ) : null}
                </summary>
                <pre className="codeblock">{script.sql || "-- nothing to run"}</pre>
              </details>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}

function Side({
  label,
  value,
  models,
  onChange,
}: {
  label: string;
  value: string;
  models: { name: string; tier: string; namespace?: string }[];
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="field" style={{ minWidth: 0, flex: 1 }}>
      <span className="field__label">{label}</span>
      <select className="input mono" value={value} onChange={(event) => onChange(event.target.value)}>
        {models.map((model) => (
          <option key={model.name} value={model.name}>
            {model.namespace ? `${model.namespace} · ` : ""}
            {model.name} ({model.tier})
          </option>
        ))}
      </select>
    </label>
  );
}
