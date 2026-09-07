import { useEffect, useState } from "react";
import { Icon } from "../ui";
import { api, ApiError } from "../api";
import type { ObjectDetail } from "../types";

/**
 * Raw YAML editing.
 *
 * The escape hatch, and it earns its place: a structured editor can never cover every
 * field of a metamodel this size, and one that silently cannot express something is
 * worse than one that admits it. Nothing in the model is unreachable from here.
 */

interface Props {
  objectId: string;
  onClose: () => void;
  onSaved: () => void;
}

export function YamlDialog({ objectId, onClose, onSaved }: Props): JSX.Element {
  const [detail, setDetail] = useState<ObjectDetail | undefined>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .object(objectId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setText(result.yaml);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [objectId]);

  async function save(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    setError(undefined);
    setIssues([]);
    try {
      await api.updateObjectRaw(objectId, text, detail.revision);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.issues.length > 0) setIssues(err.issues);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const dirty = Boolean(detail) && text !== detail?.yaml;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <div>
            <h2 className="dialog__title">{detail ? detail.object.name : "Loading…"}</h2>
            {detail?.file ? <div className="mono muted">{detail.file}</div> : null}
          </div>
          <button type="button" className="iconbtn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog__body stack">
          <textarea
            className="input yaml-editor"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <span className="field__hint">Validated before writing. Saving rewrites this one file.</span>

          {error ? <div className="callout callout--err">{error}</div> : null}
          {issues.length > 0 ? (
            <ul className="issues">
              {issues.map((issue, index) => (
                <li key={`${issue.path}-${index}`}>
                  <span className="mono">{issue.path || "<root>"}</span> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="dialog__foot">
          {detail?.usedBy.length ? (
            <span className="muted small">referenced by {detail.usedBy.length} object(s)</span>
          ) : null}
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
