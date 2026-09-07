import type {
  AuthState,
  BranchList,
  CloudRepo,
  CloudState,
  InviteCheck,
  PublicInvite,
  ComparePair,
  CompareResult,
  DiagramConnector,
  DiagramShape,
  Diagnostic,
  DictionaryView,
  GitStatus,
  GovernanceReport,
  GraphView,
  HistoryEntry,
  HistorySummaryEntry,
  ImportAnalysis,
  Delivery,
  IntegrationsResponse,
  SkillGateResult,
  SkillsResponse,
  IntegrationTestResult,
  WatchResult,
  ImpactResult,
  LayoutPreview,
  LineageResult,
  Lock,
  MemberPatch,
  MigrationResult,
  ModelObject,
  Peer,
  ObjectDetail,
  ObjectProvenance,
  ProposeResult,
  PublicUser,
  Role,
  RootDiagnosis,
  SearchResult,
  Settings,
  SettingsPatch,
  SettingsResponse,
  Workspace,
  WriteResponse,
} from "./types";

/**
 * API client.
 *
 * Errors carry the server's own message and status. Status matters here: a 409 is a
 * concurrent-edit conflict the user resolves by reloading, and a 422 is a
 * validation failure they resolve by fixing a field. Collapsing those into one
 * generic error would make both unfixable.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: { path: string; message: string }[] = [],
    /** Present when a propose was blocked by model validation errors. */
    readonly validationErrors: Diagnostic[] = [],
    /**
     * There is no model repo here yet, as distinct from one that failed to parse.
     *
     * The two arrive as different statuses but the distinction is what matters, not the
     * code: a missing workspace means offer to create one, a broken workspace means show
     * the parse error and change nothing.
     */
    readonly needsInit: boolean = false,
    /**
     * The directory the server is pointed at, sent alongside `needsInit`.
     *
     * Carried on the error rather than parsed back out of the message, so the setup flow
     * can show the operator the exact path it is about to write to, the one thing worth
     * confirming before creating a repository inside a bind mount.
     */
    readonly root: string | undefined = undefined,
    /**
     * Whether the server can actually create a repository at `root`, and why not.
     *
     * Carried alongside `needsInit` because the two together decide what the setup flow may
     * offer. Without it the flow could only ever show a button and hope: it had no way to know
     * the path was unwritable until the operator pressed it and read a 500.
     */
    readonly rootDiagnosis: RootDiagnosis | undefined = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isValidation(): boolean {
    return this.status === 422;
  }

  /** A propose blocked because `strata check` would fail, offer an override. */
  get isBlockedByValidation(): boolean {
    return this.status === 409 && this.validationErrors.length > 0;
  }

  /** Not signed in, or the session expired. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Signed in, but the role is insufficient. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/**
 * This tab's id on the live event stream, set from the `hello` frame.
 *
 * Sent on every write so the server can leave us out of the resulting broadcast, * without it, saving would immediately tell you the workspace changed and to reload,
 * which is both useless and, mid-edit, actively destructive.
 */
let connectionId: string | undefined;

export function setConnectionId(id: string | undefined): void {
  connectionId = id;
}

export function getConnectionId(): string | undefined {
  return connectionId;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    // The session is an HttpOnly cookie, so it has to be sent explicitly.
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(connectionId ? { "x-strata-connection": connectionId } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let issues: { path: string; message: string }[] = [];
    let validationErrors: Diagnostic[] = [];
    let needsInit = false;
    let root: string | undefined;
    let rootDiagnosis: RootDiagnosis | undefined;
    try {
      const body = (await response.json()) as {
        error?: string;
        issues?: typeof issues;
        validationErrors?: Diagnostic[];
        needsInit?: boolean;
        root?: string;
        writable?: boolean;
        reason?: string;
        hint?: string;
      };
      if (body.error) message = body.error;
      if (body.issues) issues = body.issues;
      if (body.validationErrors) validationErrors = body.validationErrors;
      if (body.needsInit) needsInit = true;
      if (typeof body.root === "string") root = body.root;
      // `writable` present at all means the server ran the preflight; absent means an older
      // build or a route that does not answer this question, and the flow degrades to offering.
      if (typeof body.writable === "boolean") {
        rootDiagnosis = {
          writable: body.writable,
          ...(body.reason ? { reason: body.reason } : {}),
          ...(body.hint ? { hint: body.hint } : {}),
        };
      }
    } catch {
      // Not JSON; the status line is the best we have.
    }
    throw new ApiError(message, response.status, issues, validationErrors, needsInit, root, rootDiagnosis);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export const api = {
  me: () => request<AuthState>("/auth/me"),

  login: (body: { username: string; password: string }) =>
    post<{ user: PublicUser }>("/auth/login", body),

  setup: (body: { username: string; password: string; displayName?: string }) =>
    post<{ user: PublicUser }>("/auth/setup", body),

  logout: () => post<{ ok: boolean }>("/auth/logout", {}),

  cloudMe: () => request<CloudState>("/cloud/me"),

  cloudRepos: () => request<{ repos: CloudRepo[] }>("/cloud/repos"),

  cloudChoose: (repo: string) =>
    post<{ repo: string; role: Role; private: boolean }>("/cloud/workspace", { repo }),

  cloudLogout: () => post<{ ok: boolean }>("/cloud/logout", {}),

  listInvites: () => request<{ items: PublicInvite[]; roles: Role[] }>("/invites"),

  createInvite: (body: { role: Role; username?: string; displayName?: string; email?: string }) =>
    post<{ invite: PublicInvite; link: string; emailed: boolean; emailError?: string }>(
      "/invites",
      body,
    ),

  mailStatus: () =>
    request<{ configured: boolean; host?: string; port?: number; from?: string }>("/mail"),

  sendTestMail: (to: string) => post<{ ok: boolean; to: string }>("/mail/test", { to }),

  revokeInvite: (id: string) =>
    request<{ invite: PublicInvite }>(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /*
    POST, not GET with the token in the path. A request body is not written to an access log, and
    `requestLogger` redacts any field whose name contains "token" before anything is written.
  */
  inviteCheck: (token: string) => post<InviteCheck>("/invites/check", { token }),

  inviteAccept: (body: { token: string; username: string; password: string; displayName?: string }) =>
    post<{ user: PublicUser }>("/invites/accept", body),

  changePassword: (body: { current: string; next: string }) =>
    post<{ ok: boolean }>("/auth/password", body),

  listUsers: () => request<{ items: PublicUser[]; roles: Role[] }>("/users"),

  createUser: (body: { username: string; password: string; displayName?: string; role: Role }) =>
    post<{ user: PublicUser }>("/users", body),

  updateUser: (
    id: string,
    body: { displayName?: string; role?: Role; password?: string; disabled?: boolean },
  ) => put<{ user: PublicUser }>(`/users/${encodeURIComponent(id)}`, body),

  /** Close your own account. The username is typed back as confirmation. */
  closeMyAccount: (username: string) =>
    request<{ ok: boolean }>("/account", {
      method: "DELETE",
      body: JSON.stringify({ username }),
    }),

  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/users/${encodeURIComponent(id)}`, { method: "DELETE" }),

  settings: () => request<SettingsResponse>("/settings"),

  saveSettings: (patch: SettingsPatch) => put<{ settings: Settings }>("/settings", patch),

  workspace: (reload = false) => request<Workspace>(`/workspace${reload ? "?reload=true" : ""}`),

  /** Create the model repo on a fresh instance. Same code path as `strata init`. */
  initWorkspace: (body: {
    name: string;
    description?: string;
    preset?: string;
    gitInit?: boolean;
  }) =>
    post<{
      ok: boolean;
      root: string;
      name: string;
      gitInitialised: boolean;
      gitError?: string;
    }>("/workspace/init", body),

  graph: (model: string, diagramId?: string) =>
    request<GraphView>(
      `/models/${encodeURIComponent(model)}/graph${diagramId ? `?diagram=${encodeURIComponent(diagramId)}` : ""}`,
    ),

  diagnostics: () => request<{ items: Diagnostic[]; counts: Record<string, number> }>("/diagnostics"),

  // ---------------------------------------------------------------- integrations

  integrations: () => request<IntegrationsResponse>("/integrations"),

  /**
   * Save one provider. Only the secrets present in `secrets` are written.
   *
   * An absent secret key leaves the stored value alone; an empty string clears it. That is what
   * lets the form show "configured ••••1234" without ever holding the value.
   */
  saveIntegration: (
    id: string,
    body: {
      enabled?: boolean;
      settings?: Record<string, string>;
      events?: string[];
      secrets?: Record<string, string>;
    },
  ) => put<{ ok: boolean }>(`/integrations/${encodeURIComponent(id)}`, body),

  testIntegration: (id: string, settings: Record<string, string>) =>
    post<IntegrationTestResult>(`/integrations/${encodeURIComponent(id)}/test`, { settings }),

  /**
   * Poll for a merge now, rather than waiting out the interval.
   *
   * The same work the background watcher does. Exposed because an operator who has just fixed a
   * credential wants to know immediately whether the fix took.
   */
  checkIntegrations: () =>
    post<WatchResult & { deliveries: Delivery[] }>("/integrations/check", {}),

  // ---------------------------------------------------------------- skills

  /**
   * The skills in this workspace, with the deterministic ones already run.
   *
   * Agent skills are not run here, they cost money and seconds per call, so they report
   * `skipped` until someone presses Run.
   */
  skills: () => request<SkillsResponse>("/skills"),

  /** Run the skills now, agents included. Omit `name` to run everything. */
  runSkills: (body: { name?: string }) => post<SkillGateResult>("/skills/run", body),

  /**
   * Turn a skill on or off.
   *
   * Writes the skill's own file, so the change lands in the repo and merges through review.
   * Disabling a governance rule should be as visible as writing one.
   */
  setSkillEnabled: (name: string, enabled: boolean) =>
    put<{ ok: boolean; file: string }>(`/skills/${encodeURIComponent(name)}`, { enabled }),

  /** Search models, objects, fields, descriptions and glossary definitions. */
  search: (q: string) => request<SearchResult>(`/search?q=${encodeURIComponent(q)}`),

  /** The data dictionary as a document. Preview unless `write` is set. */
  docs: (body: { model?: string; format: "markdown" | "html"; governance?: boolean; write?: boolean }) =>
    post<{ folder: string; written: boolean; files: { path: string; contents: string }[] }>(
      "/generate/docs",
      body,
    ),

  /** Apply an autofixable finding. The server re-verifies the fix still applies. */
  applyFix: (body: { objectId: string; code: string; path: string; value: unknown }) =>
    post<WriteResponse>("/diagnostics/fix", body),

  object: (id: string) => request<ObjectDetail>(`/objects/${encodeURIComponent(id)}`),

  listObjects: (params: { kind?: string; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.kind) search.set("kind", params.kind);
    if (params.q) search.set("q", params.q);
    const query = search.toString();
    return request<{
      items: { id: string; kind: string; name: string; model: string | null; file: string | null }[];
    }>(`/objects${query ? `?${query}` : ""}`);
  },

  createObject: (body: { kind: string; name: string; model?: string } | { object: ModelObject }) =>
    post<WriteResponse>("/objects", body),

  updateObject: (id: string, object: ModelObject, revision?: string) =>
    put<WriteResponse>(`/objects/${encodeURIComponent(id)}`, { object, revision }),

  /**
   * Model settings, in one request.
   *
   * Deliberately not `updateObject` with a patched model object. Renaming a model or moving
   * it to another domain relocates every file in it and rewrites every reference to it, so
   * it is a server-side refactor rather than a write of one document. `null` clears a
   * field; omitting it leaves it alone.
   */
  updateModelSettings: (
    id: string,
    patch: {
      name?: string;
      namespace?: string | null;
      displayName?: string | null;
      description?: string | null;
      tags?: string[];
      lifecycle?: string | null;
    },
  ) =>
    request<{
      model: ModelObject;
      objectsChanged: number;
      moved: number;
      configChanged: boolean;
    }>(`/models/${encodeURIComponent(id)}/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /**
   * What changed, scoped to one model or one domain.
   *
   * Unscoped would be the whole repository, which is a different question and already has a
   * home in Changes, so a caller has to say what it wants the history *of*.
   */
  history: (scope: { model?: string; domain?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (scope.model) params.set("model", scope.model);
    if (scope.domain) params.set("domain", scope.domain);
    if (scope.limit) params.set("limit", String(scope.limit));
    return request<{
      entries: HistoryEntry[];
      truncated: boolean;
      scope: string;
      pathCount: number;
    }>(`/history?${params.toString()}`);
  },

  /** Recent changes for every model at once, one git log, bucketed on the server. */
  historySummary: () =>
    request<{ byModel: Record<string, HistorySummaryEntry[]> }>("/history/summary"),

  /** The DDL that would migrate `from`'s tables into `to`'s shape. Physical models only. */
  migration: (body: { from: string; to: string; dropColumns?: boolean }) =>
    post<MigrationResult>("/compare/migration", body),

  renameDomain: (from: string, to: string) =>
    post<{ models: string[]; objectsChanged: number }>(
      `/domains/${encodeURIComponent(from)}/rename`,
      { name: to },
    ),

  updateObjectRaw: (id: string, yaml: string, revision?: string) =>
    put<WriteResponse>(`/objects/${encodeURIComponent(id)}/raw`, { yaml, revision }),

  updateMember: (id: string, patch: MemberPatch) =>
    request<WriteResponse>(`/objects/${encodeURIComponent(id)}/members`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** Every field of every object in a model, with structured classification. */
  dictionary: (model: string) =>
    request<DictionaryView>(`/models/${encodeURIComponent(model)}/dictionary`),

  /** Where a value comes from, or where it goes. Column-level when `column` is given. */
  lineage: (id: string, options: { column?: string; direction?: "upstream" | "downstream" } = {}) => {
    const search = new URLSearchParams();
    if (options.column) search.set("column", options.column);
    if (options.direction) search.set("direction", options.direction);
    const query = search.toString();
    return request<LineageResult>(
      `/objects/${encodeURIComponent(id)}/lineage${query ? `?${query}` : ""}`,
    );
  },

  /** What breaks if this changes, ranked by severity. */
  impact: (id: string, options: { column?: string } = {}) => {
    const query = options.column ? `?column=${encodeURIComponent(options.column)}` : "";
    return request<ImpactResult>(`/objects/${encodeURIComponent(id)}/impact${query}`);
  },

  /** Why this object exists: the commit, the pull request, and the ticket behind it. */
  provenance: (id: string) =>
    request<ObjectProvenance>(`/objects/${encodeURIComponent(id)}/provenance`),

  /*
    Coverage, the classified-field register, and what is still undecided.

    No markdown variant here on purpose: the download is a plain navigation to
    `?format=markdown`, so the browser handles the file rather than this client building a blob.
  */
  governance: () => request<GovernanceReport>("/governance"),

  addMember: (id: string) =>
    post<WriteResponse & { name: string }>(`/objects/${encodeURIComponent(id)}/members`, {}),

  deleteMember: (id: string, path: string) =>
    request<WriteResponse>(
      `/objects/${encodeURIComponent(id)}/members?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  deleteForeignKey: (tableId: string, name: string) =>
    request<WriteResponse>(
      `/objects/${encodeURIComponent(tableId)}/foreign-keys?name=${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  toggleKey: (id: string, name: string) =>
    post<WriteResponse>(`/objects/${encodeURIComponent(id)}/members/key`, { name }),

  deleteObject: (id: string) =>
    request<{ path: string; fileRemoved: boolean }>(`/objects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  saveLayout: (
    model: string,
    patch: {
      positions?: { objectId: string; x: number; y: number }[];
      shapes?: DiagramShape[];
      connectors?: DiagramConnector[];
      gridSize?: number;
      /** Merged into the diagram on disk, so it cannot clobber concurrent box moves. */
      notation?: string;
    },
  ) => put<{ diagramId: string; created: boolean; path: string }>(
    `/models/${encodeURIComponent(model)}/layout`,
    patch,
  ),

  createRelationship: (
    model: string,
    body: {
      parentId: string;
      childId: string;
      cardinality?: string;
      identifying?: boolean;
      verbPhrase?: string;
      parentMembers?: string[];
      childMembers?: string[];
    },
  ) =>
    post<{ created: "relationship" | "foreignKey"; path: string }>(
      `/models/${encodeURIComponent(model)}/relationships`,
      body,
    ),

  previewLayout: (preset: string) => post<LayoutPreview>("/layout/preview", { preset }),

  applyLayout: (preset: string) =>
    post<{ preset: string; written: number; deleted: number }>("/layout/apply", { preset }),

  generateDdl: (body: { model?: string; write?: boolean }) =>
    post<{
      folder: string;
      /** `status` compares the generated contents against what is on disk. */
      files: { path: string; kind: string; contents: string; status: "new" | "modified" | "unchanged" }[];
      counts?: { new: number; modified: number; unchanged: number };
      written?: number;
      total?: number;
    }>("/generate/ddl", body),

  generateCodeowners: (write = false) =>
    post<{ path: string; contents?: string; written?: boolean }>("/generate/codeowners", { write }),

  /**
   * The repository as files, for the Repository view.
   *
   * `status` is git's, folded in server-side so the tree can mark changed files where you
   * are already looking rather than in a separate list you have to cross-reference.
   */
  files: () =>
    request<{
      root: string;
      entries: {
        path: string;
        name: string;
        type: "file" | "directory";
        size?: number;
        status?: string;
      }[];
    }>("/files"),

  fileContent: (path: string) =>
    request<{ path: string; contents: string; size: number; binary: boolean }>(
      `/files/content?path=${encodeURIComponent(path)}`,
    ),

  saveFile: (path: string, contents: string) =>
    put<{ path: string; created: boolean; diagnostics: Record<string, number> }>("/files/content", {
      path,
      contents,
    }),

  /** Dataform SQLX from the mappings. Same preview-then-write contract as DDL. */
  generateDataform: (body: { model?: string; write?: boolean }) =>
    post<{
      folder: string;
      files: { path: string; kind: string; contents: string; status: "new" | "modified" | "unchanged" }[];
      counts?: { new: number; modified: number; unchanged: number };
      written?: number;
      total?: number;
    }>("/generate/dataform", body),

  githubTokenStatus: () =>
    request<{ configured: boolean; source: string; hint?: string; editable: boolean }>("/secrets/github"),

  setGithubToken: (token: string) =>
    put<{ configured: boolean; source: string; hint?: string; editable: boolean }>("/secrets/github", { token }),

  presence: () => request<{ peers: Peer[]; locks: Lock[] }>("/presence"),

  announceWhere: (body: { connectionId: string; model?: string; diagram?: string }) =>
    post<{ ok: boolean; peers: Peer[] }>("/presence/where", body),

  claimLock: (body: { objectId: string; connectionId: string; name?: string }) =>
    post<{ lock: Lock }>("/locks", body),

  releaseLock: (objectId: string, connection: string) =>
    request<{ released: boolean }>(
      `/locks/${encodeURIComponent(objectId)}?connectionId=${encodeURIComponent(connection)}`,
      { method: "DELETE" },
    ),

  comparePairs: () =>
    request<{ pairs: ComparePair[]; models: { name: string; tier: string; namespace?: string }[] }>(
      "/compare/pairs",
    ),

  compare: (body: { left: string; right: string }) => post<CompareResult>("/compare", body),

  analyzeImport: (body: { text: string; format?: string; model?: string; tier?: string; dataset?: string }) =>
    post<ImportAnalysis>("/import/analyze", body),

  applyImport: (body: {
    text: string;
    format?: string;
    model: string;
    tier?: string;
    dataset?: string;
    overwrite?: boolean;
  }) =>
    post<{ written: number; files: string[]; failed: { id: string; error: string }[] }>(
      "/import/apply",
      body,
    ),

  gitStatus: () => request<GitStatus>("/git/status"),

  setGitRemote: (url: string) => post<GitStatus & { verified: boolean }>("/git/remote", { url }),

  gitBranches: () => request<BranchList>("/git/branches"),

  gitDiff: (path?: string) =>
    request<{ diff: string }>(`/git/diff${path ? `?path=${encodeURIComponent(path)}` : ""}`),

  propose: (body: {
    branch: string;
    title: string;
    body: string;
    commitMessage?: string;
    base?: string;
    allowInvalid?: boolean;
    /** Push the base branch first when it exists locally but not on the remote. */
    publishBase?: boolean;
  }) => post<ProposeResult>("/git/propose", body),

  discard: (paths: string[]) => post<{ discarded: string[] }>("/git/discard", { paths }),
};
