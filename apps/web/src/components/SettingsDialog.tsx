import { useEffect, useState } from "react";
import { Icon } from "../ui";
import { api, ApiError } from "../api";
import { UsersPane } from "./UsersPane";
import { useWorkspace } from "../app/WorkspaceContext";
import type { GitStatus, LayoutPreview, PublicUser, SettingsResponse } from "../types";

/**
 * Settings.
 *
 * A vertical nav beside a pane, the way Excel's options dialog works, because there
 * are more settings than fit on one screen and grouping them is the only thing that
 * makes them findable.
 *
 * Every write goes to `strata.config.yaml` in the customer's repo, which means settings
 * changes are themselves reviewable in a pull request. That is unusual and it is the
 * point.
 */

type Section =
  | "general"
  | "conventions"
  | "layout"
  | "ddl"
  | "lint"
  | "git"
  | "dataform"
  | "users"
  | "appearance"
  | "about";

const SECTIONS: { id: Section; label: string; adminOnly?: boolean }[] = [
  { id: "general", label: "General" },
  { id: "conventions", label: "Conventions" },
  { id: "layout", label: "File layout" },
  { id: "ddl", label: "DDL output" },
  { id: "lint", label: "Validation rules" },
  { id: "git", label: "Git and secrets", adminOnly: true },
  { id: "dataform", label: "Dataform" },
  { id: "users", label: "Users", adminOnly: true },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

interface Props {
  initialSection?: string;
  currentUser: PublicUser | null;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  onClose: () => void;
  onChanged: () => void;
}

export function SettingsDialog({
  initialSection,
  currentUser,
  theme,
  onThemeChange,
  onClose,
  onChanged,
}: Props): JSX.Element {
  const isAdmin = currentUser?.role === "admin";
  const [section, setSection] = useState<Section>(
    (SECTIONS.find((s) => s.id === initialSection)?.id ?? "general") as Section,
  );
  const [data, setData] = useState<SettingsResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .settings()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog dialog--lg" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2 className="dialog__title">Settings</h2>
          <button type="button" className="iconbtn" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="settings">
          <nav className="settings__nav">
            {SECTIONS.filter((entry) => !entry.adminOnly || isAdmin).map((entry) => (
              <button
                key={entry.id}
                type="button"
                /*
                 * `--on`, not `--active`. The stylesheet only ever defined `--on`, so the
                 * selected section carried no highlight at all and the nav gave no
                 * indication of where you were.
                 */
                className={`settings__navitem${section === entry.id ? " settings__navitem--on" : ""}`}
                aria-current={section === entry.id ? "true" : undefined}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className="settings__pane">
            {error ? <div className="callout callout--err">{error}</div> : null}
            {!data ? (
              <p className="muted">Loading…</p>
            ) : section === "general" ? (
              <GeneralPane data={data} isAdmin={isAdmin} onChanged={onChanged} />
            ) : section === "conventions" ? (
              <ConventionsPane data={data} isAdmin={isAdmin} onChanged={onChanged} />
            ) : section === "git" ? (
              <GitPane isAdmin={isAdmin} />
            ) : section === "layout" ? (
              <LayoutPane data={data} isAdmin={isAdmin} onChanged={onChanged} />
            ) : section === "ddl" ? (
              <DdlPane data={data} isAdmin={isAdmin} onChanged={onChanged} />
            ) : section === "lint" ? (
              <LintPane data={data} isAdmin={isAdmin} onChanged={onChanged} />
            ) : section === "dataform" ? (
              <DataformPane data={data} />
            ) : section === "users" ? (
              <UsersPane currentUser={currentUser} />
            ) : section === "appearance" ? (
              <AppearancePane theme={theme} onThemeChange={onThemeChange} />
            ) : (
              <AboutPane data={data} />
            )}
          </div>
        </div>

        <footer className="dialog__foot">
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Shared save affordance: a button plus the outcome, so feedback is never ambiguous. */
function SaveRow({
  busy,
  message,
  error,
  disabled,
  onSave,
}: {
  busy: boolean;
  message?: string;
  error?: string;
  disabled?: boolean;
  onSave: () => void;
}): JSX.Element {
  return (
    <div className="row" style={{ marginTop: "var(--s6)" }}>
      <button type="button" className="btn" disabled={busy || disabled} onClick={onSave}>
        {busy ? "Saving…" : "Save"}
      </button>
      {error ? <span className="err-text small">{error}</span> : null}
      {!error && message ? <span className="muted small">{message}</span> : null}
    </div>
  );
}

function useSaver(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function save(patch: Parameters<typeof api.saveSettings>[0]): Promise<void> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await api.saveSettings(patch);
      setMessage("saved to strata.config.yaml");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, error, save };
}

function GeneralPane({
  data,
  isAdmin,
  onChanged,
}: {
  data: SettingsResponse;
  isAdmin: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [name, setName] = useState(data.settings.name);
  const [description, setDescription] = useState(data.settings.description);
  const [project, setProject] = useState(data.settings.bigquery.project);
  const [location, setLocation] = useState(data.settings.bigquery.location);
  const saver = useSaver(onChanged);

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Workspace</h3>
        <div className="stack">
          <label className="field field--inline">
            <span className="field__label">Name</span>
            <input className="input" disabled={!isAdmin} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field field--inline">
            <span className="field__label">Description</span>
            <textarea
              className="input"
              rows={3}
              disabled={!isAdmin}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">BigQuery defaults</h3>
        <p className="settings__desc">
          Inherited by physical models that do not name their own target. There is no live
          connection yet, these are used when generating, not for reading the warehouse.
        </p>
        <div className="stack">
          <label className="field field--inline">
            <span className="field__label">Default project</span>
            <input
              className="input"
              disabled={!isAdmin}
              value={project}
              placeholder="acme-analytics-prod"
              onChange={(e) => setProject(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="field__label">Location</span>
            <input
              className="input"
              disabled={!isAdmin}
              value={location}
              placeholder="europe-west2"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
        </div>
      </section>

      {isAdmin ? (
        <SaveRow
          {...saver}
          onSave={() =>
            void saver.save({ name, description, bigquery: { project, location } })
          }
        />
      ) : (
        <div className="callout callout--info">Only administrators can change workspace settings.</div>
      )}
    </>
  );
}

function LayoutPane({
  data,
  isAdmin,
  onChanged,
}: {
  data: SettingsResponse;
  isAdmin: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [preset, setPreset] = useState(data.settings.layout.preset);
  const [slugStyle, setSlugStyle] = useState(data.settings.layout.slugStyle);
  const [preview, setPreview] = useState<LayoutPreview | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function loadPreview(next: string): Promise<void> {
    setPreset(next);
    setMessage(undefined);
    setError(undefined);
    if (next === data.settings.layout.preset) {
      setPreview(undefined);
      return;
    }
    try {
      setPreview(await api.previewLayout(next));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.applyLayout(preset);
      if (slugStyle !== data.settings.layout.slugStyle) {
        await api.saveSettings({ layout: { slugStyle } });
      }
      setMessage(`moved ${result.written} file(s), removed ${result.deleted}`);
      setPreview(undefined);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">How model files are organised</h3>
        <p className="settings__desc">
          Where a file sits carries no meaning, every object names its own kind, id and model
          inside the file. So changing this moves files and changes nothing else. Commit it
          separately from a semantic change and the diff stays reviewable.
        </p>

        <div className="stack">
          <label className="field field--inline">
            <span className="field__label">Layout</span>
            <select
              className="input"
              disabled={!isAdmin}
              value={preset}
              onChange={(event) => void loadPreview(event.target.value)}
            >
              {data.presets.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="field field--inline">
            <span className="field__label">File name style</span>
            <select
              className="input"
              disabled={!isAdmin}
              value={slugStyle}
              onChange={(event) => setSlugStyle(event.target.value)}
            >
              <option value="snake">snake_case</option>
              <option value="kebab">kebab-case</option>
              <option value="preserve">preserve the object name</option>
            </select>
          </label>
        </div>
      </section>

      {preview ? (
        <section className="settings__section">
          <h3 className="settings__heading">
            {preview.moves.length} object(s) would move into {preview.fileCount} file(s)
          </h3>
          <table className="dtable">
            <thead>
              <tr>
                <th>Object</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {preview.moves.slice(0, 12).map((move) => (
                <tr key={move.id}>
                  <td>{move.name}</td>
                  <td className="mono muted">{move.from}</td>
                  <td className="mono">{move.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.moves.length > 12 ? (
            <p className="muted small">+{preview.moves.length - 12} more</p>
          ) : null}
        </section>
      ) : null}

      {isAdmin ? (
        <div className="row" style={{ marginTop: "var(--s6)" }}>
          <button
            type="button"
            className="btn"
            disabled={busy || (!preview && slugStyle === data.settings.layout.slugStyle)}
            onClick={() => void apply()}
          >
            {busy ? "Applying…" : "Apply and rewrite files"}
          </button>
          {error ? <span className="err-text small">{error}</span> : null}
          {!error && message ? <span className="muted small">{message}</span> : null}
        </div>
      ) : (
        <div className="callout callout--info">Only administrators can reorganise the repo.</div>
      )}
    </>
  );
}

function LintPane({
  data,
  isAdmin,
  onChanged,
}: {
  data: SettingsResponse;
  isAdmin: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [strict, setStrict] = useState(data.settings.lint.strict);
  const [rules, setRules] = useState<Record<string, string>>(data.settings.lint.rules);
  const saver = useSaver(onChanged);

  const groups = [...new Set(data.tunableRules.map((rule) => rule.group))];

  function setRule(code: string, value: string): void {
    setRules((current) => {
      const next = { ...current };
      // "default" means "no override", so remove the key entirely rather than
      // writing a value that pins the rule at its current severity forever.
      if (value === "default") delete next[code];
      else next[code] = value;
      return next;
    });
  }

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Validation severity</h3>
        <p className="settings__desc">
          These are the same rules <code>strata check</code> runs in CI. Demote the ones you cannot
          fix today, keep the gate on everything else, and ratchet up over time, that is how a
          team adopts this against an estate that already exists, instead of switching the
          pipeline off.
        </p>

        <label className="checkline">
          <input
            type="checkbox"
            disabled={!isAdmin}
            checked={strict}
            onChange={(event) => setStrict(event.target.checked)}
          />
          Treat warnings as errors (fails CI on any warning)
        </label>
      </section>

      {groups.map((group) => (
        <section key={group} className="settings__section">
          <h3 className="settings__heading">{group}</h3>
          <table className="dtable">
            <thead>
              <tr>
                <th>Rule</th>
                <th style={{ width: 130 }}>Severity</th>
              </tr>
            </thead>
            <tbody>
              {data.tunableRules
                .filter((rule) => rule.group === group)
                .map((rule) => (
                  <tr key={rule.code}>
                    <td>
                      {rule.label}
                      <div className="mono muted">{rule.code}</div>
                    </td>
                    <td>
                      <select
                        className="input"
                        disabled={!isAdmin}
                        value={rules[rule.code] ?? "default"}
                        onChange={(event) => setRule(rule.code, event.target.value)}
                      >
                        <option value="default">default</option>
                        <option value="error">error</option>
                        <option value="warning">warning</option>
                        <option value="info">info</option>
                        <option value="off">off</option>
                      </select>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}

      {isAdmin ? (
        <SaveRow {...saver} onSave={() => void saver.save({ lint: { strict, rules } })} />
      ) : (
        <div className="callout callout--info">Only administrators can change validation rules.</div>
      )}
    </>
  );
}

function DataformPane({ data }: { data: SettingsResponse }): JSX.Element {
  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Connected Dataform repositories</h3>
        <p className="settings__desc">
          Edit these in <code>strata.config.yaml</code> for now, the connection shape includes path
          templates and managed-file globs that need care, and a half-complete form would be worse
          than the file.
        </p>

        {data.settings.dataform.length === 0 ? (
          <div className="callout callout--info">No Dataform repositories are connected.</div>
        ) : (
          <table className="dtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Target</th>
                <th>Models</th>
                <th>Files we own</th>
              </tr>
            </thead>
            <tbody>
              {data.settings.dataform.map((connection) => (
                <tr key={connection.name}>
                  <td>{connection.name}</td>
                  <td className="mono muted">
                    {connection.gcp
                      ? `${connection.gcp.project}/${connection.gcp.location}/${connection.gcp.repository}`
                      : (connection.remote ?? "-")}
                  </td>
                  <td>{connection.models.join(", ") || "all"}</td>
                  <td className="mono muted">{connection.managed.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="settings__section">
        <div className="callout callout--info">
          SQLX generation reads these connections for their path templates. Preview and write
          it from <strong>Generated output → Dataform</strong>, or run{" "}
          <code>strata generate dataform</code> in CI.
        </div>
      </section>
    </>
  );
}

/**
 * House conventions, written as prose.
 *
 * The deterministic rules under Validation cover what a rules engine can decide, * casing, prefixes, lengths. Plenty of real conventions are not like that: "every fact
 * needs a date dimension", "money is NUMERIC(18, 2) and ends in `_amount`". Writing them
 * here keeps them versioned and reviewed alongside the model instead of living in
 * somebody's head or a Confluence page nobody reads.
 */
function ConventionsPane({
  data,
  isAdmin,
  onChanged,
}: {
  data: SettingsResponse;
  isAdmin: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [text, setText] = useState(data.settings.conventions);
  const saver = useSaver(onChanged);

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">House conventions</h3>
        <p className="settings__desc">
          Written in plain language, stored in <code>strata.config.yaml</code>, versioned with the
          model. Use this for the rules a pattern-matcher cannot express.
        </p>

        <textarea
          className="input"
          rows={14}
          disabled={!isAdmin}
          value={text}
          placeholder={[
            "Every fact table must join to a date dimension.",
            "Money columns end in _amount and use NUMERIC(18, 2).",
            "Dimensions that change slowly must be SCD2, with valid_from / valid_to / is_current.",
            "Never abbreviate outside the approved dictionary.",
            "Every column holding personal data must carry a classification.",
          ].join("\n")}
          onChange={(event) => setText(event.target.value)}
        />

        {isAdmin ? <SaveRow {...saver} onSave={() => void saver.save({ conventions: text })} /> : null}
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">What checks these</h3>
        <div className="callout callout--warn">
          <strong>Not enforced yet.</strong> These are stored and versioned, but nothing reads
          them at the moment. The intended path is a model review before a change is proposed, the conventions plus the diff go to your own Vertex endpoint, and anything that looks
          off is reported as a finding you can accept or wave through.
          <br />
          <br />
          The deterministic rules under <strong>Validation rules</strong> already run on every
          change and gate a pull request in CI.
        </div>
      </section>
    </>
  );
}

/**
 * Where generated DDL lands, and what the files are called.
 *
 * The config has supported this from the start; there was simply no way to reach it
 * without hand-editing `strata.config.yaml`, which makes a configurable thing effectively
 * fixed. Teams keep DDL in different places, `DDL/`, `sql/ddl/`, `definitions/`,
 * one folder per dataset or one flat pile, and having to open a text editor to change
 * that is exactly the friction this tool is meant to remove.
 *
 * The preview is not decoration. A path template is hard to reason about in the
 * abstract, and seeing the actual filenames it produces turns a guess into a decision.
 */
function DdlPane({
  data,
  isAdmin,
  onChanged,
}: {
  data: SettingsResponse;
  isAdmin: boolean;
  onChanged: () => void;
}): JSX.Element {
  const [folder, setFolder] = useState(data.settings.ddl.outputFolder);
  const [template, setTemplate] = useState(data.settings.ddl.pathTemplate);
  const [orReplace, setOrReplace] = useState(data.settings.ddl.orReplace);
  const [preview, setPreview] = useState<string[]>([]);
  const saver = useSaver(onChanged);

  // Ask the server what these settings would actually produce, rather than
  // reimplementing the template renderer in the browser and letting the two drift.
  useEffect(() => {
    let cancelled = false;
    api
      .generateDdl({})
      .then((result) => {
        if (!cancelled) setPreview(result.files.map((file) => file.path));
      })
      .catch(() => {
        if (!cancelled) setPreview([]);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Generated DDL</h3>
        <p className="settings__desc">
          Where <strong>Generated output</strong> writes files in your repo. Everything here is
          generated, nothing overwrites a file a person wrote.
        </p>

        <label className="field">
          <span className="field__label">Output folder</span>
          <input
            className="input mono"
            disabled={!isAdmin}
            value={folder}
            placeholder="DDL"
            onChange={(event) => setFolder(event.target.value)}
          />
          <span className="field__hint">
            Relative to the repo root. <span className="mono">DDL</span>,{" "}
            <span className="mono">sql/ddl</span>, <span className="mono">definitions</span>, whatever
            your Dataform team expects to find.
          </span>
        </label>

        <label className="field">
          <span className="field__label">File path template</span>
          <input
            className="input mono"
            disabled={!isAdmin}
            value={template}
            placeholder="{dataset}/{name}.sql"
            onChange={(event) => setTemplate(event.target.value)}
          />
          <span className="field__hint">
            <span className="mono">{"{dataset}"}</span> is the table&apos;s BigQuery dataset,{" "}
            <span className="mono">{"{name}"}</span> the table name, and{" "}
            <span className="mono">{"{layer}"}</span> its layer (staging, mart). Drop the slash for a
            flat folder: <span className="mono">{"{name}.sql"}</span>.
          </span>
        </label>

        <label className="check">
          <input
            type="checkbox"
            disabled={!isAdmin}
            checked={orReplace}
            onChange={(event) => setOrReplace(event.target.checked)}
          />
          <span>
            Use <span className="mono">CREATE OR REPLACE TABLE</span>
            <span className="field__hint">
              Off means <span className="mono">CREATE TABLE IF NOT EXISTS</span>, which will not
              touch a table that already exists. Turn this on only if the DDL is the sole authority
              over these tables, replacing drops the data.
            </span>
          </span>
        </label>

        {isAdmin ? (
          <SaveRow
            {...saver}
            onSave={() =>
              void saver.save({
                ddl: { outputFolder: folder.trim() || "DDL", pathTemplate: template.trim() || "{dataset}/{name}.sql", orReplace },
              })
            }
          />
        ) : null}
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">What this produces now</h3>
        {preview.length === 0 ? (
          <p className="muted">
            Nothing yet, this workspace has no physical model, so there are no tables to generate.
          </p>
        ) : (
          <>
            <p className="settings__desc">
              Current saved settings, against the tables in this workspace. Save to see changes
              reflected here.
            </p>
            <pre className="pre pre--inline">{preview.join("\n")}</pre>
          </>
        )}
        <div className="callout callout--info">
          <strong>Where do <span className="mono">retail_mart</span> and{" "}
          <span className="mono">retail_staging</span> come from?</strong> Not from this tool, each
          table carries its own <span className="mono">dataset</span>, and the model carries a
          default. Change a table&apos;s dataset and its DDL moves folder to match.
        </div>
      </section>
    </>
  );
}

/**
 * What is actually wired up, end to end.
 *
 * The failure this exists to prevent: paste a token, propose a change, and discover only
 * *after* the commit that there was never an `origin` remote to push to. A token and a
 * remote are two independent requirements, and the settings dialog previously showed one
 * of them, so the natural conclusion from a saved token was that everything was ready.
 *
 * Each line states a fact and, where something is missing, the exact command that fixes
 * it. "Not configured" on its own sends people to the docs; a copyable `git remote add`
 * does not.
 */
function RepoStatus({
  repo,
  tokenConfigured,
  isAdmin,
  onConnected,
}: {
  repo: GitStatus | undefined;
  tokenConfigured: boolean;
  isAdmin: boolean;
  onConnected: (next: GitStatus) => void;
}): JSX.Element {
  if (!repo) return <p className="muted">Loading…</p>;

  if (!repo.isRepo) {
    return (
      <div className="callout callout--warn">
        This workspace is not a git repository, so nothing can be versioned or proposed. Point the
        server at a clone of your model repo with <span className="mono">STRATA_WORKSPACE</span>, or
        run <span className="mono">git init</span> here.
      </div>
    );
  }

  return (
    <>
      <dl className="kv">
        <dt>Branch</dt>
        <dd className="mono">{repo.branch ?? "detached"}</dd>

        <dt>Remote</dt>
        <dd className={repo.remoteUrl ? "mono" : "muted"}>{repo.remoteUrl ?? "none configured"}</dd>

        <dt>GitHub repo</dt>
        <dd className={repo.github ? "mono" : "muted"}>
          {repo.github ? `${repo.github.owner}/${repo.github.repo}` : "not detected"}
        </dd>

        <dt>Uncommitted</dt>
        <dd>{repo.clean ? "nothing" : `${repo.files.length} file(s)`}</dd>
      </dl>

      {!repo.remoteUrl ? (
        <div className="callout callout--warn">
          <strong>No <span className="mono">origin</span> remote.</strong> Commits will stay on this
          machine and no pull request can be opened, however the token is set.
        </div>
      ) : !repo.github ? (
        <div className="callout callout--warn">
          The remote is not a GitHub URL that this tool recognises, so it will push but leave the
          pull request to you.
        </div>
      ) : !tokenConfigured ? (
        <div className="callout callout--info">
          Remote is ready. Add a token below and pull requests will open automatically; without one
          you get a prefilled compare link instead.
        </div>
      ) : (
        <div className="callout callout--ok">
          Ready, changes will branch, push to <span className="mono">{repo.defaultBranch ?? "main"}</span>
          &apos;s remote and open a pull request automatically.
        </div>
      )}

      {isAdmin ? <ConnectRemote current={repo.remoteUrl} onConnected={onConnected} /> : null}
    </>
  );
}

/**
 * Connect the workspace to a repository by pasting its URL.
 *
 * The token supplied below is what authenticates this, so connecting a repo is a URL
 * plus a token rather than a shell into the container to configure a deploy key. The URL
 * is stored without credentials even if the pasted one carried them, and the server
 * refuses to save a remote it cannot actually reach.
 */
function ConnectRemote({
  current,
  onConnected,
}: {
  current: string | undefined;
  onConnected: (next: GitStatus) => void;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      const next = await api.setGitRemote(url.trim());
      onConnected(next);
      setUrl("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginTop: "var(--s5)" }}>
      <label className="field">
        <span className="field__label">{current ? "Change repository" : "Connect a repository"}</span>
        <input
          className="input mono"
          value={url}
          placeholder="https://github.com/owner/repo.git"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim()) void connect();
          }}
        />
        <span className="field__hint">
          HTTPS, not SSH, the token authenticates the push. Verified before it is saved, so a
          wrong URL or a token without access fails here rather than halfway through a proposal.
        </span>
      </label>
      <div className="row">
        <button type="button" className="btn" disabled={busy || !url.trim()} onClick={() => void connect()}>
          {busy ? "Verifying…" : "Connect"}
        </button>
        {error ? <span className="err-text small">{error}</span> : null}
        {!error && done ? <span className="muted small">Connected and verified.</span> : null}
      </div>
    </div>
  );
}

/**
 * Git credentials.
 *
 * Three ways to supply a token, and the precedence matters: a mounted secret file or an
 * environment variable always beats one pasted here, so promoting a deployment to a real
 * secret manager does not require clearing the UI first.
 */
/**
 * Git and secrets, which is two different screens depending on who runs the server.
 *
 * **Self-hosted** owns the workspace and the credential, so it gets the workspace path, a place
 * to store a GitHub token, and instructions that involve environment variables.
 *
 * **Cloud** owns neither. The workspace is a clone of a repository the person chose at sign-in,
 * and the GitHub connection is their own OAuth session. Showing them
 * `STRATA_WORKSPACE`, `git init`, or a field to paste a personal access token is asking them to
 * configure a server they have no access to, and it reads as the product not knowing which of
 * its own modes it is running in.
 */
function GitPane({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const { cloud } = useWorkspace();
  if (cloud?.cloud) return <CloudRepoPane repo={cloud.repo} />;
  return <SelfHostedGitPane isAdmin={isAdmin} />;
}

/** What a hosted customer can actually act on: which repository, and how to change it. */
function CloudRepoPane({ repo }: { repo: string | null }): JSX.Element {
  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Repository</h3>
        <p className="settings__desc">
          Your workspace is a clone of a repository you have access to. Proposing a change commits
          there, pushes, and opens a pull request in that repository.
        </p>
        <dl className="kv">
          <dt>Repository</dt>
          <dd className="mono">{repo ?? "none chosen"}</dd>
        </dl>
        <p className="muted small" style={{ marginTop: "var(--s5)" }}>
          To work somewhere else, sign out and choose another repository. Anyone else with access
          to this one can sign in and work in the same models.
        </p>
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">GitHub connection</h3>
        <p className="settings__desc">
          Taken from the account you signed in with. There is no token to paste and nothing to
          store: Strata acts as you, with the permissions you already have on the repository.
        </p>
        <p className="muted small">
          Revoke it from GitHub under Settings, Applications, Authorized OAuth Apps. Doing so ends
          access here at your next sign-in.
        </p>
      </section>
    </>
  );
}

function SelfHostedGitPane({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const [status, setStatus] = useState<{ configured: boolean; source: string; hint?: string; editable: boolean } | undefined>();
  const [repo, setRepo] = useState<GitStatus | undefined>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api
      .githubTokenStatus()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : String(err)));
    // The token is only half of it. Without a remote there is nowhere to push, and a
    // pasted token looks like it should have been enough, so show both together.
    api.gitStatus().then(setRepo).catch(() => setRepo(undefined));
  }, []);

  async function save(next: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setStatus(await api.setGithubToken(next));
      setToken("");
      setMessage(next ? "Token saved, encrypted at rest." : "Token removed.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const SOURCE_LABEL: Record<string, string> = {
    file: "a mounted secret file (STRATA_GITHUB_TOKEN_FILE)",
    environment: "an environment variable (GITHUB_TOKEN)",
    stored: "pasted here, encrypted at rest",
    none: "not configured",
  };

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Repository</h3>
        <p className="settings__desc">
          The workspace this server has open. Proposing a change commits here, pushes to{" "}
          <span className="mono">origin</span>, then opens a pull request.
        </p>
        <RepoStatus
          repo={repo}
          tokenConfigured={status?.configured ?? false}
          isAdmin={isAdmin}
          onConnected={setRepo}
        />
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">GitHub token</h3>
        <p className="settings__desc">
          Used for one thing: opening the pull request. It is <em>not</em> what pushes the branch, that uses the container&apos;s own git credentials. Without a token the tool still
          branches, commits and pushes, then hands you a link to open the PR yourself.
        </p>

        {!status ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className={status.configured ? "callout callout--info" : "callout callout--warn"}>
              {status.configured ? (
                <>
                  Configured from <strong>{SOURCE_LABEL[status.source]}</strong>
                  {status.hint ? (
                    <>
                      {" "}, ending <span className="mono">…{status.hint}</span>
                    </>
                  ) : null}
                  .
                </>
              ) : (
                <>No token configured, so pull requests must be opened by hand.</>
              )}
            </div>

            {status.editable ? (
              <div className="stack" style={{ marginTop: "var(--s5)" }}>
                <label className="field">
                  <span className="field__label">Paste a token</span>
                  <input
                    className="input mono"
                    type="password"
                    value={token}
                    placeholder="ghp_… or github_pat_…"
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <span className="field__hint">
                    Needs <span className="mono">repo</span> scope for a classic token, or contents
                    and pull-requests write for a fine-grained one. Stored encrypted in the data
                    volume, never in your model repo, and never sent back to the browser.
                  </span>
                </label>
                <div className="row">
                  <button type="button" className="btn" disabled={busy || !token.trim()} onClick={() => void save(token.trim())}>
                    {busy ? "Saving…" : "Save token"}
                  </button>
                  {status.configured ? (
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void save("")}>
                      Remove
                    </button>
                  ) : null}
                  {error ? <span className="err-text small">{error}</span> : null}
                  {!error && message ? <span className="muted small">{message}</span> : null}
                </div>
              </div>
            ) : (
              <div className="callout callout--info" style={{ marginTop: "var(--s5)" }}>
                Supplied by the deployment, so it cannot be changed here. Update it at the source
                and restart.
              </div>
            )}
          </>
        )}
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">Using a secret manager</h3>
        <p className="settings__desc">
          Preferred for anything beyond a small team: the token never touches our disk. Google
          Secret Manager, Vault and Kubernetes secrets all present as a mounted file, so one
          setting covers all of them.
        </p>
        <pre className="diff" style={{ borderRadius: "var(--r-sm)" }}>
{`# Google Secret Manager via the CSI driver, or any mounted secret
STRATA_GITHUB_TOKEN_FILE=/var/secrets/github/token

# Or plainly, for a small deployment
GITHUB_TOKEN=ghp_...`}
        </pre>
        <p className="settings__desc">
          A mounted file wins over an environment variable, which wins over a token pasted above.
        </p>
      </section>
    </>
  );
}

function AppearancePane({
  theme,
  onThemeChange,
}: {
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}): JSX.Element {
  return (
    <section className="settings__section">
      <h3 className="settings__heading">Theme</h3>
      <p className="settings__desc">Stored in this browser, not in the workspace.</p>
      <div className="stack">
        {(["light", "dark"] as const).map((option) => (
          <label key={option} className="checkline">
            <input
              type="radio"
              name="theme"
              checked={theme === option}
              onChange={() => onThemeChange(option)}
            />
            {option === "light" ? "Light" : "Dark"}
          </label>
        ))}
      </div>
    </section>
  );
}

function AboutPane({ data }: { data: SettingsResponse }): JSX.Element {
  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">This instance</h3>
        <table className="dtable">
          <tbody>
            <tr>
              <td>Workspace</td>
              <td className="mono">{data.server.workspace}</td>
            </tr>
            <tr>
              <td>Auth data directory</td>
              <td className="mono">{data.server.dataDir}</td>
            </tr>
            <tr>
              <td>Authentication</td>
              <td>{data.auth.enabled ? "enabled" : "disabled (STRATA_AUTH=off)"}</td>
            </tr>
            <tr>
              <td>GitHub token</td>
              <td>
                {data.server.githubTokenConfigured
                  ? "configured, pull requests open automatically"
                  : "not set, you get a compare link instead"}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="settings__section">
        <h3 className="settings__heading">Not built yet</h3>
        <ul className="settings__desc">
          <li>BigQuery introspection and drift detection</li>
          <li>Dataform SQLX generation</li>
          <li>Visual and semantic model diff</li>
          <li>Drag-to-connect relationships on the canvas</li>
          <li>SSO (OIDC/SAML) and SCIM provisioning</li>
        </ul>
      </section>
    </>
  );
}
