import { useCallback, useState } from "react";
import type { JSX } from "react";
import { AppShell, useShellActions } from "./app/AppShell";
import { HOME, useRouter, type Route, type Router } from "./app/routes";
import { WorkspaceProvider, useWorkspace } from "./app/WorkspaceContext";
import { FeedbackProvider } from "./ui";
import { ChangesPage } from "./pages/ChangesPage";
import { ComparePage } from "./pages/ComparePage";
import { ModelPage } from "./pages/ModelPage";
import { ModelsPage } from "./pages/ModelsPage";
import { DomainPage } from "./pages/DomainPage";
import { OutputPage } from "./pages/OutputPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { GovernancePage } from "./pages/GovernancePage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProblemsPage } from "./pages/ProblemsPage";
import { SetupPage } from "./pages/SetupPage";
import { AuthPage } from "./pages/AuthPage";
import { CloudPage } from "./pages/CloudPage";
import { InvitePage } from "./pages/InvitePage";

/**
 * The application root.
 *
 * This was 982 lines. It is now a provider stack, a gate, and a switch.
 *
 * Everything that used to live here moved to where it belongs: workspace and identity to
 * `WorkspaceProvider`, chrome and the globally-reachable dialogs to `AppShell`, and each
 * view's own state to its page. The test of whether that division is right is that adding a
 * page touches this file by one line and nothing else, which it now does.
 */

export function App(): JSX.Element {
  /*
    Redeeming an invitation is checked before anything else, and outside the workspace provider.

    The visitor has no account yet, which is the entire point, so every gate below would send them
    to a sign-in screen they cannot pass. It also skips loading a workspace they cannot read, which
    on a hosted instance would be somebody else's.

    Read once from `location.pathname` rather than through the router, because the router's route
    union describes the signed-in application and this is the one screen that is not part of it.
  */
  if (window.location.pathname === "/invite") {
    return (
      <FeedbackProvider>
        <InvitePage />
      </FeedbackProvider>
    );
  }

  return (
    <FeedbackProvider>
      <WorkspaceProvider>
        <Routes />
      </WorkspaceProvider>
    </FeedbackProvider>
  );
}

function Routes(): JSX.Element {
  const router = useRouter();
  const {
    auth,
    cloud,
    workspace,
    signedIn,
    error,
    needsInit,
    initRoot,
    initDiagnosis,
    reloadAuth,
    reloadCloud,
    refresh,
  } = useWorkspace();

  /**
   * The canvas contributes to the status bar.
   *
   * Lifted here rather than rendered inside the canvas, so diagram state appears in the
   * shell's status bar instead of floating over the diagram, which is where the old status
   * chips sat, permanently covering the bottom-right of every model.
   */
  const [statusExtra, setStatusExtra] = useState<JSX.Element | undefined>();
  const onStatusExtra = useCallback((node: JSX.Element | undefined) => setStatusExtra(node), []);

  // ------------------------------------------------------------ gates

  // Both, because which of the two decides sign-in depends on which mode the server is in, and
  // rendering the local password form to a hosted visitor would be a dead end: there is no local
  // account for them to type a password into.
  if (!auth || !cloud) {
    return <div className="boot">{error ?? "Starting…"}</div>;
  }

  if (!signedIn) {
    return cloud.cloud ? (
      <CloudPage
        cloud={cloud}
        onChanged={() => {
          /*
            Both, in this order of importance. `reloadCloud` moves the flow on from sign-in to
            picking a repository, and `reloadAuth` picks up the identity and role the server
            derives from the GitHub permission once a repository has been chosen.
          */
          void reloadCloud();
          void reloadAuth();
          refresh();
        }}
      />
    ) : (
      <AuthPage
        needsSetup={auth.needsSetup}
        onSignedIn={() => {
          void reloadAuth();
          refresh();
        }}
      />
    );
  }

  /**
   * No model repo yet: offer to create one rather than reporting a failure.
   *
   * This gate sits above the workspace check because there is genuinely nothing to show, * no sidebar, no status bar, nothing for the shell to wrap. It replaces a dead end that
   * told the user to go and run `strata init` in a shell they may not have.
   *
   * Deliberately not gated on the `/setup` route. Someone who has just started a container
   * lands on `/`, and redirecting them somewhere first would only add a step.
   */
  if (needsInit) {
    return (
      <SetupPage
        root={initRoot}
        diagnosis={initDiagnosis}
        onDone={(firstModel) => {
          // Straight into the model they just created, creating it *was* choosing what to
          // work on. Falls back to the overview when they skipped that step.
          if (firstModel) {
            router.go({ name: "model", model: firstModel, tab: "diagram" }, { replace: true });
          } else {
            router.go(HOME, { replace: true });
          }
          refresh();
        }}
      />
    );
  }

  if (!workspace) {
    return (
      <div className="boot">
        {error ? (
          <>
            <h1 style={{ fontSize: "var(--fs-lg)" }}>Cannot read the model repo</h1>
            <p className="mono err-text">{error}</p>
            <p className="muted">
              Point the server at a directory containing <code>strata.config.yaml</code> with{" "}
              <code>STRATA_WORKSPACE</code>.
            </p>
          </>
        ) : (
          "Loading workspace…"
        )}
      </div>
    );
  }

  return (
    <AppShell router={router} statusExtra={statusExtra}>
      <CurrentPage router={router} route={router.route} onStatusExtra={onStatusExtra} />
    </AppShell>
  );
}

/**
 * Route to page.
 *
 * A single exhaustive switch over the route union. The compiler enforces that every route
 * is handled, the concrete benefit of the union over the old bag of booleans, where a new
 * view meant remembering to add a case to two separate derivations and nothing checked that
 * you had.
 */
function CurrentPage({
  router,
  route,
  onStatusExtra,
}: {
  router: Router;
  route: Route;
  onStatusExtra: (node: JSX.Element | undefined) => void;
}): JSX.Element {
  const { openNewModel, openImport, openPropose } = useShellActions();

  switch (route.name) {
    // `/models` is the same answer as the overview: every model, grouped by domain. Kept as
    // a distinct URL because it is the obvious thing to type, not because it needs a
    // different page.
    /**
     * The set of models, with search, filters and sort.
     *
     * Its own page rather than a sidebar tree, because a workspace can hold hundreds of
     * models and a tree in a 248px column cannot navigate that. Same relationship Harness
     * has between its sidebar and its pipeline list.
     */
    case "models":
      return <ModelsPage router={router} onNewModel={openNewModel} onImport={openImport} />;

    /**
     * One business domain.
     *
     * Sits between the models list and a model, which is the level the transcript asks for:
     * clicking a domain has to land somewhere that carries its tags, its owners and the
     * models inside it, the role a project page plays in Harness.
     */
    case "domain":
      return <DomainPage router={router} route={route} onNewModel={openNewModel} />;

    case "overview":
    // Settings renders as a dialog from the shell, over whatever was behind it. The
    // overview is the right backdrop for a deep link that arrived cold.
    case "settings":
    case "setup":
      return (
        <OverviewPage
          router={router}
          onNewModel={openNewModel}
          onImport={openImport}
          onPropose={openPropose}
        />
      );

    case "model":
      return <ModelPage router={router} route={route} onStatusExtra={onStatusExtra} />;

    case "problems":
      return <ProblemsPage />;

    case "changes":
      return <ChangesPage onPropose={openPropose} />;

    case "compare":
      return <ComparePage router={router} />;

    case "output":
      return <OutputPage />;

    case "integrations":
      return <IntegrationsPage />;

    case "skills":
      return <SkillsPage />;
    case "governance":
      return <GovernancePage />;
  }
}
