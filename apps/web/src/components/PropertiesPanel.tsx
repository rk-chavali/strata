import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { iconFor } from "../app/CommandPalette";
import { Badge, Button, Icon, useFeedback } from "../ui";
import { ImpactSection, LineageSection } from "./LineagePanel";
import { ProvenanceSection } from "./ProvenancePanel";
import { FIELDS, readPath, writePath } from "./objectFields";
import type { MemberView, ModelObject, NodeView, ObjectDetail } from "../types";

/**
 * The selected object's properties, docked beside the canvas.
 *
 * The modal this replaces had one fatal problem: it covered the thing you were editing.
 * You cannot check that a rename reads correctly on the box, or that a type change looks
 * right next to its neighbours, through a dialog sitting on top of both. Every serious
 * modelling tool docks this panel for that reason, and none of them make you close it to
 * see your work.
 *
 * The modal is still there for objects reached from the flat object list, where there is
 * no canvas to cover. Both render from `objectFields`, so the two never drift.
 *
 * Editing model is **save on blur, per field** rather than a Save button. A docked panel
 * that needs an explicit save invents a fourth state, selected, edited, unsaved, and
 * navigated-away-from, and the last one silently discards work. Committing on blur means
 * the only states are "what is on disk" and "what you are typing right now".
 */

interface Props {
  objectId: string;
  /** The canvas's own view of this object, so columns render before the detail fetch lands. */
  node?: NodeView;
  selectedMember?: string;
  onSelectMember: (path: string | undefined) => void;
  onClose: () => void;
  onSaved: () => void;
  onEditYaml: (id: string) => void;
  /** Navigate to another object, used by "referenced by". */
  onGoTo: (id: string) => void;
  canEdit: boolean;
}

export function PropertiesPanel({
  objectId,
  node,
  selectedMember,
  onSelectMember,
  onClose,
  onSaved,
  onEditYaml,
  onGoTo,
  canEdit,
}: Props): JSX.Element {
  const ui = useFeedback();
  const [detail, setDetail] = useState<ObjectDetail | undefined>();
  const [draft, setDraft] = useState<ModelObject | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setDraft(undefined);
    setError(undefined);

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

  /**
   * Commit the draft, but only when it actually differs from disk.
   *
   * Called on every field blur, so without the comparison a tab through the form would
   * write the object once per field, each write a new revision, each one a line in the
   * next diff, none of them a change anyone made.
   */
  async function commit(next: ModelObject): Promise<void> {
    if (!detail) return;
    if (JSON.stringify(next) === JSON.stringify(detail.object)) return;

    setBusy(true);
    try {
      const result = await api.updateObject(objectId, next, detail.revision);
      // Re-seed from the response so the next commit carries the new revision. Keeping the
      // stale one turns the second edit into a spurious conflict.
      setDetail({ ...detail, object: result.object, revision: result.revision });
      setDraft(result.object);
      setError(undefined);
      onSaved();
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

    try {
      await api.deleteObject(objectId);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const fields = draft ? (FIELDS[draft.kind] ?? []) : [];

  /**
   * Columns come from the canvas node when there is one, and from the object otherwise.
   *
   * The node's `members` are already flattened with depth and key flags computed by the
   * server, which is exactly what this list wants. Falling back to the raw object covers
   * the kinds with no box, a mapping has no members, so the section simply does not
   * render.
   */
  const members: MemberView[] = node?.members ?? [];
  const focused = members.find((member) => member.path === selectedMember);

  if (error && !draft) {
    return (
      <div className="props__empty">
        <Icon name="warn" size={18} />
        <p className="small">{error}</p>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="props__empty">
        <p className="muted small">Loading…</p>
      </div>
    );
  }

  return (
    <div className="props">
      <div className="props__ident">
        <span className="props__kind">
          <Icon name={iconFor(draft.kind)} size={12} />
          {draft.kind}
        </span>
        {busy ? <span className="props__busy small muted">saving…</span> : null}
      </div>

      <Row label="Name">
        <input
          className="input input--sm"
          value={String(draft.name ?? "")}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onBlur={() => void commit(draft)}
        />
      </Row>

      <Row label="Description">
        <textarea
          className="input input--sm"
          rows={2}
          value={String(draft.description ?? "")}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          onBlur={() => void commit(draft)}
        />
      </Row>

      {fields.map((field) => (
        <Row key={field.key} label={field.label} hint={hintFor(field, draft)}>
          {field.type === "textarea" ? (
            <textarea
              className="input input--sm"
              rows={2}
              value={readPath(draft, field.key)}
              placeholder={field.placeholder}
              disabled={!canEdit}
              onChange={(event) => setDraft(writePath(draft, field.key, event.target.value))}
              onBlur={() => void commit(draft)}
            />
          ) : field.type === "select" ? (
            <select
              className="input input--sm"
              value={readPath(draft, field.key)}
              disabled={!canEdit}
              onChange={(event) => {
                // A select has no meaningful blur, the change *is* the commit.
                const next = writePath(draft, field.key, event.target.value);
                setDraft(next);
                void commit(next);
              }}
            >
              <option value="">, not set -</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`input input--sm${field.mono ? " mono" : ""}`}
              value={readPath(draft, field.key)}
              placeholder={field.placeholder}
              disabled={!canEdit}
              onChange={(event) => setDraft(writePath(draft, field.key, event.target.value))}
              onBlur={() => void commit(draft)}
            />
          )}
        </Row>
      ))}

      {members.length > 0 ? (
        <Section label={node?.kind === "table" ? "Columns" : "Attributes"} count={members.length}>
          <div className="props__members">
            {members.map((member) => (
              <button
                type="button"
                key={member.path}
                className={`props__member${member.path === selectedMember ? " is-selected" : ""}`}
                style={{ paddingLeft: `calc(var(--s4) + ${member.depth * 10}px)` }}
                onClick={() => onSelectMember(member.path === selectedMember ? undefined : member.path)}
              >
                <span className={`tree__flag${member.isPrimaryKey ? " tree__flag--pk" : member.isForeignKey ? " tree__flag--fk" : ""}`}>
                  {member.isPrimaryKey ? "PK" : member.isForeignKey ? "FK" : ""}
                </span>
                <span className="props__membername truncate">{member.name}</span>
                <span className="props__membertype mono truncate">{member.type}</span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {focused ? (
        <MemberDetail
          objectId={objectId}
          member={focused}
          canEdit={canEdit}
          onSaved={onSaved}
          onError={setError}
        />
      ) : null}

      {draft.kind === "relationship" ? <RelationshipShape object={draft} /> : null}

      {/*
        Lineage and impact scope themselves to the selected column when there is one, and to
        the whole object otherwise, which is the same distinction the rest of the panel makes,
        so selecting a column narrows every question on screen at once rather than only some.
      */}
      <LineageSection objectId={objectId} {...(selectedMember ? { column: focused?.name ?? selectedMember } : {})} onGoTo={onGoTo} />
      <ImpactSection objectId={objectId} {...(selectedMember ? { column: focused?.name ?? selectedMember } : {})} onGoTo={onGoTo} />

      {/*
        Not column-scoped, unlike the two above. Git tracks the file, and every column of a table
        lives in one file, so the last commit is the same answer for the table and for any column
        in it. Offering a column-scoped version would imply a precision that does not exist.
      */}
      <ProvenanceSection objectId={objectId} />

      {detail && detail.usedBy.length > 0 ? (
        <Section label="Referenced by" count={detail.usedBy.length}>
          <div className="props__refs">
            {detail.usedBy.map((ref) => (
              <button type="button" key={ref.id} className="props__ref" onClick={() => onGoTo(ref.id)}>
                <Icon name={iconFor(ref.kind)} size={11} />
                <span className="truncate">{ref.name}</span>
                <Icon name="chevronRight" size={10} className="props__refgo" />
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {detail?.file ? (
        <Row label="File">
          <span className="mono small muted truncate-start" title={detail.file}>
            {detail.file}
          </span>
        </Row>
      ) : null}

      {error ? <div className="callout callout--err small">{error}</div> : null}

      <footer className="props__foot">
        <Button variant="subtle" size="sm" icon="code" onClick={() => onEditYaml(objectId)}>
          YAML
        </Button>
        <span className="grow" />
        <Button variant="subtle" size="sm" icon="trash" disabled={!canEdit} onClick={() => void remove()}>
          Delete
        </Button>
      </footer>
    </div>
  );
}

/**
 * One column, editable.
 *
 * Rendered below the list rather than inline in it, because the list is the thing you
 * scan and the editor is the thing you use, putting four inputs inside every row turns a
 * 40-column table into a wall of boxes and makes the list unscannable.
 */
function MemberDetail({
  objectId,
  member,
  canEdit,
  onSaved,
  onError,
}: {
  objectId: string;
  member: MemberView;
  canEdit: boolean;
  onSaved: () => void;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const ui = useFeedback();
  const [name, setName] = useState(member.name);
  const [type, setType] = useState(member.type);

  // The selection can change under this component; reseed when it does, or the previous
  // column's name stays in the box and the next blur renames the wrong thing.
  useEffect(() => {
    setName(member.name);
    setType(member.type);
  }, [member.path, member.name, member.type]);

  async function patch(next: { name?: string; type?: string }): Promise<void> {
    try {
      await api.updateMember(objectId, { path: member.path, ...next });
      onError(undefined);
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function drop(): Promise<void> {
    const ok = await ui.confirm({
      title: "Delete column?",
      message: `"${member.name}" will be removed from this object.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteMember(objectId, member.path);
      onError(undefined);
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <Section label="Selected column" defaultOpen>
      <Row label="Name">
        <input
          className="input input--sm"
          value={name}
          disabled={!canEdit}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (name !== member.name && name.trim()) void patch({ name });
          }}
        />
      </Row>

      <Row label="Type">
        <input
          className="input input--sm mono"
          value={type}
          disabled={!canEdit}
          onChange={(event) => setType(event.target.value)}
          onBlur={() => {
            if (type !== member.type && type.trim()) void patch({ type });
          }}
        />
      </Row>

      <Row label="Flags">
        <div className="props__flags">
          <Button
            variant={member.isPrimaryKey ? "primary" : "default"}
            size="sm"
            disabled={!canEdit}
            title="Toggle whether this column is part of the primary key"
            onClick={() => {
              void api
                .toggleKey(objectId, member.name)
                .then(() => {
                  onError(undefined);
                  onSaved();
                })
                .catch((err: unknown) =>
                  onError(err instanceof ApiError ? err.message : String(err)),
                );
            }}
          >
            Primary key
          </Button>
          {member.required ? <Badge tone="neutral">required</Badge> : null}
          {member.isForeignKey ? <Badge tone="accent">foreign key</Badge> : null}
          {member.classification ? <Badge tone="warn">{member.classification}</Badge> : null}
        </div>
      </Row>

      {member.description ? (
        <Row label="Description">
          <span className="small muted">{member.description}</span>
        </Row>
      ) : null}

      <div className="props__memberfoot">
        <Button variant="subtle" size="sm" icon="trash" disabled={!canEdit} onClick={() => void drop()}>
          Delete column
        </Button>
      </div>
    </Section>
  );
}

/** Relationships are structural, so show the shape rather than a set of text boxes. */
function RelationshipShape({ object }: { object: ModelObject }): JSX.Element {
  const parent = (object.parent ?? {}) as Record<string, unknown>;
  const child = (object.child ?? {}) as Record<string, unknown>;

  return (
    <Section label="Shape" defaultOpen>
      <div className="props__shape">
        <div>
          <strong>{String(parent.ref ?? "?")}</strong> {String(parent.verbPhrase ?? "relates to")}{" "}
          <strong>{String(child.ref ?? "?")}</strong>
        </div>
        <div className="mono muted small">
          {String(parent.cardinality ?? "?")} → {String(child.cardinality ?? "?")}
          {object.identifying ? " · identifying" : ""}
        </div>
      </div>
    </Section>
  );
}

/** A labelled row. Label above the control, because 240px is not enough for two columns. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="props__row">
      <span className="props__label">{label}</span>
      {children}
      {hint ? <span className="props__hint">{hint}</span> : null}
    </div>
  );
}

/** A collapsible group inside the panel. */
function Section({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? true);

  return (
    <section className="props__section">
      <button
        type="button"
        className="props__sectionhead"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
        <span>{label}</span>
        {count !== undefined ? <span className="tree__count">{count}</span> : null}
      </button>
      {open ? <div className="props__sectionbody">{children}</div> : null}
    </section>
  );
}

/**
 * The chosen option's own explanation wins over the field's generic hint.
 *
 * Looked up by the field's own `key`, an earlier version hardcoded `loadStrategy`, which
 * happened to work because it is the only select today and would have silently shown the
 * wrong hint on the next one.
 */
function hintFor(
  field: { key: string; options?: { value: string; hint: string }[]; hint?: string },
  draft: ModelObject,
): string | undefined {
  const current = field.options?.find((option) => option.value === readPath(draft, field.key));
  return current?.hint ?? field.hint;
}

/** The empty state, for when nothing is selected. Exported so the panel can render it. */
export function PropertiesEmpty(): JSX.Element {
  return (
    <div className="props__empty">
      <Icon name="cursor" size={18} />
      <p className="small muted">Select an object on the diagram or in the explorer to see its properties.</p>
    </div>
  );
}
