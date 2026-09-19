import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../ui";
import { api, ApiError } from "../api";
import type { ImportAnalysis, ModelView } from "../types";

/**
 * Bring a model in from erwin, a DDL script, or a spreadsheet.
 *
 * Analyse first, always. A migration is the least reversible thing this tool does, * hundreds of objects at once, from a file nobody has read, into a repo other people
 * work in, so the flow is deliberately two steps with the findings in between.
 *
 * The panel that matters most is the one listing what could *not* be mapped. An
 * importer that reports "412 objects imported" and says nothing else is worse than one
 * that reports 400 and names the twelve it dropped: the first leaves you to discover
 * the gaps in production.
 */

interface Props {
  models: ModelView[];
  canEdit: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function ImportDialog({ models, canEdit, onClose, onDone }: Props): JSX.Element {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | undefined>();
  const [model, setModel] = useState(models[models.length - 1]?.name ?? "");
  const [dataset, setDataset] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysis | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<{ written: number; failed: { id: string; error: string }[] } | undefined>();

  const target = models.find((entry) => entry.name === model);

  async function readFile(file: File): Promise<void> {
    setFileName(file.name);
    setAnalysis(undefined);
    setText(await file.text());
  }

  async function analyse(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setAnalysis(await api.analyzeImport({ text, model, ...(dataset ? { dataset } : {}) }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply(overwrite: boolean): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.applyImport({ text, model, overwrite, ...(dataset ? { dataset } : {}) }));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Shell title="Import complete" onClose={onClose}>
        <p style={{ margin: 0 }}>
          <strong>{result.written}</strong> file(s) written into{" "}
          <span className="mono">{model}</span>.
        </p>
        {result.failed.length > 0 ? (
          <div className="callout callout--warn">
            {result.failed.length} object(s) could not be written:
            <ul style={{ margin: "var(--s3) 0 0", paddingLeft: "var(--s7)" }}>
              {result.failed.slice(0, 10).map((entry) => (
                <li key={entry.id}>
                  <span className="mono">{entry.id}</span>, {entry.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="callout callout--info">
          Nothing has left this machine yet. Review the diff under <strong>Changes</strong>, then
          propose it as a pull request like any other edit.
        </div>
        <div className="row">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Shell>
    );
  }

  const errors = analysis?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = analysis?.diagnostics.filter((d) => d.severity !== "error") ?? [];

  return (
    <Shell title="Import a model" onClose={onClose}>
      <div className="callout callout--info">
        Accepts an <strong>erwin XML export</strong>, a <strong>DDL script</strong> (erwin&apos;s
        forward-engineer output, or any <span className="mono">CREATE TABLE</span> file), or a{" "}
        <strong>CSV</strong> with a row per column. The format is detected from the content.
      </div>

      <label className="field">
        <span className="field__label">File</span>
        <input
          type="file"
          className="input"
          accept=".xml,.sql,.ddl,.csv,.tsv,.txt"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readFile(file);
          }}
        />
        <span className="field__hint">Or paste the contents below.</span>
      </label>

      <label className="field">
        <span className="field__label">
          Contents {fileName ? <span className="muted">, {fileName}</span> : null}
        </span>
        <textarea
          className="input mono"
          rows={8}
          value={text}
          placeholder={"CREATE TABLE dim_customer (\n  customer_key INT64 NOT NULL,\n  email STRING\n);"}
          onChange={(event) => {
            setText(event.target.value);
            setAnalysis(undefined);
          }}
        />
      </label>

      <label className="field">
        <span className="field__label">Import into</span>
        <select
          className="input mono"
          value={model}
          onChange={(event) => {
            setModel(event.target.value);
            setAnalysis(undefined);
          }}
        >
          {models.map((entry) => (
            <option key={entry.id} value={entry.name}>
              {entry.namespace ? `${entry.namespace} · ` : ""}
              {entry.name} ({entry.tier})
            </option>
          ))}
        </select>
        <span className="field__hint">
          The tier decides the shape: a physical model gets tables and foreign keys, a logical one
          entities and relationships, a conceptual one bare concepts.
        </span>
      </label>

      {target?.tier === "physical" ? (
        <label className="field">
          <span className="field__label">Default dataset</span>
          <input
            className="input mono"
            value={dataset}
            placeholder="used when the source does not say"
            onChange={(event) => setDataset(event.target.value)}
          />
        </label>
      ) : null}

      {analysis ? (
        <>
          <div className={errors.length > 0 ? "callout callout--err" : "callout callout--ok"}>
            Read as <strong>{analysis.format}</strong> → {analysis.counts.entities} entit(ies),{" "}
            {analysis.counts.relationships} relationship(s), {analysis.counts.domains} domain(s) -{" "}
            <strong>{analysis.counts.objects} object(s)</strong> to write as{" "}
            <strong>{analysis.tier}</strong>.
          </div>

          {analysis.clashes.length > 0 ? (
            <div className="callout callout--warn">
              <strong>{analysis.clashes.length} already exist</strong> and would be replaced:{" "}
              <span className="mono">{analysis.clashes.slice(0, 6).join(", ")}</span>
              {analysis.clashes.length > 6 ? ` and ${analysis.clashes.length - 6} more` : ""}.
            </div>
          ) : null}

          {analysis.objects.length > 0 ? (
            <div className="field">
              <span className="field__label">Will create</span>
              <div className="importlist">
                {analysis.objects.map((object) => (
                  <div key={object.id} className="importlist__row">
                    <Icon name={object.kind === "table" ? "table" : object.kind === "relationship" ? "link" : "entity"} size={13} />
                    <span className="truncate">{object.name}</span>
                    <span className="picker__meta">
                      {object.kind}
                      {object.members > 0 ? ` · ${object.members}` : ""}
                      {object.clashes ? " · replaces" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/*
            The most important panel here. Everything the reader could not place, named,
            so a migration is auditable rather than a number to trust.
          */}
          {analysis.diagnostics.length > 0 ? (
            <div className="field">
              <span className="field__label">
                Not imported, or assumed ({analysis.diagnostics.length})
              </span>
              <div className="importlist">
                {[...errors, ...warnings].slice(0, 60).map((diagnostic, index) => (
                  <div key={index} className={`importlist__row importlist__row--${diagnostic.severity}`}>
                    <span className="truncate">{diagnostic.message}</span>
                    {diagnostic.at ? <span className="picker__meta truncate">{diagnostic.at}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {error ? <div className="callout callout--err">{error}</div> : null}

      <div className="row">
        <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void analyse()}>
          {busy && !analysis ? "Reading…" : "Analyse"}
        </button>

        {analysis && errors.length === 0 ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !canEdit || analysis.counts.objects === 0}
            onClick={() => void apply(analysis.clashes.length > 0)}
          >
            {busy
              ? "Writing…"
              : analysis.clashes.length > 0
                ? `Import and replace ${analysis.clashes.length}`
                : `Import ${analysis.counts.objects} object(s)`}
          </button>
        ) : null}

        <span className="grow" />
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Shell>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2 className="dialog__title">{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="dialog__body stack">{children}</div>
      </div>
    </div>
  );
}
