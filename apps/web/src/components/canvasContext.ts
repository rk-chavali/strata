import { createContext, useContext } from "react";
import type { DisplayLevel, MemberEdit } from "./EntityNode";
import type { Notation } from "./notation";

/**
 * Canvas display state and handlers, shared with the custom nodes via context.
 *
 * The alternative, stashing selection, detail level and callbacks inside each node's
 * `data`, means the node array has to be rebuilt whenever any of them changes. React
 * Flow keys its measurements off that array, so rebuilding it discards them, and
 * without measurements it will not route a single edge. Context keeps the node array
 * depending on the model alone, which is the only thing that should change it.
 */

export interface CanvasContextValue {
  displayLevel: DisplayLevel;
  /**
   * The notation in force, which changes how a *box* is drawn as well as its lines.
   *
   * IDEF1X gives an identifier-dependent entity rounded corners and writes `(FK)` after a
   * migrated attribute; the other notations do neither. Both are decisions made inside the
   * node component, so the notation has to reach it, and it travels by context for the
   * same reason `displayLevel` does: putting it in each node's `data` would rebuild the
   * node array on every switch, and React Flow drops its measurements when that happens.
   */
  notation: Notation;
  selectedId: string | undefined;
  canEdit: boolean;
  onRename: (id: string, name: string) => void;
  onMemberChange: (id: string, edit: MemberEdit) => void;
  onMemberAdd: (id: string) => void;
  /** `id` is the object id, or `shape:<shapeId>` for a free-form shape. */
  onContextMenu: (event: React.MouseEvent, id: string, memberIndex?: number) => void;
  onShapeTextChange: (shapeId: string, text: string) => void;
  onEdgeAction: (action: EdgeAction) => void;
  /**
   * Who else currently has this object open, if anyone.
   *
   * Deliberately a lookup rather than a `lockedBy` field on the node data: a colleague
   * opening a box would otherwise rebuild the whole node array, and React Flow drops
   * its measurements when that happens, which is what stopped edges rendering before.
   */
  lockedBy: (objectId: string) => { displayName: string } | undefined;
}

/** Actions available from the toolbar that appears on a selected edge. */
export type EdgeAction =
  | { type: "label"; edgeId: string; value: string }
  | { type: "delete"; edgeId: string }
  | { type: "toggleDash"; edgeId: string }
  | { type: "toggleArrow"; edgeId: string }
  | { type: "reverse"; edgeId: string }
  | { type: "cardinality"; edgeId: string };

const fallback: CanvasContextValue = {
  displayLevel: "attributes",
  notation: "crowsFoot",
  selectedId: undefined,
  canEdit: false,
  onRename: () => undefined,
  onMemberChange: () => undefined,
  onMemberAdd: () => undefined,
  onContextMenu: () => undefined,
  onShapeTextChange: () => undefined,
  onEdgeAction: () => undefined,
  lockedBy: () => undefined,
};

export const CanvasContext = createContext<CanvasContextValue>(fallback);

export function useCanvas(): CanvasContextValue {
  return useContext(CanvasContext);
}
