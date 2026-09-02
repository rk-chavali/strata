import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { api, ApiError } from "../api";
import { useFeedback } from "../ui";
import type {
  AuthState,
  Capabilities,
  CloudState,
  GitStatus,
  PublicUser,
  Workspace,
} from "../types";

/**
 * Workspace, git and identity, in one place.
 *
 * The old `App.tsx` held all of this as fourteen `useState`s and passed the results down
 * through five layers of props, `canEdit` alone appeared in nine component signatures.
 * That is why adding a page meant touching the shell, and why "who is allowed to do this"
 * was answered slightly differently in different components.
 *
 * Context is right for this specific data because it is genuinely global (one workspace,
 * one signed-in user), read by nearly every page, and changes rarely, the three
 * conditions under which context does not cause needless re-render churn.
 *
 * Deliberately *not* in here: the selected object, the open diagram, canvas tool state.
 * Those are per-view, change on every click, and belong to the view that owns them.
 */

interface WorkspaceState {
  /** Undefined until the first `/auth/me` resolves, the app shows a boot screen. */
  auth: AuthState | undefined;
  /**
   * Hosted mode, or `cloud: false` on a self-hosted instance.
   *
   * Undefined until the first `/cloud/me` resolves. Both this and `auth` are consulted before the
   * app renders, because which of the two decides sign-in depends on the answer.
   */
  cloud: CloudState | undefined;
  workspace: Workspace | undefined;
  git: GitStatus | undefined;
  /**
   * Whether the git request has come back yet.
   *
   * `git === undefined` meant three different things, not fetched, request failed, and not a
   * repository, and the status bar rendered all three as a definite "Not a git repository".
   * Since the status request takes over a second on a real repo, that warning was shown on
   * every page load about repositories that were perfectly fine. A separate flag lets a caller
   * say "not yet known", which is not a claim about anything.
   */
  gitLoaded: boolean;
  user: PublicUser | null;
  signedIn: boolean;
  /** Auth off, or an editor/admin. Mirrors what the server will actually allow. */
  canEdit: boolean;
  isAdmin: boolean;
  /**
   * What this deployment can do, with safe defaults before the workspace has loaded.
   *
   * Everything defaults to *off* while loading, and that direction is deliberate: a nav item that
   * appears and then vanishes is worse than one that appears a moment late, and defaulting to on
   * would put us back to showing features that are not there.
   */
  can: Capabilities;
  /** Fatal load failure, a bad workspace path, an unreachable server. */
  error: string | undefined;
  /**
   * There is no model repo yet, so the answer is the setup flow rather than an error.
   *
   * Kept separate from `error` because the two demand opposite responses. A fresh
   * instance pointed at an empty volume is not broken, it is unconfigured, and the app
   * can fix that itself.
   */
  needsInit: boolean;
  /** The directory the server is pointed at, known only while `needsInit`. */
  initRoot: string | undefined;
  /** Bumped on every write, so views that hold their own fetches can re-run them. */
  refreshKey: number;
  refresh: () => void;
  reloadAuth: () => Promise<void>;
  reloadCloud: () => Promise<void>;
  /**
   * Run a write, surface failure as a toast, refresh on success.
   *
   * Every mutation in the app goes through this. It is the single place that guarantees a
   * successful write is followed by a reload, the invariant that keeps the UI honest
   * about what is on disk, and the one most easily forgotten at an individual call site.
   */
  write: <T>(action: () => Promise<T>, context?: string) => Promise<T | undefined>;
}

const WorkspaceContext = createContext<WorkspaceState | undefined>(undefined);

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return state;
}

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const ui = useFeedback();

  const [auth, setAuth] = useState<AuthState | undefined>();
  const [workspace, setWorkspace] = useState<Workspace | undefined>();
  const [git, setGit] = useState<GitStatus | undefined>();
  const [gitLoaded, setGitLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [needsInit, setNeedsInit] = useState(false);
  const [initRoot, setInitRoot] = useState<string | undefined>();
  const [cloud, setCloud] = useState<CloudState | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await api.me());
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  const reloadCloud = useCallback(async () => {
    try {
      setCloud(await api.cloudMe());
    } catch {
      /*
        An older server has no `/cloud/me`, and a self-hosted one is not in this mode anyway. Both
        answer the same way: not hosted. Failing closed here would strand a working self-hosted
        instance on a boot screen because of a route it never needed.
      */
      setCloud({ cloud: false, user: null, repo: null });
    }
  }, []);

  useEffect(() => {
    void reloadAuth();
    void reloadCloud();
  }, [reloadAuth, reloadCloud]);

  /**
   * Signed in, by whichever mode this deployment runs.
   *
   * Hosted needs both halves: a GitHub identity *and* a chosen repository. Identity alone leaves
   * no workspace to read, and the server refuses model routes in that state, so treating it as
   * signed in would render the whole app against a workspace that does not exist.
   */
  const signedIn = cloud?.cloud
    ? Boolean(cloud.user && cloud.repo)
    : Boolean(auth && (!auth.authEnabled || auth.user));

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    api
      // `reload: true` forces the server to re-read from disk. Cheap, and it means a
      // colleague's push is visible without anyone restarting anything.
      .workspace(true)
      .then((result) => {
        if (cancelled) return;
        setWorkspace(result);
        setError(undefined);
        setNeedsInit(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 401 here means the session expired between `/auth/me` and this call. Re-read
        // auth rather than showing a load error, the right response is the sign-in form.
        if (err instanceof ApiError && err.isUnauthenticated) {
          void reloadAuth();
          return;
        }
        // No workspace yet: not an error, a state the setup flow exists to resolve. The
        // message is still carried so the flow can name the path it is about to write to.
        if (err instanceof ApiError && err.needsInit) {
          setNeedsInit(true);
          setInitRoot(err.root);
          setError(err.message);
          return;
        }
        setError(err instanceof ApiError ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn, refreshKey, reloadAuth]);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    // Git failing is not fatal: the workspace may legitimately not be a repo, and the UI
    // handles `undefined` by hiding the source-control affordances.
    api
      .gitStatus()
      .then((result) => {
        if (cancelled) return;
        setGit(result);
        setGitLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setGit(undefined);
        // Failed is still an answer: we asked, and there is no usable git state.
        setGitLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, refreshKey]);

  const write = useCallback(
    async <T,>(action: () => Promise<T>, context?: string): Promise<T | undefined> => {
      const result = await ui.attempt(action, context);
      if (result !== undefined) refresh();
      return result;
    },
    [refresh, ui],
  );

  const user = auth?.user ?? null;
  const authEnabled = auth?.authEnabled ?? true;

  const value = useMemo<WorkspaceState>(
    () => ({
      auth,
      cloud,
      workspace,
      git,
      gitLoaded,
      user,
      signedIn,
      canEdit: !authEnabled || user?.role === "editor" || user?.role === "admin",
      isAdmin: !authEnabled || user?.role === "admin",
      can: workspace?.capabilities ?? {
        github: false,
        git: false,
        remote: false,
        bigquery: false,
        dataform: false,
        integrations: false,
        skills: false,
        agentSkills: false,
        auth: authEnabled,
        multiTenant: false,
      },
      error,
      needsInit,
      initRoot,
      refreshKey,
      refresh,
      reloadAuth,
      reloadCloud,
      write,
    }),
    [
      auth,
      cloud,
      workspace,
      git,
      gitLoaded,
      user,
      signedIn,
      authEnabled,
      error,
      needsInit,
      initRoot,
      refreshKey,
      refresh,
      reloadAuth,
      reloadCloud,
      write,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
