import type { JSX } from "react";
import { Icon } from "../ui";

/**
 * The floating toolbar for the selected object.
 *
 * The whole reason the sidebar editor is gone: actions travel to the object rather
 * than sending the user across the screen to a panel. It anchors above the box and is
 * positioned in screen coordinates, so it tracks pan and zoom without re-rendering the
 * diagram.
 */

interface Props {
  /** Screen position of the top-centre of the selected node. */
  x: number;
  y: number;
  kind: string;
  canEdit: boolean;
  onRename: () => void;
  onAddMember: () => void;
  onEditYaml: () => void;
  onDelete: () => void;
}

export function SelectionToolbar({
  x,
  y,
  kind,
  canEdit,
  onRename,
  onAddMember,
  onEditYaml,
  onDelete,
}: Props): JSX.Element {
  const hasMembers = kind === "table" || kind === "entity";
  const memberLabel = kind === "table" ? "Column" : "Attribute";

  return (
    <div className="seltool" style={{ left: x, top: y - 10 }}>
      <button type="button" disabled={!canEdit} onClick={onRename} title="Rename (or double-click the title)">
        <Icon name="edit" size={13} /> Rename
      </button>

      {hasMembers ? (
        <button type="button" disabled={!canEdit} onClick={onAddMember} title={`Add a ${memberLabel.toLowerCase()}`}>
          <Icon name="plus" size={13} /> {memberLabel}
        </button>
      ) : null}

      <button type="button" disabled={!canEdit} onClick={onEditYaml} title="Reach every field in the metamodel">
        <Icon name="code" size={13} /> YAML
      </button>

      <span className="sep" />

      <button type="button" disabled={!canEdit} onClick={onDelete} title="Delete">
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}
