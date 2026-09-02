import { useEffect, useState } from "react";
import { Icon } from "../ui";
import { api, ApiError } from "../api";
import type { BranchList, Diagnostic, GitStatus, ProposeResult } from "../types";

/**
 * Turn pending edits into a pull request.
 *
 * A modal rather than a sidebar section: this is a deliberate, one-at-a-time action
 * with consequences outside the tool, and it deserves the user's whole attention for
 * the ten seconds it takes.
 */

interface Props {
  git: GitStatus;
  onClose: () => void;
  onDone: () => void;
}

export function ProposeDialog({ git, onClose, onDone }: Props): JSX.Element {
  /**
   * Stay on the branch you are already on.
   *
   * Proposing checks out the new branch and leaves you there, so suggesting a fresh
   * random name every time meant the second round of edits forked *off* the first, * a chain of branches and a pull request per save. If you are already on a working
   * branch, adding to it is almost always what you meant.
   */
  const onWorkingBranch = Boolean(git.branch && git.branch !== (git.defaultBranch ?? "main"));
  const [branch, setBranch] = useState(onWorkingBranch ? git.branch! : suggestBranchName());
  const continuing = branch === git.branch && onWorkingBranch;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [blocked, setBlocked] = useState<Diagnostic[] | undefined>();
  const [result, setResult] = useState<ProposeResult | undefined>();

  const [branches, setBranches] = useState<BranchList | undefined>();
  const [base, setBase] = useState<string>(git.defaultBranch ?? "");

  useEffect(() => {
    api
      .gitBranches()
      .then((list) => {
        setBranches(list);
        // Prefer the repo's real default. Falling back to the first *remote* branch
        // matters: a local-only branch cannot be a base, and offering one as the
        // starting value would fail on the first click.
        setBase((chosen) => chosen || list.defaultBranch || list.remote[0] || list.local[0] || "");
      })
      .catch(() => setBranches(undefined));
  }, []);

  /** A base that exists on disk but not on the remote has to be pushed before it can be merged into. */
  const baseNeedsPublishing = Boolean(
    base && branches && !branches.remote.includes(base) && branches.local.includes(base),
  );

  async function propose(allowInvalid = false): Promise<void> {
    setBusy(true);
    setError(undefined);
    setBlocked(undefined);
    try {
      const proposed = await api.propose({
        branch: branch.trim(),
        title: title.trim() || `Model changes on ${branch.trim()}`,
        body,
        ...(base ? { base } : {}),
        ...(baseNeedsPublishing ? { publishBase: true } : {}),
        ...(allowInvalid ? { allowInvalid: true } : {}),
      });
      setResult(proposed);
      onDone();
    } catch (err) {
      // Being blocked by validation is the gate working, not a failure, show what is
      // wrong and offer to proceed rather than dead-ending.
      if (err instanceof ApiError && err.isBlockedByValidation) {
        setBlocked(err.validationErrors);
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="overlay" onMouseDown={onClose}>
        <div className="dialog dialog--sm" onMouseDown={(event) => event.stopPropagation()}>
          <header className="dialog__head">
            <h2 className="dialog__title">Changes proposed</h2>
          </header>
          <div className="dialog__body stack">
            <p style={{ margin: 0 }}>
              Committed to <span className="mono">{result.branch}</span>
              {result.pushed ? " and pushed." : " locally."}
            </p>

            {result.pullRequestUrl ? (
              <a className="btn" href={result.pullRequestUrl} target="_blank" rel="noreferrer">
                Open pull request →
              </a>
            ) : result.compareUrl ? (
              <a className="btn" href={result.compareUrl} target="_blank" rel="noreferrer">
                Open the PR form on GitHub →
              </a>
            ) : null}

            {result.warnings.map((warning) => (
              <div key={warning} className="callout callout--warn">
                {warning}
              </div>
            ))}
          </div>
          <footer className="dialog__foot">
            <button type="button" className="btn" onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog dialog--sm" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2 className="dialog__title">Propose changes</h2>
          <button type="button" className="iconbtn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog__body stack">
          {/*
            Said before the commit, not after. Discovering there is nowhere to push once
            the work is already on a local branch is the wrong order to learn it in.
          */}
          {!git.remoteUrl ? (
            <div className="callout callout--warn">
              <strong>No <span className="mono">origin</span> remote.</strong> This will commit to a
              local branch only, nothing reaches GitHub, and no pull request opens. Settings → Git
              shows how to connect one.
            </div>
          ) : null}

          <ChangeSummary files={git.files} />

          <label className="field">
            <span className="field__label">Branch</span>
            <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
            <span className="field__hint">
              {continuing
                ? "Adding to the branch you are already on, so this updates the same pull request."
                : "Opens a new pull request."}
            </span>
          </label>

          {/*
            The base was previously fixed to the detected default, which is wrong for any
            repo whose default is not `main`, including one where the first branch ever
            pushed became the default by accident. It is a choice, so it is a field.
          */}
          <label className="field">
            <span className="field__label">Merge into</span>
            <select className="input mono" value={base} onChange={(e) => setBase(e.target.value)}>
              {!branches ? <option value={base}>{base || "loading…"}</option> : null}
              {branches?.remote.map((name) => (
                <option key={`r:${name}`} value={name}>
                  {name}
                  {name === branches.defaultBranch ? "  (default)" : ""}
                </option>
              ))}
              {branches?.local
                .filter((name) => !branches.remote.includes(name) && name !== branch)
                .map((name) => (
                  <option key={`l:${name}`} value={name}>
                    {name}  (not on GitHub yet)
                  </option>
                ))}
            </select>
            <span className="field__hint">
              The branch this pull request asks to merge into.
            </span>
          </label>

          {baseNeedsPublishing ? (
            <div className="callout callout--info">
              <span className="mono">{base}</span> exists here but has never been pushed, so GitHub
              has nothing to merge into yet. It will be pushed first, then the pull request opens
              against it.
            </div>
          ) : null}

          {!continuing && onWorkingBranch ? (
            <div className="callout callout--warn">
              You are on <span className="mono">{git.branch}</span>, so the new branch starts from
              there and the pull request will include its commits too. Switch to{" "}
              <span className="mono">{base || "the base"}</span> first if you want only this change.
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">Title</span>
            <input
              className="input"
              value={title}
              placeholder="Add loyalty tier to the customer dimension"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Description</span>
            <textarea
              className="input"
              rows={4}
              value={body}
              placeholder="Why this change, and what it affects downstream."
              onChange={(e) => setBody(e.target.value)}
            />
          </label>

          {error ? <div className="callout callout--err">{error}</div> : null}

          {blocked ? (
            <div className="stack">
              <table className="dtable">
                <tbody>
                  {blocked.slice(0, 6).map((item, index) => (
                    <tr key={`${item.code}-${index}`}>
                      <td className="mono muted" style={{ width: 180 }}>
                        {item.code}
                      </td>
                      <td>{item.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {blocked.length > 6 ? (
                <span className="muted small">+{blocked.length - 6} more</span>
              ) : null}
              <button
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => void propose(true)}
              >
                Propose anyway
              </button>
            </div>
          ) : null}
        </div>

        <footer className="dialog__foot">
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || branch.trim().length === 0}
            onClick={() => void propose()}
          >
            {busy
              ? "Working…"
              : !git.remoteUrl
                ? "Commit locally"
                : git.canOpenPullRequest
                  ? "Commit, push and open PR"
                  : "Commit and push"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Separate model changes from layout changes.
 *
 * Nudging a box is a real, versioned change, the diagram file genuinely differs, but
 * it is not a change to the *model*, and listing the two together makes a cosmetic tweak
 * look like it needs the same scrutiny as adding a column. Splitting them tells a
 * reviewer immediately whether a pull request needs thought or a glance.
 */
function ChangeSummary({ files }: { files: GitStatus["files"] }): JSX.Element {
  const layout = files.filter((file) => isLayoutFile(file.path));
  const model = files.filter((file) => !isLayoutFile(file.path));

  return (
    <div className="callout callout--info stack" style={{ gap: "var(--s3)" }}>
      {model.length > 0 ? (
        <div>
          <strong>
            {model.length} model change{model.length === 1 ? "" : "s"}
          </strong>
          <div className="mono muted">{model.map((f) => shortPath(f.path)).join(", ")}</div>
        </div>
      ) : null}

      {layout.length > 0 ? (
        <div>
          <strong>
            {layout.length} layout change{layout.length === 1 ? "" : "s"}
          </strong>
          <div className="muted">
            Positions, sizes and notes, presentation only, nothing about what the model means.
          </div>
        </div>
      ) : null}

      {model.length === 0 && layout.length > 0 ? (
        <div className="muted">This pull request changes only how the diagram looks.</div>
      ) : null}
    </div>
  );
}

/** Diagram files hold layout; the storage layer keeps them apart for exactly this. */
function isLayoutFile(path: string): boolean {
  return path.includes(".diagram.") || path.includes("/diagrams/");
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1]!.replace(/\.ya?ml$/, "");
}

/** A dated default, so successive proposals do not collide on one branch. */
function suggestBranchName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `model/${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
