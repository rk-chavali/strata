import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { ModelObject } from "../types";

/**
 * Undo and redo for model edits.
 *
 * A modelling tool where Ctrl+Z does nothing is one people stop trusting, not because the
 * feature is missing, but because every edit becomes a decision. The cost of a mistake sets
 * how freely someone explores, and with no undo the cost is "read the YAML and fix it by hand".
 *
 * **Inverse operations, not snapshots.** The obvious design is to keep a copy of the object
 * before each edit and PUT it back. That is wrong here for a specific reason: two people can be
 * editing one model, and restoring a whole object would silently revert a colleague's change to
 * a different column of the same table. An inverse is scoped to exactly what was done, * "rename this column back" touches one field.
 *
 * **Redo is dropped on a new edit.** Standard, and worth stating: keeping it would let you redo
 * an operation whose preconditions no longer hold, and the failure surfaces as a confusing
 * error rather than as "that branch is gone".
 *
 * What this deliberately does *not* cover: box positions. The canvas persists layout by merging
 * into the diagram file, and layout is not a model change, mixing "undo my rename" and "undo
 * my drag" into one stack makes Ctrl+Z unpredictable, which is worse than it being narrow.
 */

/** One reversible thing that happened. `undo` performs the inverse; `redo` performs it again. */
export interface UndoStep {
  /** Shown in the toast and the tooltip, e.g. `rename customer_name to full_name`. */
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export interface UndoApi {
  /** Record a completed edit. Call *after* the write succeeds, never before. */
  push: (step: UndoStep) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  /** What Ctrl+Z would reverse, for a tooltip. */
  nextUndo: string | undefined;
  nextRedo: string | undefined;
  /** Forget everything. Called when the model changes. */
  clear: () => void;
}

const LIMIT = 50;

export function useUndo(options: {
  /** Refetch after an undo lands, so the canvas shows the reverted state. */
  onChanged: () => void;
  onError: (message: string) => void;
  onDone: (message: string) => void;
  /** Clearing on model change: two models must not share one stack. */
  scope: string;
}): UndoApi {
  const [past, setPast] = useState<UndoStep[]>([]);
  const [future, setFuture] = useState<UndoStep[]>([]);

  /**
   * Guards against a second Ctrl+Z arriving while the first is still in flight.
   *
   * Held in a ref rather than state because the keydown handler reads it synchronously, a
   * state flag would still be `false` on the second keypress in the same tick, and both
   * operations would run against the same revision, so one would fail on a conflict.
   */
  const busy = useRef(false);

  const clear = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  // A stack scoped to one model is meaningless on another; keep them separate.
  useEffect(() => clear(), [options.scope, clear]);

  const push = useCallback((step: UndoStep) => {
    setPast((current) => [...current, step].slice(-LIMIT));
    // A new edit invalidates the redo branch.
    setFuture([]);
  }, []);

  const run = useCallback(
    async (direction: "undo" | "redo") => {
      if (busy.current) return;

      const source = direction === "undo" ? past : future;
      const step = source[source.length - 1];
      if (!step) return;

      busy.current = true;
      try {
        await (direction === "undo" ? step.undo() : step.redo());

        if (direction === "undo") {
          setPast((current) => current.slice(0, -1));
          setFuture((current) => [...current, step]);
        } else {
          setFuture((current) => current.slice(0, -1));
          setPast((current) => [...current, step]);
        }

        options.onChanged();
        options.onDone(`${direction === "undo" ? "Undid" : "Redid"} ${step.label}`);
      } catch (error) {
        /*
          A failed undo stays on the stack.

          The usual cause is that the world moved on, someone renamed the same column, or the
          object is gone. Popping it anyway would quietly lose the record of an edit that was
          never reversed, and the next Ctrl+Z would then reverse something older, which is how
          undo becomes actively dangerous.
        */
        options.onError(
          error instanceof ApiError
            ? `Could not ${direction} ${step.label}: ${error.message}`
            : String(error),
        );
      } finally {
        busy.current = false;
      }
    },
    [past, future, options],
  );

  const undo = useCallback(() => run("undo"), [run]);
  const redo = useCallback(() => run("redo"), [run]);

  /**
   * Ctrl+Z and Ctrl+Shift+Z, plus Ctrl+Y for the Windows convention.
   *
   * Ignored while focus is in a text field, because there the browser's own undo is what the
   * user means, stealing it would make typing a description feel broken.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey)) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void redo();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  return useMemo(
    () => ({
      push,
      undo,
      redo,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      nextUndo: past[past.length - 1]?.label,
      nextRedo: future[future.length - 1]?.label,
      clear,
    }),
    [push, undo, redo, past, future, clear],
  );
}

// ---------------------------------------------------------------- step builders
//
// Each builder produces a step whose `undo` is the exact inverse of the operation, expressed
// through the same API the forward edit used. Building them here rather than at each call site
// keeps the inverse next to the operation it reverses, which is the only way to notice when one
// of them stops being a true inverse.

/** Renaming a member back. The inverse of a rename is a rename. */
export function renameMemberStep(
  objectId: string,
  path: string,
  from: string,
  to: string,
): UndoStep {
  /*
    The path changes when the name changes.

    `updateMember` addresses a member by name, so after renaming `customer_name` to `full_name`
    the member lives at `full_name`, undoing at the original path would 404. For a nested field
    only the last segment moves, which is why this rebuilds the path rather than replacing it.
  */
  const segments = path.split(".");
  const renamedPath = [...segments.slice(0, -1), to].join(".");

  return {
    label: `rename ${from} to ${to}`,
    undo: async () => {
      await api.updateMember(objectId, { path: renamedPath, name: from });
    },
    redo: async () => {
      await api.updateMember(objectId, { path, name: to });
    },
  };
}

/** Retyping a member back. */
export function retypeMemberStep(
  objectId: string,
  path: string,
  from: string,
  to: string,
): UndoStep {
  return {
    label: `change ${path} to ${to}`,
    undo: async () => {
      await api.updateMember(objectId, { path, type: from });
    },
    redo: async () => {
      await api.updateMember(objectId, { path, type: to });
    },
  };
}

/**
 * Adding a member. The inverse is a delete, and the inverse of *that* is not an add.
 *
 * `addMember` appends a blank member with a server-minted name, so redoing by calling it again
 * would produce a differently-named column. Redo therefore re-adds and renames to what it was,
 * which is the only way redo lands where undo started.
 */
export function addMemberStep(objectId: string, name: string): UndoStep {
  return {
    label: `add ${name}`,
    undo: async () => {
      await api.deleteMember(objectId, name);
    },
    redo: async () => {
      const result = await api.addMember(objectId);
      if (result.name !== name) {
        await api.updateMember(objectId, { path: result.name, name });
      }
    },
  };
}

/**
 * Deleting a member. The inverse has to restore its type too.
 *
 * Undo re-adds a blank member and then applies the name and type it had. It does *not* restore
 * position: `addMember` appends, so an undone delete puts the column at the end rather than
 * where it was. Stated rather than hidden, the alternative is a whole-object write, which is
 * exactly the concurrent-edit hazard this module avoids.
 */
export function deleteMemberStep(
  objectId: string,
  member: { name: string; type: string; path: string },
): UndoStep {
  return {
    label: `delete ${member.name}`,
    undo: async () => {
      const added = await api.addMember(objectId);
      await api.updateMember(objectId, { path: added.name, name: member.name });
      if (member.type) await api.updateMember(objectId, { path: member.name, type: member.type });
    },
    redo: async () => {
      await api.deleteMember(objectId, member.path);
    },
  };
}

/** Any whole-object field change, e.g. a description or a dataset. */
export function updateObjectStep(objectId: string, before: ModelObject, after: ModelObject): UndoStep {
  return {
    label: `edit ${String(after.name ?? objectId)}`,
    undo: async () => {
      await api.updateObject(objectId, before);
    },
    redo: async () => {
      await api.updateObject(objectId, after);
    },
  };
}

/** Toggling a primary key. Its own inverse, which is why it needs no before state. */
export function toggleKeyStep(objectId: string, column: string): UndoStep {
  return {
    label: `toggle primary key on ${column}`,
    undo: async () => {
      await api.toggleKey(objectId, column);
    },
    redo: async () => {
      await api.toggleKey(objectId, column);
    },
  };
}
