import { Fragment, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { Icon } from "../ui";
import { useCanvas } from "./canvasContext";
import { isDependentEntity, memberSuffixFor } from "./notation";
import type { MemberView, NodeView } from "../types";

/**
 * An entity or table box, edited in place.
 *
 * Editing happens on the diagram, not in a panel to one side. That is how erwin works
 * and it is the right call: the diagram is what the modeller is thinking about, and
 * making them look elsewhere to rename a column breaks that thread every time.
 *
 * Double-click the title to rename, double-click a row to edit it, Enter commits,
 * Escape abandons. Right-click for anything else.
 */

export type DisplayLevel = "entityOnly" | "keysOnly" | "attributes" | "attributesWithTypes";

export interface MemberEdit {
  index: number;
  name: string;
  type: string;
}

export interface EntityNodeData extends Record<string, unknown> {
  view: NodeView;
}

const MAX_VISIBLE = 16;

export function EntityNode({ data, selected }: NodeProps): JSX.Element {
  const { view } = data as EntityNodeData;
  const {
    selectedId,
    displayLevel,
    notation,
    canEdit,
    onRename,
    onMemberChange,
    onMemberAdd,
    onContextMenu,
    lockedBy,
  } = useCanvas();
  const heldBy = lockedBy(view.id);

  // Selected via the app's own selection or React Flow's, so clicking either the box or
  // its resize frame keeps the handles visible.
  const isSelected = selectedId === view.id || Boolean(selected);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const [editingIndex, setEditingIndex] = useState<number | undefined>();

  useEffect(() => {
    setDraft(view.name);
  }, [view.name]);

  const showMembers = displayLevel !== "entityOnly";
  const showNonKeys = displayLevel === "attributes" || displayLevel === "attributesWithTypes";
  const showTypes = displayLevel === "attributesWithTypes";

  // Keep the original index so an edit maps back to the right member.
  const indexed = view.members.map((member, index) => ({ member, index }));
  const keys = indexed.filter((entry) => entry.member.isPrimaryKey);
  const rest = indexed.filter((entry) => !entry.member.isPrimaryKey);
  const visible = showNonKeys ? rest.slice(0, MAX_VISIBLE) : [];
  const hidden = showNonKeys ? rest.length - visible.length : 0;

  function commitRename(): void {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== view.name) onRename(view.id, trimmed);
    else setDraft(view.name);
  }

  /**
   * IDEF1X draws an identifier-dependent entity with rounded corners.
   *
   * Carried as a class rather than an inline style so the radius stays a token, and only
   * in IDEF1X, in crow's foot or UML a rounded box would mean nothing at all, and a
   * reader of those notations would be looking for a distinction that is not there.
   */
  const dependent = notation === "idef1x" && isDependentEntity(view);

  return (
    <div
      className={`node node--${view.kind}${isSelected ? " node--sel" : ""}${dependent ? " node--dependent" : ""}`}
      {...(dependent
        ? { title: `${view.name}, identifier-dependent: it cannot be identified without its parent` }
        : {})}
      // Fill the wrapper once a size has been chosen, so the resizer gives live
      // feedback rather than snapping after a round trip.
      style={view.userSized ? { width: "100%", height: "100%" } : undefined}
      onContextMenu={(event) => onContextMenu(event, view.id)}
    >
      {/*
        Width is the useful axis here, long column names get clipped, but height is
        offered too so a box can be forced open. Until someone resizes one, the box
        sizes to its content, so adding a column still grows it.
      */}
      <NodeResizer
        isVisible={isSelected && canEdit}
        minWidth={160}
        minHeight={80}
        lineClassName="resize__line"
        handleClassName="resize__handle"
      />

      {/*
        A connection point on every side.

        There used to be exactly two, a target on the left and a source on the right, at
        6×6px, with the canvas in React Flow's default `strict` mode where a source may
        only reach a target. Between them that meant a relationship could only ever be
        drawn left-to-right: if the child sat to the left of the parent, or below it, you
        had to drag backwards across the diagram onto a six-pixel dot. Modellers do not lay
        boxes out left to right, so this was most of the time.

        Four sides, and `ConnectionMode.Loose` on the canvas so any of them can start or
        finish a drag. Direction is not lost by this, it is confirmed in the dialog that
        follows, which has always had a swap control precisely because a drag is a poor way
        to express which end is the parent.
      */}
      {/*
        Each side is mounted twice, once as a source and once as a target, sharing an id.

        React Flow keys handles by id *and* type. An edge that names `targetHandle: "l"`
        looks for a target handle called `l`, so with only a source of that name the
        lookup fails, and React Flow's response is to drop the edge without a word. That is
        what happened the first time: at the Names and Keys detail levels, where an edge
        falls back from a column row to the box edge, every relationship on the diagram
        silently disappeared.

        `ConnectionMode.Loose` governs what a *user* may drag between; it does not make one
        handle answer to both lookups. Mounting both is what does.
      */}
      {HANDLE_SIDES.map(({ id, position }) => (
        <Fragment key={id}>
          <Handle id={id} type="source" position={position} className="node__port" />
          <Handle
            id={id}
            type="target"
            position={position}
            className="node__port node__port--in"
            isConnectableStart={false}
          />
        </Fragment>
      ))}

      <div className="node__rule" />

      <header className="node__head">
        <Icon name={view.kind === "table" ? "table" : view.kind === "entity" ? "entity" : "concept"} size={14} />
        {renaming ? (
          <input
            className="node__nameinput"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              if (event.key === "Escape") {
                setDraft(view.name);
                setRenaming(false);
              }
            }}
            // Stop React Flow reading typing as a canvas gesture.
            onMouseDown={(event) => event.stopPropagation()}
          />
        ) : (
          <span
            className="node__name"
            title={canEdit ? "Double-click to rename" : view.name}
            onDoubleClick={() => canEdit && setRenaming(true)}
          >
            {view.name}
          </span>
        )}
        {view.layer ? <span className="node__tag">{view.layer}</span> : null}
        {!view.layer && view.subjectArea ? <span className="node__tag">{view.subjectArea}</span> : null}
        {heldBy ? (
          <span className="lockchip" title={`${heldBy.displayName} has this open for editing`}>
            <Icon name="lock" size={10} />
            {heldBy.displayName.split(" ")[0]}
          </span>
        ) : null}
      </header>

      {showMembers && keys.length > 0 ? (
        <div className="node__keys">
          {keys.map(({ member, index }) => (
            <Row
              key={`${member.path}-${index}`}
              member={member}
              index={index}
              showType={showTypes}
              canEdit={canEdit}
              editing={editingIndex === index}
              onStart={() => setEditingIndex(index)}
              onCancel={() => setEditingIndex(undefined)}
              onCommit={(edit) => {
                setEditingIndex(undefined);
                onMemberChange(view.id, edit);
              }}
              onContextMenu={(event) => onContextMenu(event, view.id, index)}
            />
          ))}
        </div>
      ) : null}

      {showMembers && visible.length > 0 ? (
        <div className="node__rows">
          {visible.map(({ member, index }) => (
            <Row
              key={`${member.path}-${index}`}
              member={member}
              index={index}
              showType={showTypes}
              canEdit={canEdit}
              editing={editingIndex === index}
              onStart={() => setEditingIndex(index)}
              onCancel={() => setEditingIndex(undefined)}
              onCommit={(edit) => {
                setEditingIndex(undefined);
                onMemberChange(view.id, edit);
              }}
              onContextMenu={(event) => onContextMenu(event, view.id, index)}
            />
          ))}
          {hidden > 0 ? <div className="member__more">+{hidden} more</div> : null}
        </div>
      ) : null}

      {showMembers && canEdit && (view.kind === "table" || view.kind === "entity") ? (
        <button
          type="button"
          className="node__add"
          onClick={() => onMemberAdd(view.id)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Icon name="plus" size={11} /> Add {view.kind === "table" ? "column" : "attribute"}
        </button>
      ) : null}

    </div>
  );
}

/**
 * The four connection points, and the ids edges use to name them.
 *
 * Short ids because they are written into every edge the canvas builds; the mapping from
 * `l` to "left" is one lookup away and the alternative is four extra characters on every
 * edge in a large diagram.
 */
export const HANDLE_SIDES = [
  { id: "t", position: Position.Top },
  { id: "r", position: Position.Right },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
] as const;

/**
 * Which member rows this box actually draws, at a given detail level.
 *
 * **The canvas needs this and cannot guess it.** An edge anchored to a column row requires
 * that row's handle to exist, and at `Names` no rows are drawn at all while at `Keys` only
 * the primary key is, so on those levels the edge has to fall back to the box edge. React
 * Flow's response to an edge naming a handle that is not mounted is to drop the edge
 * silently, which would mean switching detail level made relationships disappear.
 *
 * Exported and used by `EntityNode` itself rather than duplicated, because two copies of
 * this rule would drift the moment either the cap or the key/non-key split changed, and the
 * failure that drift produces is invisible lines.
 */
export function visibleMemberPaths(
  members: readonly MemberView[],
  displayLevel: DisplayLevel,
): Set<string> {
  if (displayLevel === "entityOnly") return new Set();

  const keys = members.filter((member) => member.isPrimaryKey);
  const showNonKeys = displayLevel === "attributes" || displayLevel === "attributesWithTypes";
  const rest = showNonKeys
    ? members.filter((member) => !member.isPrimaryKey).slice(0, MAX_VISIBLE)
    : [];

  return new Set([...keys, ...rest].map((member) => member.path));
}

interface RowProps {
  member: MemberView;
  index: number;
  showType: boolean;
  canEdit: boolean;
  editing: boolean;
  onStart: () => void;
  onCancel: () => void;
  onCommit: (edit: MemberEdit) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

function Row({
  member,
  index,
  showType,
  canEdit,
  editing,
  onStart,
  onCancel,
  onCommit,
  onContextMenu,
}: RowProps): JSX.Element {
  const { notation } = useCanvas();
  const suffix = memberSuffixFor(notation, member);
  const [name, setName] = useState(member.name);
  const [type, setType] = useState(member.type);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(member.name);
    setType(member.type);
  }, [member.name, member.type]);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  function commit(): void {
    const trimmedName = name.trim();
    const trimmedType = type.trim();
    if (!trimmedName || (trimmedName === member.name && trimmedType === member.type)) {
      onCancel();
      return;
    }
    onCommit({ index, name: trimmedName, type: trimmedType });
  }

  function cancel(): void {
    setName(member.name);
    setType(member.type);
    onCancel();
  }

  if (editing) {
    return (
      <div className="member member--editing" onMouseDown={(event) => event.stopPropagation()}>
        <span className="member__key">
          {member.isPrimaryKey ? <Icon name="key" size={11} /> : member.isForeignKey ? <Icon name="link" size={11} /> : null}
        </span>
        <input
          ref={nameRef}
          className="member__input member__input--name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") cancel();
          }}
        />
        <input
          className="member__input member__input--type"
          value={type}
          onChange={(event) => setType(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") cancel();
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="member"
      style={member.depth > 0 ? { paddingLeft: 8 + member.depth * 12 } : undefined}
      title={member.description ?? (canEdit ? "Double-click to edit" : undefined)}
      onDoubleClick={() => canEdit && onStart()}
      onContextMenu={onContextMenu}
    >
      <span className="member__key">
        {member.isPrimaryKey ? <Icon name="key" size={11} /> : member.isForeignKey ? <Icon name="link" size={11} /> : null}
      </span>
      <span className={`member__name${member.required ? " member__name--req" : ""}`}>
        {member.name}
        {/*
          IDEF1X writes `(FK)` after a migrated attribute, and it is part of the notation
          rather than decoration: it is how a reader tells which attributes arrived through
          a relationship instead of belonging to the entity natively, the visible trace of
          key migration. Inside the name span so it travels with the name when it truncates.
        */}
        {suffix ? <span className="member__rolemark">{suffix}</span> : null}
      </span>
      {member.classification ? <span className="member__tag">{member.classification}</span> : null}
      {showType ? <span className="member__type">{member.type}</span> : null}

      {/*
        Connection points on the row itself.

        This is what makes a relationship line say *which columns* it joins on, rather than
        only which tables. A fact table with six foreign keys all arriving at one box edge
        tells a reader that six things are related and nothing about which columns carry
        them, which is exactly the question a physical model exists to answer.

        Two per row, and they are not symmetrical on purpose. The right-hand one is the
        grab handle you drag *from*, sitting in the empty space past the column name. The
        left-hand one is a pure arrival point: it has no visible affordance at all, because
        a line lands there but nobody starts a drag from it, and drawing a knob you are not
        meant to grab is an invitation to try.

        `ConnectionMode.Loose` on the canvas means both can serve either role when a drag
        does come the other way, so nothing is actually forbidden, only unadvertised.
      */}
      <Handle
        type="target"
        position={Position.Left}
        id={`in:${member.path}`}
        className="member__port member__port--in"
        isConnectableStart={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id={`out:${member.path}`}
        className="member__port member__port--out"
      />
    </div>
  );
}
