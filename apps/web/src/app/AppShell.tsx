import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useFeedback } from "../ui";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { useTheme } from "./theme";
import { TopBar } from "./TopBar";
import { modelOf, type Router } from "./routes";
import { useWorkspace } from "./WorkspaceContext";
import { useAnnounceLocation, usePresence } from "../usePresence";
import { ImportDialog } from "../components/ImportDialog";
import { NewModelDialog } from "../components/NewModelDialog";
import { ProposeDialog } from "../components/ProposeDialog";
import { SettingsDialog } from "../components/SettingsDialog";
import { api } from "../api";

/**
 * The shell's dialogs, exposed to the pages inside it.
 *
 * Three dialogs can be opened from more than one place, new model from the sidebar, the
 * overview, the palette and an empty state; import from the overview and the palette;
 * propose from the top bar, the changes page and the palette. Duplicating that state per
 * page would mean four independent "new model" dialogs that behave slightly differently.
 *
 * Context rather than prop-drilling because the consumers are arbitrarily deep, an empty
 * state inside a table inside a tab, and threading four callbacks through every page
 * signature is exactly the prop-drilling this redesign set out to remove.
 */
interface ShellActions {
  openNewModel: () => void;
  openImport: () => void;
  openPropose: () => void;
  openPalette: () => void;
  /**
   * The one live connection, shared.
   *
   * `usePresence` opens an `EventSource` and publishes its connection id to a
   * module-global that every write header reads. Calling it twice therefore opens two
   * streams, registers this tab as two peers, and lets the two ids race over that global, * so a save could be stamped with the wrong connection and the originator would be told
   * their own edit was someone else's remote change.
   *
   * So the shell owns it, and pages that need locks consume it from here.
   */
  presence: ReturnType<typeof usePresence>;
}

const ShellActionsContext = createContext<ShellActions | undefined>(undefined);

export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext);
  if (!actions) throw new Error("useShellActions must be used inside <AppShell>");
  return actions;
}

/**
 * The chrome, and the small set of things that genuinely belong to the whole app.
 *
 * Specifically: the theme, the command palette, live presence, and the three dialogs that
 * can be opened from more than one place (new model, import, propose). Everything else is
 * owned by the page that uses it.
 *
 * That division is the point. The old `App.tsx` was 982 lines because it owned *every*
 * dialog, every canvas callback and every piece of view state for every screen, so any
 * change to any view went through it. What is left here is genuinely global, and a new page
 * can be added without touching this file at all.
 */

/* The theme key lives in `theme.ts` with the hook that owns it. */

/**
 * Whether the sidebar is collapsed to icons.
 *
 * Persisted like the theme, because it is the same kind of preference: someone who works
 * on a laptop and wants the width back should not re-collapse it on every reload. Reading
 * it lazily in the initialiser means the first paint is already correct rather than
 * flashing wide and then narrowing.
 */
const NAV_KEY = "strata.nav.collapsed";

export function AppShell({
  router,
  children,
  /** Route-specific status bar content, the canvas contributes its zoom control. */
  statusExtra,
}: {
  router: Router;
  children: ReactNode;
  statusExtra?: ReactNode;
}): JSX.Element {
  const ui = useFeedback();
  const { refresh, git, canEdit, workspace, user } = useWorkspace();

  /*
    The theme is shared rather than owned here now.

    The shell renders only once you are signed in, so while it owned the theme the screens on the
    way in had none: they were permanently light with no toggle. `useTheme` applies it from first
    paint instead, and this component is one of its consumers.
  */
  const { theme, setTheme, toggle: toggleTheme } = useTheme();

  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem(NAV_KEY) === "true",
  );

  useEffect(() => {
    localStorage.setItem(NAV_KEY, String(navCollapsed));
  }, [navCollapsed]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newModelOpen, setNewModelOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);



  // ------------------------------------------------------------ presence

  /**
   * Someone else changed the repo underneath us.
   *
   * Refetch rather than patch. The server re-reads the workspace from disk on every
   * request, so a refetch is authoritative; applying an incremental update here would
   * create a second, worse answer to "what does the model say".
   *
   * Debounced because one propose fires several writes in a row, and reloading four times
   * in a second reads as a stutter rather than as freshness.
   */
  const remoteChangeTimer = useRef<number | undefined>(undefined);
  const onRemoteChange = useCallback(
    (change: { scope: string; by?: string }) => {
      window.clearTimeout(remoteChangeTimer.current);
      remoteChangeTimer.current = window.setTimeout(() => {
        refresh();
        ui.toast({
          message: change.by
            ? `${change.by} changed the workspace, reloaded`
            : "The workspace changed on disk, reloaded",
          tone: "info",
          duration: 4000,
        });
      }, 400);
    },
    [refresh, ui],
  );

  const presence = usePresence({ enabled: true, onChanged: onRemoteChange });
  useAnnounceLocation(presence.connectionId, modelOf(router.route), undefined);

  const actions = useMemo<ShellActions>(
    () => ({
      openNewModel: () => setNewModelOpen(true),
      openImport: () => setImportOpen(true),
      openPropose: () => setProposeOpen(true),
      openPalette: () => setPaletteOpen(true),
      presence,
    }),
    [presence],
  );

  // ------------------------------------------------------------ global keys

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const typing =
        target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

      // ⌘K works even while typing, it is how you leave a field and go somewhere else.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if (typing) return;

      // Bare `/` focuses search, as it does in every code host. Not while typing, or it
      // would be impossible to type a slash into a path field.
      if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="shell">
      <div className="shell__top">
        <TopBar
          router={router}
          peers={presence.peers}
          connectionId={presence.connectionId}
          live={presence.connected}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenPalette={() => setPaletteOpen(true)}
          onPropose={() => setProposeOpen(true)}
        />
      </div>

      <div className="shell__nav">
        <Sidebar
          router={router}
          collapsed={navCollapsed}
          onToggleCollapsed={() => setNavCollapsed((current) => !current)}
        />
      </div>

      <main className="shell__main">{children}</main>

      <div className="shell__status">
        <StatusBar router={router} extra={statusExtra} />
      </div>

      {paletteOpen ? (
        <CommandPalette
          router={router}
          onClose={() => setPaletteOpen(false)}
          onNewModel={() => setNewModelOpen(true)}
          onImport={() => setImportOpen(true)}
          onPropose={() => setProposeOpen(true)}
          onToggleTheme={toggleTheme}
        />
      ) : null}

      {newModelOpen && workspace ? (
        <NewModelDialog
          models={workspace.models}
          onClose={() => setNewModelOpen(false)}
          onCreate={(input) => {
            setNewModelOpen(false);
            void (async () => {
              /**
               * Written through `createObject` with a full object rather than the
               * `{kind, name}` shorthand, because the shorthand carries no namespace or
               * tier, and those two fields are what make this a *new domain* rather than
               * another model in an existing one.
               */
              const created = await ui.attempt(
                () =>
                  api.createObject({
                    object: {
                      id: `model_${input.namespace}_${input.tier}`.replace(/[^a-zA-Z0-9_]/g, "_"),
                      kind: "model",
                      name: input.name,
                      tier: input.tier,
                      namespace: input.namespace,
                      ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
                    },
                  }),
                "Could not create the model",
              );
              refresh();
              // Creating a model *is* choosing what to work on, so go straight into it.
              if (created?.object) {
                router.go({ name: "model", model: String(created.object.name), tab: "diagram" });
              }
            })();
          }}
        />
      ) : null}

      {importOpen && workspace ? (
        <ImportDialog
          models={workspace.models}
          canEdit={canEdit}
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            refresh();
          }}
        />
      ) : null}

      {proposeOpen && git ? (
        <ProposeDialog
          git={git}
          onClose={() => setProposeOpen(false)}
          onDone={() => {
            setProposeOpen(false);
            refresh();
          }}
        />
      ) : null}

      {/*
        Settings is a dialog driven by the URL.

        Deep links matter here, the overview's setup checklist sends people straight to
        Settings → Git, and "go and find the git tab" is not something worth explaining in
        prose. Rendered from the shell because it needs the theme, which the shell owns.
      */}
      {router.route.name === "settings" ? (
        <SettingsDialog
          initialSection={router.route.section}
          currentUser={user}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => window.history.back()}
          onChanged={refresh}
        />
      ) : null}
      </div>
    </ShellActionsContext.Provider>
  );
}
