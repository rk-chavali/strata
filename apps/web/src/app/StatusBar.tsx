import type { JSX, ReactNode } from "react";
import { Icon } from "../ui";
import { useCanvasStatus } from "./canvasStatus";
import type { Router } from "./routes";
import { useWorkspace } from "./WorkspaceContext";

/**
 * Model validity and repository state, permanently visible.
 *
 * These were floating chips over the bottom-right of the canvas. That put the two most
 * important pieces of ambient state, *is my model valid* and *what have I changed*, on
 * top of the diagram, where they covered content and shifted position depending on which
 * other overlay happened to be open.
 *
 * A status bar is where every editor puts this, and the reason is sound: it costs 28px
 * once, it never moves, and it is glanceable without being in the way. Both items are
 * buttons, so the bar is also the fastest route to the panel that explains them.
 */

export function StatusBar({
  router,
  extra,
}: {
  router: Router;
  /** Route-specific items, right-aligned. The canvas puts its zoom control here. */
  extra?: ReactNode;
}): JSX.Element {
  const { workspace, git, gitLoaded } = useWorkspace();

  const errors = workspace?.diagnostics.error ?? 0;
  const warnings = workspace?.diagnostics.warning ?? 0;
  const changeCount = git?.files.length ?? 0;

  const tone = errors > 0 ? "err" : warnings > 0 ? "warn" : "ok";
  const validity =
    errors > 0
      ? `${errors} error${errors === 1 ? "" : "s"}`
      : warnings > 0
        ? `${warnings} warning${warnings === 1 ? "" : "s"}`
        : "Model valid";

  return (
    <footer className="statusbar">
      <button
        type="button"
        className={`statusbar__item statusbar__item--button statusbar__item--${tone}`}
        title="The same check that gates a pull request in CI"
        onClick={() => router.go({ name: "problems" })}
      >
        <Icon name={errors > 0 || warnings > 0 ? "warn" : "check"} size={12} />
        {validity}
      </button>

      {git?.isRepo ? (
        <button
          type="button"
          className="statusbar__item statusbar__item--button"
          title={
            changeCount > 0
              ? `${changeCount} uncommitted file(s), review them in Changes`
              : "No uncommitted changes"
          }
          onClick={() => router.go({ name: "changes" })}
        >
          <Icon name="branch" size={12} />
          {git.branch ?? "detached"}
          {changeCount > 0 ? ` · ${changeCount} changed` : ""}
        </button>
      ) : gitLoaded ? (
        <span className="statusbar__item statusbar__item--warn" title={workspace?.root}>
          <Icon name="warn" size={12} />
          Not a git repository
        </span>
      ) : (
        /*
          Nothing, until we know.

          `git status` takes over a second on a real repository, and this branch used to render
          "Not a git repository" for the whole of that, a false statement, shown on every page
          load, about a repo that was fine. Silence while loading is the honest option: the chip
          appears the moment there is something true to say.
        */
        null
      )}

      <span className="grow" />

      {extra}

      <CanvasStatus />

      {workspace ? (
        <span className="statusbar__item muted" title={`${workspace.fileCount} files on disk`}>
          {workspace.objectCount} object{workspace.objectCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </footer>
  );
}

/**
 * Save state and zoom, contributed by whichever diagram is open.
 *
 * Its own component so that a zoom gesture re-renders these few nodes and nothing else.
 * Reading the store in `StatusBar` itself would re-render the validity and git items on
 * every wheel tick, and reading it any higher would re-render the canvas, which is the
 * failure this store exists to avoid. See `canvasStatus.ts`.
 *
 * Renders nothing at all when no diagram is mounted, rather than a disabled control: a
 * zoom readout on the Problems page describes something that is not on screen.
 */
function CanvasStatus(): JSX.Element | null {
  const { zoom, saveState, controls } = useCanvasStatus();

  if (!controls) return null;

  return (
    <>
      {saveState === "saving" ? <span className="statusbar__item muted">Saving…</span> : null}
      {saveState === "saved" ? (
        <span className="statusbar__item statusbar__item--ok">
          <Icon name="check" size={12} />
          Saved
        </span>
      ) : null}
      {saveState === "error" ? (
        <span className="statusbar__item statusbar__item--err">
          <Icon name="warn" size={12} />
          Save failed
        </span>
      ) : null}

      <span className="statusbar__zoom">
        <button type="button" title="Zoom out" onClick={controls.zoomOut}>
          <Icon name="minus" size={12} />
        </button>
        {/*
          `output` rather than `span`: this is a computed readout, and the element carries
          an implicit `status` role, so a screen reader announces the new value when it
          changes instead of the user having to go looking for it.
        */}
        <output>{Math.round(zoom * 100)}%</output>
        <button type="button" title="Zoom in" onClick={controls.zoomIn}>
          <Icon name="plus" size={12} />
        </button>
        <button type="button" title="Fit the whole diagram in the window" onClick={controls.fitView}>
          <Icon name="fit" size={12} />
        </button>
      </span>
    </>
  );
}
