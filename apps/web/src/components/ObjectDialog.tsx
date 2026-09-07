import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Icon, useFeedback } from "../ui";
import type { ModelObject, ObjectDetail } from "../types";
import { FIELDS, readPath, writePath } from "./objectFields";

/**
 * Properties for objects that have no place on the canvas.
 *
 * Glossary terms, subject areas, domains, mappings and relationships are real parts of
 * the model but nothing draws them as a box, so clicking one in the explorer used to do
 * nothing at all, which reads as broken. This gives every object somewhere to land.
 *
 * The form covers what each kind is actually made of, and the YAML tab reaches
 * everything else, so no field is unreachable.
 */


interface Props {
  objectId: string;
  onClose: () => void;
  onSaved: () => void;
  onEditYaml: (id: string) => void;
}

export function ObjectDialog({ objectId, onClose, onSaved, onEditYaml }: Props): JSX.Element {
  const ui = useFeedback();
  const [detail, setDetail] = useState<ObjectDetail | undefined>();
  const [draft, setDraft] = useState<ModelObject | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api
      .object(objectId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setDraft(result.object);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [objectId]);

  async function save(): Promise<void> {
    if (!detail || !draft) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.updateObject(objectId, draft, detail.revision);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!draft) return;
    const ok = await ui.confirm({
      title: `Delete ${draft.kind}?`,
      message: `"${draft.name}" will be removed. Review it in Changes before proposing.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      await api.deleteObject(objectId);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  const dirty = Boolean(detail && draft && JSON.stringify(draft) !== JSON.stringify(detail.object));
  const fields = draft ? (FIELDS[draft.kind] ?? []) : [];

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog dialog--sm" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <div style={{ minWidth: 0 }}>
            <div className="muted small" style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {draft?.kind ?? "…"}
            </div>
            <h2 className="dialog__title truncate">{draft?.name ?? "Loading…"}</h2>
            {detail?.file ? <div className="mono muted truncate">{detail.file}</div> : null}
          </div>
          <button type="button" className="iconbtn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog__body stack">
          {!draft ? (
            <p className="muted">{error ?? "Loading…"}</p>
          ) : (
            <>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  className="input"
                  value={String(draft.name ?? "")}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>

              <label className="field">
                <span className="field__label">Description</span>
                <textarea
                  className="input"
                  rows={2}
                  value={String(draft.description ?? "")}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>

              {fields.map((field) => (
                <label key={field.key} className="field">
                  <span className="field__label">{field.label}</span>
                  {field.type === "textarea" ? (
                    <textarea
                      className="input"
                      rows={3}
                      value={readPath(draft, field.key)}
                      placeholder={field.placeholder}
                      onChange={(event) => setDraft(writePath(draft, field.key, event.target.value))}
                    />
                  ) : field.type === "select" ? (
                    <select
                      className="input"
                      value={readPath(draft, field.key)}
                      onChange={(event) => setDraft(writePath(draft, field.key, event.target.value))}
                    >
                      {/*
                        An explicit empty option, because a value that is not yet set is a
                        real state and the select must be able to show it. Without one the
                        browser silently displays the first strategy, and an unset mapping
                        would read as "full rebuild", a claim nobody made.
                      */}
                      <option value="">, not set -</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={`input${field.mono ? " mono" : ""}`}
                      value={readPath(draft, field.key)}
                      placeholder={field.placeholder}
                      onChange={(event) => setDraft(writePath(draft, field.key, event.target.value))}
                    />
                  )}

                  {/*
                    The chosen option's own explanation wins over the field's generic hint:
                    "keeps every version with valid-from/to dates" is what the user needs
                    at the moment they have picked SCD2.
                  */}
                  {(() => {
                    const chosen = field.options?.find(
                      (option) => option.value === readPath(draft, field.key),
                    );
                    const hint = chosen?.hint ?? field.hint;
                    return hint ? <span className="field__hint">{hint}</span> : null;
                  })()}
                </label>
              ))}

              {draft.kind === "relationship" ? <RelationshipSummary object={draft} /> : null}

              {detail && detail.usedBy.length > 0 ? (
                <div className="callout callout--info">
                  Referenced by {detail.usedBy.length} object(s):{" "}
                  {detail.usedBy.slice(0, 5).map((ref) => ref.name).join(", ")}
                  {detail.usedBy.length > 5 ? "…" : ""}
                </div>
              ) : null}

              {error ? <div className="callout callout--err">{error}</div> : null}
            </>
          )}
        </div>

        <footer className="dialog__foot">
          <button type="button" className="btn btn--quiet" onClick={() => onEditYaml(objectId)}>
            <Icon name="code" size={13} /> Edit as YAML
          </button>
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void remove()}>
            <Icon name="trash" size={13} /> Delete
          </button>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Relationships are structural, so show the shape rather than a set of text boxes. */
function RelationshipSummary({ object }: { object: ModelObject }): JSX.Element {
  const parent = (object.parent ?? {}) as Record<string, unknown>;
  const child = (object.child ?? {}) as Record<string, unknown>;

  return (
    <div className="callout callout--info stack" style={{ gap: "var(--s3)" }}>
      <div>
        <strong>{String(parent.ref ?? "?")}</strong>{" "}
        {String(parent.verbPhrase ?? "relates to")}{" "}
        <strong>{String(child.ref ?? "?")}</strong>
      </div>
      <div className="mono muted">
        {String(parent.cardinality ?? "?")} → {String(child.cardinality ?? "?")}
        {object.identifying ? " · identifying" : ""}
      </div>
      {Array.isArray(parent.attributes) && parent.attributes.length > 0 ? (
        <div className="mono muted">
          keys: {(parent.attributes as string[]).join(", ")} → {((child.attributes as string[]) ?? []).join(", ")}
        </div>
      ) : null}
    </div>
  );
}
