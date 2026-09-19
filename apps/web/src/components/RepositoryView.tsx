import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Button, Callout, Icon, Loading } from "../ui";
import { useWorkspace } from "../app/WorkspaceContext";

/**
 * The repository, browsable and editable, one toggle away from the diagram.
 *
 * **Why this exists.** The tool's central claim is that the model *is* files in a git
 * repository, and until now the UI never showed you one. You edited boxes, pressed
 * Propose, and raised a pull request over changes you had never seen. Every other feature
 * here rests on trusting that the files say what the diagram says, and there was no way to
 * check.
 *
 * Modelled on the console-view toggle in Harness CI: the same subject, rendered two ways,
 * with your place preserved across the switch. Select `dim_customer` on the diagram, toggle
 * here, and its YAML is open. Toggle back and the box is still selected. That continuity is
 * the entire point, a toggle that dumps you at the top of a file tree is a second
 * navigation problem, not a second view.
 *
 * Deliberately **not** a split pane. At 1440px the content area is 1192px; halving it gives
 * each side ~590px, and an entity box is 260px wide, you would see two boxes and a
 * scrollbar. A diagram and a code editor both want the full width, which is exactly why
 * Harness toggles rather than splits.
 */

interface Entry {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  status?: string;
}

/** Git status → a one-letter marker, in the vocabulary a diff already uses. */
const MARK: Record<string, { letter: string; tone: string; title: string }> = {
  untracked: { letter: "A", tone: "ok", title: "Untracked, new file" },
  added: { letter: "A", tone: "ok", title: "Added" },
  modified: { letter: "M", tone: "warn", title: "Modified" },
  deleted: { letter: "D", tone: "err", title: "Deleted" },
  renamed: { letter: "R", tone: "accent", title: "Renamed" },
};

export function RepositoryView({
  /** Opened on mount, so a toggle from the diagram lands on what was selected. */
  initialPath,
  onPathChange,
}: {
  initialPath?: string;
  onPathChange?: (path: string | undefined) => void;
}): JSX.Element {
  const { canEdit, refresh, refreshKey } = useWorkspace();

  const [entries, setEntries] = useState<Entry[] | undefined>();
  const [selected, setSelected] = useState<string | undefined>(initialPath);
  const [contents, setContents] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [binary, setBinary] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState("");

  /**
   * Directories the user has closed.
   *
   * Open by default: a model repo is a few dozen files, and starting fully collapsed puts
   * every file two clicks away for no benefit. Only the folds you choose are remembered.
   */
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const dirty = draft !== contents;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ------------------------------------------------------------ tree

  const loadTree = useCallback(async () => {
    try {
      const result = await api.files();
      setEntries(result.entries);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree, refreshKey]);

  // ------------------------------------------------------------ file

  const open = useCallback(
    async (path: string) => {
      /**
       * Do not silently discard an edit.
       *
       * The editor holds unsaved text in a textarea; clicking another file would throw it
       * away with no trace. Asking is the only honest option, and `confirm` is the right
       * weight here, this is a genuine "you will lose work" moment, not a preference.
       */
      if (dirtyRef.current && !window.confirm("Discard unsaved changes to this file?")) return;

      setLoadingFile(true);
      setSelected(path);
      onPathChange?.(path);
      try {
        const result = await api.fileContent(path);
        setContents(result.contents);
        setDraft(result.contents);
        setBinary(result.binary);
        setError(undefined);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
        setContents("");
        setDraft("");
      } finally {
        setLoadingFile(false);
      }
    },
    [onPathChange],
  );

  // Open whatever the diagram had selected, once the tree is known.
  useEffect(() => {
    if (!initialPath || selected) return;
    void open(initialPath);
  }, [initialPath, selected, open]);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.saveFile(selected, draft);
      setContents(draft);
      setError(undefined);
      // The file may have changed any object, or broken the workspace outright; a refresh
      // is what makes Problems and the diagram agree with what was just typed.
      refresh();
      await loadTree();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, loadTree, refresh, selected]);

  /** ⌘S / Ctrl+S, because this is an editor and everyone will try it. */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirtyRef.current && canEdit) void save();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit, save]);

  // ------------------------------------------------------------ tree shape

  /**
   * Hide a directory's contents when it is closed, and everything that fails the filter.
   *
   * Filtering keeps ancestors of a match visible, or a search for `customer` would return
   * a flat list of files with no indication of where any of them live.
   */
  const visible = useMemo(() => {
    const all = entries ?? [];
    const needle = filter.trim().toLowerCase();

    const matches = needle
      ? new Set(
          all
            .filter((entry) => entry.type === "file" && entry.path.toLowerCase().includes(needle))
            .flatMap((entry) => {
              const parts = entry.path.split("/");
              // The file, plus every directory above it.
              return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
            }),
        )
      : undefined;

    return all.filter((entry) => {
      if (matches && !matches.has(entry.path)) return false;
      if (needle) return true;
      // Hidden when any ancestor is closed.
      const parts = entry.path.split("/");
      return !parts.slice(0, -1).some((_, index) => closed.has(parts.slice(0, index + 1).join("/")));
    });
  }, [entries, closed, filter]);

  const changedCount = (entries ?? []).filter((entry) => entry.status).length;

  // ------------------------------------------------------------ render

  if (entries === undefined) return <Loading label="Reading the repository…" />;

  return (
    <div className="repo">
      <aside className="repo__tree">
        <div className="repo__search">
          <Icon name="search" size={13} />
          <input
            value={filter}
            placeholder="Filter files…"
            aria-label="Filter files"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <div className="repo__scroll">
          {visible.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const mark = entry.status ? MARK[entry.status] : undefined;

            if (entry.type === "directory") {
              const isClosed = closed.has(entry.path);
              return (
                <button
                  key={entry.path}
                  type="button"
                  className="repo__row repo__row--dir"
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={() =>
                    setClosed((current) => {
                      const next = new Set(current);
                      if (next.has(entry.path)) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    })
                  }
                >
                  <Icon name={isClosed ? "chevronRight" : "chevronDown"} size={12} />
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            }

            return (
              <button
                key={entry.path}
                type="button"
                className={`repo__row${selected === entry.path ? " repo__row--on" : ""}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                title={entry.path}
                onClick={() => void open(entry.path)}
              >
                <Icon name="doc" size={12} className="repo__icon" />
                <span className="truncate">{entry.name}</span>
                {mark ? (
                  <span className={`repo__mark repo__mark--${mark.tone}`} title={mark.title}>
                    {mark.letter}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/*
          The count that makes Propose legible. "10 changed files" here and "Propose · 10"
          in the top bar are the same number, and seeing them agree is what turns Propose
          from a leap of faith into a review.
        */}
        <p className="repo__foot small muted">
          {changedCount > 0
            ? `${changedCount} changed file${changedCount === 1 ? "" : "s"}, review in Changes, then Propose`
            : "No uncommitted changes"}
        </p>
      </aside>

      <section className="repo__file">
        {error ? <Callout tone="err">{error}</Callout> : null}

        {!selected ? (
          <div className="repo__empty muted">
            <Icon name="folder" size={20} />
            <p>
              Your model is these files. Pick one to read it, or edit it directly, the
              diagram and the files are the same thing.
            </p>
          </div>
        ) : (
          <>
            <header className="repo__head">
              <span className="repo__path mono truncate" title={selected}>
                {selected}
              </span>
              {dirty ? <span className="repo__dirty">unsaved</span> : null}
              <span className="grow" />
              <Button
                variant="primary"
                size="sm"
                loading={saving}
                disabled={!dirty || !canEdit || binary}
                onClick={() => void save()}
              >
                Save
              </Button>
            </header>

            {loadingFile ? (
              <Loading label="Opening…" />
            ) : binary ? (
              <div className="repo__empty muted">
                <Icon name="warn" size={20} />
                <p>This is a binary file, so there is nothing useful to show or edit here.</p>
              </div>
            ) : (
              <textarea
                className="repo__editor mono"
                value={draft}
                spellCheck={false}
                readOnly={!canEdit}
                onChange={(event) => setDraft(event.target.value)}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
