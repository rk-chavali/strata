import { useSyncExternalStore } from "react";
import type { SaveState } from "../components/ErdCanvas";

/**
 * The diagram's ambient state, published to the status bar.
 *
 * **Why a store rather than props or `statusExtra`.** The status bar is rendered by the
 * shell; the canvas is rendered several levels below it inside the page. The only route
 * between them is state held above both, which is where `statusExtra` lives, in
 * `Routes`. That works fine for things that change when you navigate.
 *
 * Zoom is not one of those things. It changes on every wheel tick, and every one of
 * those would re-render `Routes`, then `AppShell`, then the page, then the canvas.
 * `canvasContext.ts` documents what that costs: React Flow measures nodes from the array
 * it is given, rebuilding that array throws the measurements away, and without
 * measurements it will not route a single edge. A zoom gesture that intermittently
 * un-draws every relationship on the diagram is a worse outcome than the floating box
 * this replaced.
 *
 * So the update goes sideways instead of up. `useSyncExternalStore` means the only
 * component that re-renders is the readout itself, the canvas never hears about it.
 *
 * `controls` is here for the same reason in the other direction: React Flow's zoom
 * functions only exist inside its provider, so the status bar cannot call them directly.
 * The canvas publishes them on mount and withdraws them on unmount, which is also what
 * makes the control disappear on a page that has no diagram.
 */

export interface CanvasControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;
}

export interface CanvasStatus {
  zoom: number;
  saveState: SaveState;
  /** Absent when no diagram is mounted, which is how the status bar knows to show nothing. */
  controls: CanvasControls | undefined;
}

const EMPTY: CanvasStatus = { zoom: 1, saveState: "idle", controls: undefined };

let snapshot: CanvasStatus = EMPTY;
const listeners = new Set<() => void>();

/**
 * Publish a change.
 *
 * Bails when nothing actually differs. `useSyncExternalStore` compares snapshots by
 * identity, so replacing the object on every call would make the readout re-render on
 * every mousemove that React Flow reports a viewport for, defeating the point of the
 * store.
 */
export function publishCanvasStatus(patch: Partial<CanvasStatus>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof CanvasStatus)[]) {
    if (patch[key] !== snapshot[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

/** Called when a diagram unmounts, so no stale zoom or "Saving…" outlives it. */
export function resetCanvasStatus(): void {
  if (snapshot === EMPTY) return;
  snapshot = EMPTY;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CanvasStatus {
  return snapshot;
}

export function useCanvasStatus(): CanvasStatus {
  // Same function for the server snapshot: there is no SSR here, and passing it silences
  // the hydration-mismatch warning React emits when it is omitted.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
