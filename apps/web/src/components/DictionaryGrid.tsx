import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Badge, Button, EmptyState, Icon, Loading, Segmented, useFeedback } from "../ui";
import type { DictionaryRow, DictionaryView, MemberPatch } from "../types";

/**
 * Every field in the model, as an editable grid.
 *
 * The diagram and the properties panel are both *one object at a time*. That is the right
 * shape for modelling and the wrong shape for the two jobs this screen exists for:
 *
 *   - **Documenting.** Writing 40 descriptions means 40 selections and 40 panels. Here it
 *     is 40 rows and a Tab key.
 *   - **Classifying.** "Which columns hold personal data" is a question about the whole
 *     model at once, and the answer has to be auditable in one view, which is exactly why
 *     every governance tool ships a grid and not a form.
 *
 * Edits commit per cell on blur, straight to `PATCH /objects/:id/members`. There is no Save
 * button on purpose: a grid with 400 editable cells and one Save button is a grid that
 * loses work, because nothing tells you which of the 400 are still pending.
 *
 * Rows are grouped under their object with a sticky header, but the underlying list stays
 * flat, so sorting and filtering apply across the whole model rather than within a group.
 */

type Filter = "all" | "undocumented" | "unclassified" | "sensitive" | "keys";

const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every field in the model" },
  { value: "undocumented", label: "No description", title: "Fields with nothing written down" },
  { value: "unclassified", label: "Unclassified", title: "Fields with no sensitivity or category" },
  { value: "sensitive", label: "Sensitive", title: "Fields carrying a category or a sensitivity above internal" },
  { value: "keys", label: "Keys", title: "Primary and foreign keys only" },
];

interface Props {
  model: string;
  refreshKey: number;
  canEdit: boolean;
  /** Open this field's object in the studio. */
  onOpenObject: (objectId: string) => void;
}

export function DictionaryGrid({ model, refreshKey, canEdit, onOpenObject }: Props): JSX.Element {
  const ui = useFeedback();
  const [view, setView] = useState<DictionaryView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  /**
   * Rows held locally so a committed edit repaints immediately.
   *
   * Refetching the whole dictionary after every cell would be correct and unusable: the
   * round trip is long enough that the cell you just left flickers back to its old value
   * before settling. The server response is authoritative and merged in per row.
   */
  const [rows, setRows] = useState<DictionaryRow[]>([]);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    let cancelled = false;
    api
      .dictionary(model)
      .then((result) => {
        if (cancelled) return;
        setView(result);
        setRows(result.rows);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [model]);

  useEffect(load, [load, refreshKey]);

  const rowKey = (row: DictionaryRow): string => `${row.objectId}:${row.path}`;

  /**
   * Send one cell's change and merge the result back.
   *
   * The whole row is replaced from a re-read of that object rather than patched optimistically
   * field by field, because a single edit can change more than the field it touched: renaming
   * a column that sits in the primary key rewrites the key list, and clearing a sensitivity
   * can reveal an inherited one underneath.
   */
  async function commit(row: DictionaryRow, patch: Omit<MemberPatch, "path">): Promise<void> {
    const key = rowKey(row);
    setSaving((current) => new Set(current).add(key));

    try {
      await api.updateMember(row.objectId, { path: row.path, ...patch });
      const fresh = await api.dictionary(model);
      setView(fresh);
      setRows(fresh.rows);
      setError(undefined);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setError(message);
      ui.toast({ tone: "error", message });
      // Put the old value back. A cell that keeps a rejected edit on screen is a cell that
      // lies about what is on disk.
      setRows((current) => current.map((candidate) => (rowKey(candidate) === key ? row : candidate)));
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rows.filter((row) => {
      if (query) {
        const haystack = `${row.objectName} ${row.name} ${row.description ?? ""} ${row.type}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      switch (filter) {
        case "undocumented":
          return !row.description;
        case "unclassified":
          // Inherited counts as classified: the field *is* governed, just not here.
          return (
            !row.sensitivity &&
            row.categories.length === 0 &&
            !row.inherited?.sensitivity &&
            (row.inherited?.categories.length ?? 0) === 0
          );
        case "sensitive": {
          const sensitivity = row.sensitivity ?? row.inherited?.sensitivity;
          const categories = row.categories.length > 0 ? row.categories : (row.inherited?.categories ?? []);
          return categories.length > 0 || sensitivity === "confidential" || sensitivity === "restricted";
        }
        case "keys":
          return row.isPrimaryKey || row.isForeignKey;
        default:
          return true;
      }
    });
  }, [rows, filter, search]);

  /** Grouped for display only; `visible` stays the source of truth for counts. */
  const groups = useMemo(() => {
    const result: { objectId: string; objectName: string; dataset?: string; rows: DictionaryRow[] }[] = [];
    for (const row of visible) {
      const last = result[result.length - 1];
      if (last && last.objectId === row.objectId) last.rows.push(row);
      else
        result.push({
          objectId: row.objectId,
          objectName: row.objectName,
          ...(row.dataset ? { dataset: row.dataset } : {}),
          rows: [row],
        });
    }
    return result;
  }, [visible]);

  if (error && !view) {
    return (
      <EmptyState
        icon="warn"
        title="Could not load the dictionary"
        body={error}
        action={
          <Button variant="primary" icon="refresh" onClick={load}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!view) return <Loading label="Loading the dictionary…" />;

  if (view.total === 0) {
    return (
      <EmptyState
        icon="list"
        title="Nothing to document yet"
        body="This model has no tables or entities, so there are no fields to describe or classify."
      />
    );
  }

  const percent = Math.round((view.classified / view.total) * 100);

  return (
    <div className="dict">
      <header className="dict__bar">
        <span className="dict__search">
          <Icon name="search" size={12} />
          <input
            className="input input--flush"
            value={search}
            placeholder="Search fields, types and descriptions…"
            aria-label="Search the dictionary"
            onChange={(event) => setSearch(event.target.value)}
          />
        </span>

        <Segmented value={filter} onChange={setFilter} options={FILTERS} />

        <span className="grow" />

        {/*
          Coverage as a number *and* a bar. The number is what gets reported upward; the bar
          is what makes 4/40 register as a problem at a glance rather than as a statistic.
        */}
        <span className="dict__coverage" title={`${view.classified} of ${view.total} fields carry a classification`}>
          <span className="dict__coveragebar">
            <span className="dict__coveragefill" style={{ width: `${percent}%` }} />
          </span>
          <span className="dict__coveragetext">
            {view.classified}/{view.total} classified
          </span>
        </span>
      </header>

      {visible.length === 0 ? (
        <p className="dict__empty muted">
          Nothing matches. {view.total} field{view.total === 1 ? "" : "s"} in this model.
        </p>
      ) : (
        <div className="dict__scroll">
          <table className="dict__table">
            <thead>
              <tr>
                <th className="dict__c-name">Field</th>
                <th className="dict__c-type">Type</th>
                <th className="dict__c-null">Null</th>
                <th className="dict__c-desc">Description</th>
                <th className="dict__c-sens">Sensitivity</th>
                <th className="dict__c-cats">Categories</th>
              </tr>
            </thead>

            {groups.map((group) => (
              <tbody key={group.objectId}>
                <tr className="dict__grouprow">
                  <th colSpan={6}>
                    <button type="button" className="dict__groupname" onClick={() => onOpenObject(group.objectId)}>
                      <Icon name="table" size={12} />
                      {group.objectName}
                      {group.dataset ? <span className="dict__dataset mono">{group.dataset}</span> : null}
                      <span className="tree__count">{group.rows.length}</span>
                    </button>
                  </th>
                </tr>

                {group.rows.map((row) => (
                  <Row
                    key={rowKey(row)}
                    row={row}
                    view={view}
                    canEdit={canEdit}
                    busy={saving.has(rowKey(row))}
                    onCommit={(patch) => void commit(row, patch)}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

/** One field. Every editable cell commits on blur or on change, never on a Save button. */
function Row({
  row,
  view,
  canEdit,
  busy,
  onCommit,
}: {
  row: DictionaryRow;
  view: DictionaryView;
  canEdit: boolean;
  busy: boolean;
  onCommit: (patch: Omit<MemberPatch, "path">) => void;
}): JSX.Element {
  const [description, setDescription] = useState(row.description ?? "");

  // The row can be replaced under this component by a refetch; reseed so the input shows
  // what is on disk rather than a stale draft.
  useEffect(() => setDescription(row.description ?? ""), [row.description]);

  const inheritedOnly = !row.sensitivity && Boolean(row.inherited?.sensitivity);
  const categoriesShown = row.categories.length > 0 ? row.categories : (row.inherited?.categories ?? []);
  const categoriesInherited = row.categories.length === 0 && (row.inherited?.categories.length ?? 0) > 0;

  return (
    <tr className={`dict__row${busy ? " is-busy" : ""}`}>
      <td className="dict__c-name">
        <span
          className="dict__field"
          /* STRUCT fields indent by depth so `address.postcode` reads as living inside
             `address`, matching the explorer and the properties panel. */
          style={{ paddingLeft: `${row.depth * 14}px` }}
        >
          <span className={`tree__flag${row.isPrimaryKey ? " tree__flag--pk" : row.isForeignKey ? " tree__flag--fk" : ""}`}>
            {row.isPrimaryKey ? "PK" : row.isForeignKey ? "FK" : ""}
          </span>
          <span className="dict__fieldname" title={row.path}>
            {row.name}
          </span>
        </span>
      </td>

      <td className="dict__c-type mono">
        {row.type}
        {row.domain ? (
          <span className="dict__from" title={`Type comes from the attribute type \`${row.domain}\``}>
            {row.domain}
          </span>
        ) : null}
      </td>

      <td className="dict__c-null">
        {/*
          A checkbox for "required", labelled "Not null" in the header, the warehouse's own
          word. `REPEATED` columns are left alone by the server, so this cell is honest for
          arrays too: it shows their current requiredness and toggling it is a no-op there.
        */}
        <input
          type="checkbox"
          checked={row.required}
          disabled={!canEdit || busy}
          aria-label={`${row.name} is required`}
          title={row.required ? "Required, NOT NULL" : "Nullable"}
          onChange={(event) => onCommit({ required: event.target.checked })}
        />
      </td>

      <td className="dict__c-desc">
        <input
          className="input input--flush dict__input"
          value={description}
          placeholder="-"
          disabled={!canEdit || busy}
          aria-label={`Description of ${row.name}`}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== (row.description ?? "")) {
              // Empty means "clear it", which is `null` on the wire, not `""`, which would
              // persist a meaningless key into the YAML.
              onCommit({ description: description.trim() ? description : null });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            else if (event.key === "Escape") setDescription(row.description ?? "");
          }}
        />
      </td>

      <td className="dict__c-sens">
        <select
          className={`input input--flush dict__select${inheritedOnly ? " is-inherited" : ""}`}
          value={row.sensitivity ?? ""}
          disabled={!canEdit || busy}
          aria-label={`Sensitivity of ${row.name}`}
          title={
            inheritedOnly
              ? `Inherited \`${row.inherited?.sensitivity}\` from the attribute type \`${row.inherited?.from}\`. Choosing a value here overrides it for this field only.`
              : "How sensitive this field is"
          }
          onChange={(event) =>
            onCommit({ classification: { sensitivity: event.target.value || null } })
          }
        >
          {/* An inherited value is shown as the placeholder, so the cell reads truthfully as
              "not set here, but governed" rather than as "not classified". */}
          <option value="">{inheritedOnly ? `↳ ${row.inherited?.sensitivity}` : "-"}</option>
          {view.sensitivityLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </td>

      <td className="dict__c-cats">
        <CategoryPicker
          available={view.categories}
          selected={row.categories}
          shown={categoriesShown}
          inherited={categoriesInherited}
          inheritedFrom={row.inherited?.from}
          disabled={!canEdit || busy}
          fieldName={row.name}
          onChange={(categories) => onCommit({ classification: { categories } })}
        />
        {row.hasPolicyTag ? (
          <Badge tone="ok" title="A BigQuery policy tag resource id is set on this field">
            tagged
          </Badge>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The category cell: a summary that opens a checklist.
 *
 * Not a multi-select. A native `<select multiple>` needs ctrl-click to add a second value,
 * which roughly nobody discovers, and it cannot show an inherited value distinctly from a
 * set one. Nine checkboxes in a popover is more code and the only version that is usable.
 */
function CategoryPicker({
  available,
  selected,
  shown,
  inherited,
  inheritedFrom,
  disabled,
  fieldName,
  onChange,
}: {
  available: string[];
  selected: string[];
  shown: string[];
  inherited: boolean;
  inheritedFrom?: string;
  disabled: boolean;
  fieldName: string;
  onChange: (categories: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  function toggle(category: string): void {
    // Toggling starts from what is *set here*, never from what is shown. Starting from the
    // inherited list would silently copy the domain's categories onto the field the first
    // time anyone added one.
    const next = selected.includes(category)
      ? selected.filter((entry) => entry !== category)
      : [...selected, category];
    onChange(next);
  }

  return (
    <span className="dict__cats">
      <button
        type="button"
        className={`dict__catsbtn${inherited ? " is-inherited" : ""}`}
        disabled={disabled}
        aria-expanded={open}
        title={
          inherited
            ? `Inherited from the attribute type \`${inheritedFrom}\`. Ticking a category here overrides it for this field only.`
            : `Data categories for ${fieldName}`
        }
        onClick={() => setOpen((value) => !value)}
      >
        {shown.length === 0 ? (
          <span className="muted">-</span>
        ) : (
          shown.map((category) => (
            <span key={category} className="dict__cat">
              {inherited ? "↳" : ""}
              {category}
            </span>
          ))
        )}
        <Icon name="chevronDown" size={9} />
      </button>

      {open ? (
        <>
          {/* A click-away layer rather than a document listener: one element, removed with the
              popover, so there is no listener to leak if this unmounts while open. */}
          <span className="dict__scrim" onClick={() => setOpen(false)} />
          <span className="dict__catsmenu" role="group" aria-label={`Data categories for ${fieldName}`}>
            {available.map((category) => (
              <label key={category} className="dict__catsopt">
                <input
                  type="checkbox"
                  checked={selected.includes(category)}
                  onChange={() => toggle(category)}
                />
                {category}
              </label>
            ))}
            {selected.length > 0 ? (
              <button type="button" className="dict__catsclear" onClick={() => onChange([])}>
                Clear all
              </button>
            ) : null}
          </span>
        </>
      ) : null}
    </span>
  );
}
