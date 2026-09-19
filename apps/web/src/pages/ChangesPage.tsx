import { useCallback, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Icon,
  useFeedback,
} from "../ui";
import type { ChangedFile } from "../types";

/**
 * Uncommitted work, and the route to a pull request.
 *
 * The whole premise of the tool is that an edit in the UI becomes a reviewable pull
 * request rather than a mutation nobody can audit, so this page is where that promise is
 * kept, and it needs to read like a source-control view rather than a file list.
 *
 * Diffs open in a dialog rather than inline. Model YAML diffs are long, and expanding one
 * inline pushes every other file off screen, which is exactly when you lose track of what
 * you were reviewing.
 */

const LABEL_TONE: Record<ChangedFile["label"], "ok" | "warn" | "err" | "neutral"> = {
  added: "ok",
  untracked: "ok",
  modified: "warn",
  renamed: "warn",
  deleted: "err",
};

/** One letter, as an editor's file tree shows: A added, M modified, D deleted. */
const LABEL_LETTER: Record<ChangedFile["label"], string> = {
  added: "A",
  untracked: "U",
  modified: "M",
  renamed: "R",
  deleted: "D",
};

export function ChangesPage({ onPropose }: { onPropose: () => void }): JSX.Element {
  const ui = useFeedback();
  const { git, canEdit, refresh, workspace } = useWorkspace();
  const [diff, setDiff] = useState<{ path: string; text: string } | undefined>();
  const [busy, setBusy] = useState(false);

  const showDiff = useCallback(async (path: string) => {
    const result = await api.gitDiff(path);
    setDiff({
      path,
      text: result.diff || "(no textual diff, the file is new, so every line is an addition)",
    });
  }, []);

  const discardAll = useCallback(async () => {
    if (!git?.files.length) return;
    const ok = await ui.confirm({
      title: "Discard all changes?",
      message: `${git.files.length} uncommitted file(s) will be reverted to their last committed state. This cannot be undone from inside the tool.`,
      confirmLabel: "Discard everything",
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    await ui.attempt(async () => {
      await api.discard(git.files.map((file) => file.path));
      refresh();
    }, "Could not discard");
    setBusy(false);
  }, [git, refresh, ui]);

  if (!git?.isRepo) {
    return (
      <Page title="Changes" subtitle="Uncommitted model edits, and the route to a pull request">
        <Callout tone="warn" title="This workspace is not a git repository">
          The model is files on disk, but there is no repository around them, so nothing can
          be committed, and no pull request can be opened. Run <code>git init</code> in{" "}
          <span className="mono">{workspace?.root}</span> and add a remote, or point the
          server at an existing clone.
        </Callout>
      </Page>
    );
  }

  const errors = workspace?.diagnostics.error ?? 0;

  return (
    <Page
      title="Changes"
      subtitle={`On ${git.branch ?? "a detached HEAD"}${
        git.upstream ? ` · tracking ${git.upstream}` : " · no upstream"
      }`}
      badge={git.files.length > 0 ? <Badge tone="warn">{git.files.length} uncommitted</Badge> : null}
      actions={
        git.files.length > 0 ? (
          <>
            <Button variant="ghost" disabled={!canEdit || busy} onClick={() => void discardAll()}>
              Discard all
            </Button>
            <Button icon="pr" variant="primary" disabled={!canEdit} onClick={onPropose}>
              Propose changes
            </Button>
          </>
        ) : null
      }
    >
      {git.files.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing has changed"
          body="Every model file matches the last commit. Edit a diagram or an object and the files you touch will appear here, ready to review and propose."
          action={
            <Button icon="layers" variant="primary" onClick={() => window.history.back()}>
              Back to the model
            </Button>
          }
        />
      ) : (
        <div className="stack">
          {errors > 0 ? (
            <Callout
              tone="err"
              title={`The model has ${errors} validation error${errors === 1 ? "" : "s"}`}
            >
              Proposing is allowed but will ask you to confirm, <code>strata check</code> would
              fail on this branch, so the pull request could not merge as it stands.
            </Callout>
          ) : (
            <Callout tone="ok" title="The model is valid">
              <code>strata check</code> passes, so this change will clear the CI gate.
            </Callout>
          )}

          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>State</th>
                  <th>File</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {git.files.map((file) => (
                  <tr key={file.path}>
                    <td>
                      <Badge tone={LABEL_TONE[file.label]} title={file.label}>
                        {LABEL_LETTER[file.label]}
                      </Badge>
                    </td>
                    <td className="mono truncate-start" title={file.path}>
                      {file.path}
                    </td>
                    <td className="table__actions">
                      <Button size="sm" variant="ghost" onClick={() => void showDiff(file.path)}>
                        View diff
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted small">
            Propose branches, commits, pushes and opens a pull request. Your models stay a
            normal git checkout throughout, <code>git log</code> in the workspace shows
            exactly what the tool did.
          </p>
        </div>
      )}

      {diff ? (
        <Dialog
          title={diff.path}
          size="xl"
          onClose={() => setDiff(undefined)}
          footer={<Button onClick={() => setDiff(undefined)}>Close</Button>}
        >
          <pre className="diff" style={{ maxHeight: "58vh" }}>
            {diff.text.split("\n").map((line, index) => (
              <div key={index} className={diffClass(line)}>
                {line}
              </div>
            ))}
          </pre>
        </Dialog>
      ) : null}
    </Page>
  );
}

function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff__meta";
  if (line.startsWith("@@")) return "diff__hunk";
  if (line.startsWith("+")) return "diff__add";
  if (line.startsWith("-")) return "diff__del";
  return "diff__ctx";
}

/** Re-exported so the propose dialog and the output page can render diffs identically. */
export { diffClass as diffLineClass };

/** A small inline icon row used by the output page for parity with this one. */
export function FileStateIcon({ label }: { label: ChangedFile["label"] }): JSX.Element {
  return <Icon name={label === "deleted" ? "trash" : "doc"} size={13} className="muted" />;
}
