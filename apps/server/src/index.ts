import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import {
  OBJECT_KINDS,
} from "@strata/metamodel";
import {
  CONFIG_FILENAME,
  LAYOUT_PRESETS,
  serializeObject,
  type LoadedWorkspace,
  updateConfig,
} from "@strata/storage";
import {
  AUTH_DISABLED,
  CLOUD_API_URL,
  CLOUD_BASE_URL,
  CLOUD_CLIENT_ID,
  CLOUD_CLIENT_SECRET,
  CLOUD_COOKIE,
  CLOUD_ENABLED,
  CLOUD_GITHUB_URL,
  CLOUD_SESSION_TTL_MS,
  CLOUD_STATE_COOKIE,
  COOKIE_SECURE,
  DATA_DIR,
  FEATURES,
  GIT_AUTHOR,
  MODEL_BRANCH,
  MODEL_REPO,
  PORT,
  TENANT_COOKIE,
  TENANT_DIR,
  TENANT_SEED,
  TENANT_TTL_MS,
  TRUST_PROXY,
  WATCH_INTERVAL_MS,
  WORKSPACE,
} from "./env.js";
import {
  audit,
  auth,
  deliveries,
  loginThrottle,
  presence,
  secrets,
  stores,
} from "./services.js";
import {
  allDiagnostics,
  getWorkspace,
  refresh,
  workspaceRoot,
} from "./workspacecache.js";
import { compareRoutes } from "./routes/compare.js";
import { generationRoutes } from "./routes/generation.js";
import { importRoutes } from "./routes/importing.js";
import { presenceRoutes } from "./routes/presence.js";
import { settingsRoutes } from "./routes/settings.js";
import { setupRoutes } from "./routes/setup.js";
import { userRoutes } from "./routes/users.js";
import { writeRoutes } from "./routes/write.js";
import {
  agentCompletion,
  gcpAuth,
  githubTokenFor,
} from "./credentials.js";
import { workspaceExists } from "./workspacecache.js";
import {
  admins,
  bigqueryOn,
  editors,
  featuresFor,
  integrationsOn,
  readers,
  recordAudit,
  skillsOn,
  type CloudRequest,
} from "./guards.js";
import { handler } from "./respond.js";
import {
  revisionOf,
  updateMember,
  updateObject,
} from "./edit.js";
import {
  attributeTitle,
  checkRemoteAccess,
  diff,
  discard,
  fetchDefaultBranch,
  initRepo,
  listBranches,
  propose,
  removeRemote,
  setRemote,
  status,
  type GitStatus,
} from "./git.js";
import { stripCredentials, validateRemoteUrl } from "./gitcreds.js";
import { bootstrapWorkspace } from "./bootstrap.js";
import { MailError, invitationMessage, looksLikeEmail, sendMail, type SmtpConfig } from "./mailer.js";
import {
  AuthError,
  ROLES,
  attachUser,
  clearSessionCookie,
  hasRole,
  setSessionCookie,
  toPublicUser,
  type AuthedRequest,
  type Role,
  type User,
} from "./auth.js";
import {
  generateDocs,
  environmentNames,
} from "@strata/ddl";
import { PathError, listFiles, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import { buildGraphView, diagnosticsView, modelViews, objectDetail } from "@strata/query";
import { dictionaryView } from "@strata/query";
import { impact, lineage } from "@strata/query";
import { search } from "@strata/query";
import {
  PROVIDERS,
  isReady,
  providerById,
  secretFields,
  secretKey,
  testProvider,
  type IntegrationEvent,
  type IntegrationState,
} from "./integrations.js";
import { buildChangeSummary } from "./changes.js";
import { dispatch } from "./dispatch.js";
import { MergeWatcher } from "./watcher.js";
import { loadSkills, runGate, setSkillEnabled } from "./skills.js";
import { objectProvenance, type JiraReadConfig } from "./provenance.js";
import { governanceReport, renderGovernanceMarkdown } from "./governance.js";
import { diagnoseRoot } from "./workspaceroot.js";
import { listTaxonomies, proposeMapping } from "./bigquery.js";
import { TenantStore, runInTenant, type Tenant } from "./tenancy.js";
import {
  CloudError,
  GitHubIdentity,
  SessionSealer,
  issueState,
  parseRepo,
  tenantIdForRepo,
  verifyState,
  type CloudSession,
} from "./cloud.js";
import { type AuditAction } from "./audit.js";
import { clientKey } from "./throttle.js";
import { corsOptions, securityHeaders } from "./security.js";
import { errorHandler, log, requestLogger } from "./logging.js";
import { assertSafeUrl, trimTrailingSlashes } from "./ssrf.js";
import { writeArchive } from "./archive.js";
import {
  advise,
  adviceSummary,
  classificationCoverage,
  suggestClassifications,
} from "@strata/query";

/**
 * API server.
 *
 * The workspace is re-read from disk after every write rather than kept as
 * authoritative in-memory state. That is the point of a git-native tool: the files
 * are the truth, so someone pulling a branch or editing in their IDE must be visible
 * here immediately. Caching the model would guarantee drift.
 */




const app = express();

/*
  Express is told about the proxy only when the operator says there is one.

  `trust proxy` changes what `req.ip` reports and whether `req.protocol` believes
  `X-Forwarded-Proto`. Left on by default it would let any client claim any address, which is
  exactly what the login throttle counts on being true.
*/
if (TRUST_PROXY) app.set("trust proxy", true);

app.use(requestLogger());
app.use(securityHeaders());
app.use(cors(corsOptions()));
app.use(express.json({ limit: "8mb" }));
app.use(attachUser(auth));

/**
 * POST/PUT/DELETE endpoints that never touch the repo.
 *
 * Everything else that succeeds is assumed to have changed something on disk and gets
 * announced to other sessions. An allow-list would be the safer default, but it means
 * every new write route has to remember to opt in, and the failure mode of forgetting
 * is silent: other people's screens just quietly go stale.
 */
const NON_MUTATING = [
  /^\/api\/auth\//,
  /^\/api\/presence\b/,
  /^\/api\/locks\b/,
  /^\/api\/layout\/preview$/,
  /^\/api\/secrets\//,
];

app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  if (NON_MUTATING.some((pattern) => pattern.test(req.path))) {
    next();
    return;
  }
  // Generation is preview-by-default; only the writing form changes the repo.
  const isPreview =
    req.path.startsWith("/api/generate/") && (req.body as { write?: boolean })?.write !== true;
  if (isPreview) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const user = (req as AuthedRequest).user;
    presence().announceChange({
      scope: req.path.startsWith("/api/git/")
        ? "git"
        : req.path.startsWith("/api/generate/")
          ? "generated"
          : req.path.startsWith("/api/settings")
            ? "settings"
            : "objects",
      ...(user ? { by: { username: user.username, displayName: user.displayName } } : {}),
      // Set by the client from the `hello` frame, so we can skip the originator: nobody
      // needs to be told their own save landed.
      ...(typeof req.headers["x-strata-connection"] === "string"
        ? { originConnectionId: req.headers["x-strata-connection"] }
        : {}),
    });
  });
  next();
});




/**
 * Built on first use, because the signing secret loads asynchronously.
 *
 * Signed with the same secret that signs sessions, so there is one secret to persist rather than
 * two. Losing it invalidates trial cookies, which costs a visitor their scratch workspace, * acceptable, and far better than a second secret nobody remembers to back up.
 */
let tenantStore: TenantStore | undefined;

async function tenantsReady(): Promise<TenantStore | undefined> {
  if (!TENANT_DIR) return undefined;
  if (!tenantStore) {
    tenantStore = new TenantStore({
      base: TENANT_DIR,
      secret: await auth.signingSecret(),
      ttlMs: TENANT_TTL_MS,
    });
  }
  return tenantStore;
}


let cloudParts: { identity: GitHubIdentity; sealer: SessionSealer } | undefined;

/** Built on first use, because the signing secret that keys the session loads asynchronously. */
async function cloudReady(): Promise<{ identity: GitHubIdentity; sealer: SessionSealer }> {
  if (!CLOUD_ENABLED || !CLOUD_CLIENT_ID || !CLOUD_CLIENT_SECRET || !CLOUD_BASE_URL) {
    throw new CloudError("hosted sign-in is not enabled on this deployment", 404);
  }
  if (!cloudParts) {
    cloudParts = {
      identity: new GitHubIdentity({
        clientId: CLOUD_CLIENT_ID,
        clientSecret: CLOUD_CLIENT_SECRET,
        baseUrl: CLOUD_BASE_URL,
        ...(CLOUD_GITHUB_URL ? { githubUrl: CLOUD_GITHUB_URL } : {}),
        ...(CLOUD_API_URL ? { apiUrl: CLOUD_API_URL } : {}),
      }),
      sealer: new SessionSealer(await auth.signingSecret()),
    };
  }
  return cloudParts;
}

/**
 * Routes that work before a workspace has been chosen.
 *
 * Everything else has to be refused rather than allowed to fall through, because falling through
 * means `workspaceRoot()` returns the instance's own default workspace. On a hosted deployment
 * that is somebody else's data, so this is the boundary that keeps signed-out and
 * workspace-less requests from reading it.
 */
function worksWithoutWorkspace(path: string): boolean {
  if (!path.startsWith("/api")) return true;
  return path.startsWith("/api/cloud/") || path === "/api/health" || path === "/api/auth/me";
}

/**
 * Give every request a workspace of its own.
 *
 * Runs before the routes and wraps the whole request in async context, so `getWorkspace()` deep
 * inside a handler resolves the right directory without any route knowing tenancy exists.
 *
 * A visitor with no cookie gets a workspace created for them on the spot. That is the trial
 * experience working as intended: no signup, no empty state, straight into a model.
 */
function tenantMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    if (!TENANT_DIR) {
      next();
      return;
    }

    void (async () => {
      try {
        const tenants = await tenantsReady();
        if (!tenants) {
          next();
          return;
        }

        const cookies = parseCookies(req.headers.cookie);

        if (CLOUD_ENABLED) {
          const { sealer } = await cloudReady();
          const session = sealer.unseal(cookies[CLOUD_COOKIE]);
          (req as CloudRequest).cloud = session;

          if (session?.repo) {
            /*
              A user the role guards can read.

              `requireRole` reads `req.user`, which comes from the local account store, and in
              hosted mode there is no local account: identity is the GitHub sign-in and the role is
              the caller's permission on the repository. Without this bridge every guarded route
              would refuse a legitimately signed-in customer, which is to say the product would be
              read-only for everybody using it.

              `passwordHash` is empty and never consulted. This user is synthesised per request and
              never enters the account store, so there is nothing for `verify()` to find and no
              password path that could reach it.
            */
            (req as AuthedRequest).user = {
              id: `gh_${session.user.id}`,
              username: session.user.login,
              displayName: session.user.name ?? session.user.login,
              role: session.role ?? "viewer",
              passwordHash: "",
              createdAt: new Date(0).toISOString(),
            } satisfies User;

            /*
              Derived from the repository, not allocated. That is what makes a workspace shared:
              a colleague signing in separately computes the same id and lands in the same
              checkout, with no record anywhere mapping one to the other.
            */
            const id = tenantIdForRepo(session.repo, await auth.signingSecret());
            await runInTenant({ id, root: tenants.rootFor(id), createdAt: "" }, async () => {
              next();
            });
            return;
          }

          if (!worksWithoutWorkspace(req.path)) {
            res.status(401).json({
              error: session ? "choose a workspace to continue" : "sign in to continue",
              needsWorkspace: Boolean(session),
            });
            return;
          }

          next();
          return;
        }

        const existing = tenants.parse(cookies[TENANT_COOKIE]);

        let tenant: Tenant;
        if (existing && (await tenants.exists(existing))) {
          tenant = { id: existing, root: tenants.rootFor(existing), createdAt: "" };
        } else {
          tenant = await tenants.create(TENANT_SEED);
          /*
            `SameSite=Lax` and `HttpOnly` for the same reasons as the session cookie. Not `Secure`
            unconditionally, because a local `docker run` over plain http must still work, the
            deployment sets STRATA_COOKIE_SECURE when it terminates TLS.
          */
          const parts = [
            `${TENANT_COOKIE}=${tenants.sign(tenant.id)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            `Max-Age=${Math.floor(TENANT_TTL_MS / 1000)}`,
          ];
          if (COOKIE_SECURE) parts.push("Secure");
          res.append("Set-Cookie", parts.join("; "));
        }

        await runInTenant(tenant, async () => {
          next();
        });
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** Minimal cookie parsing, the server has no cookie middleware and needs two values. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/*
  Registered before the routes, so async context is established for every handler.

  Placed after auth attachment so a future signed-in tenancy scheme can key on the user; today
  trial tenants are anonymous and keyed on their own cookie.
*/
app.use(tenantMiddleware());







/**
 * Git status, with the default branch resolved properly.
 *
 * `status()` reads `refs/remotes/origin/HEAD`, which git only writes during a clone, * so a repo connected by `remote add` reports no default at all, and callers fall back
 * to the literal `main`. Asking GitHub costs one request and is right even when the
 * default is `master`, `develop`, or whichever branch happened to be pushed first.
 */
async function gitState(root: string, token?: string): Promise<GitStatus> {
  const base = await status(root);
  if (base.defaultBranch || !base.github) return base;

  const resolved = await fetchDefaultBranch(base.github, token ?? (await secrets().githubToken()));
  return resolved ? { ...base, defaultBranch: resolved } : base;
}



/** The pull request number out of a `.../pull/42` URL. */
function prNumber(url: string | undefined): number | undefined {
  const found = url ? /\/pull\/(\d+)/.exec(url) : undefined;
  return found ? Number(found[1]) : undefined;
}


/**
 * The merge watcher.
 *
 * Constructed here rather than inside `start()` because the integrations routes expose a
 * "check now" action that drives the same poll, an operator who has just fixed a token should
 * not have to wait out the interval to find out whether it worked.
 */
const watcher = new MergeWatcher({
  dataDir: DATA_DIR,
  getWorkspace: (fresh) => getWorkspace(fresh === true),
  context: async () => ({ secrets: secrets(), log: deliveries() }),
  defaultBranch: async () => (await gitState(workspaceRoot())).defaultBranch,
  githubToken: () => secrets().githubToken(),
  intervalMs: WATCH_INTERVAL_MS,
});

/**
 * Fire the integrations for an event, without ever letting them affect the request.
 *
 * Deliberately not awaited by its callers. A proposal is the user's work and an integration is
 * a side effect of it: a slow Confluence site must not make the propose button spin, and a bad
 * webhook URL must not turn a successful proposal into an error the user sees. Failures are
 * recorded in the delivery log, which is where an operator goes to look for them.
 */
function fireAndForget(summary: Parameters<typeof dispatch>[1]): void {
  void getWorkspace()
    .then((workspace) => dispatch({ workspace, secrets: secrets(), log: deliveries() }, summary))
    .catch(() => undefined);
}


/**
 * Add an attribution trailer to the pull request description.
 *
 * The title stamp is short by necessity. The body is where a reviewer who does not
 * recognise a username can find the display name behind it, so it goes here in full
 * rather than being crammed into the title.
 */
function proposeBody(body: string, user: AuthedRequest["user"]): string {
  if (auth.disabled || !user) return body;
  const trailer = `Proposed by **${user.displayName}** (\`${user.username}\`) from the data modelling tool.`;
  const trimmed = body.trim();
  return trimmed ? `${trimmed}\n\n---\n${trailer}` : trailer;
}

app.use(presenceRoutes);
// ---------------------------------------------------------------- auth

app.get(
  "/api/auth/me",
  handler(async (req, res) => {
    res.json({
      authEnabled: !auth.disabled,
      needsSetup: await auth.needsSetup(),
      user: req.user ? toPublicUser(req.user) : null,
    });
  }),
);

/** First-run: create the initial administrator. Only works while no user exists. */
app.post(
  "/api/auth/setup",
  handler(async (req, res) => {
    if (!(await auth.needsSetup())) {
      res.status(409).json({ error: "this instance is already set up" });
      return;
    }
    const body = req.body as { username?: string; password?: string; displayName?: string };
    const user = await auth.createUser({
      username: body.username ?? "",
      password: body.password ?? "",
      ...(body.displayName ? { displayName: body.displayName } : {}),
      role: "admin",
    });

    const full = await auth.findById(user.id);
    if (full) setSessionCookie(res, await auth.issueToken(full), COOKIE_SECURE);

    /*
      Recorded even though nobody is signed in yet.

      This is the single most consequential unauthenticated action the server offers, and the one
      an attacker uses if a data volume is ever lost. An entry here is how an operator later tells
      "we set this up in March" from "somebody else set this up on Tuesday".
    */
    await recordAudit(req, "auth.setup", { target: user.username });

    res.status(201).json({ user });
  }),
);

app.post(
  "/api/auth/login",
  handler(async (req, res) => {
    const body = req.body as { username?: string; password?: string };
    const username = (body.username ?? "").trim().toLowerCase();

    /*
      Two counters, and either can refuse.

      Per address stops one host grinding a password list. Per account stops the same attack
      spread across a botnet, which is what credential stuffing actually looks like. See
      `throttle.ts` for why this is on the auth route and nowhere else.
    */
    const keys = [clientKey(req.headers, req.socket.remoteAddress, TRUST_PROXY)];
    if (username) keys.push(`user:${username}`);

    const verdict = loginThrottle.check(keys);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
      await recordAudit(req, "auth.login.failed", {
        target: username,
        ok: false,
        detail: `throttled for ${verdict.retryAfterSeconds}s`,
      });
      res.status(429).json({
        error: `Too many sign-in attempts. Try again in ${verdict.retryAfterSeconds} seconds.`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }

    let user;
    try {
      user = await auth.verify(username, body.password ?? "");
    } catch (error) {
      loginThrottle.fail(keys);
      await recordAudit(req, "auth.login.failed", {
        target: username,
        ok: false,
        detail: error instanceof AuthError ? error.message : "sign-in failed",
      });
      throw error;
    }

    loginThrottle.succeed(keys);
    setSessionCookie(res, await auth.issueToken(user), COOKIE_SECURE);
    await recordAudit(req, "auth.login", { target: user.username });
    res.json({ user: toPublicUser(user) });
  }),
);

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Change your own password. Distinct from an admin resetting someone else's. */
app.post(
  "/api/auth/password",
  editors,
  handler(async (req, res) => {
    const body = req.body as { current?: string; next?: string };
    if (!req.user) {
      res.status(401).json({ error: "sign in to continue" });
      return;
    }
    await auth.verify(req.user.username, body.current ?? "");
    await auth.updateUser(req.user.id, { password: body.next ?? "" });
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- hosted sign-in

/**
 * `SameSite=Lax`, so the cookie survives the redirect back from GitHub.
 *
 * `Strict` would not: the callback is a cross-site navigation, so a strict cookie is withheld on
 * exactly the request that needs it, and the sign-in appears to succeed and then drops the user
 * straight back to the sign-in page with no error to explain it.
 */
function setCloudCookie(res: express.Response, value: string, maxAgeSeconds: number): void {
  const parts = [
    `${CLOUD_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

/** Where to send somebody to sign in with GitHub. */
app.get(
  "/api/cloud/login",
  handler(async (req, res) => {
    const { identity } = await cloudReady();
    const state = issueState(await auth.signingSecret());

    // Short lived and separate from the session: it exists only to be compared on the way back.
    const parts = [`${CLOUD_STATE_COOKIE}=${state}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=600"];
    if (COOKIE_SECURE) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));

    res.redirect(identity.authorizeUrl(state));
  }),
);

app.get(
  "/api/cloud/callback",
  handler(async (req, res) => {
    const { identity, sealer } = await cloudReady();
    const secret = await auth.signingSecret();

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const returned = typeof req.query.state === "string" ? req.query.state : undefined;
    const stored = parseCookies(req.headers.cookie)[CLOUD_STATE_COOKIE];

    /*
      Both halves are checked. The signature proves we issued the state and that it is recent; the
      comparison against the cookie proves it was issued to *this* browser. Checking only the
      signature would still admit a state minted in the attacker's own session, which is the login
      CSRF that leaves a victim signed in as somebody else.
    */
    if (!code || !returned || returned !== stored || !verifyState(returned, secret)) {
      await recordAudit(req, "auth.login.failed", { ok: false, detail: "cloud state mismatch" });
      res.status(400).json({ error: "this sign-in link has expired, please try again" });
      return;
    }

    const token = await identity.exchangeCode(code);
    const user = await identity.identify(token);

    const session: CloudSession = { user, token, exp: Date.now() + CLOUD_SESSION_TTL_MS };
    setCloudCookie(res, sealer.seal(session), Math.floor(CLOUD_SESSION_TTL_MS / 1000));
    res.append("Set-Cookie", `${CLOUD_STATE_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);

    await recordAudit(req, "auth.login", { target: user.login });

    // Back to the app rather than to JSON: this URL is reached by a browser redirect, so the
    // person on the other end is looking at a page, not reading a response body.
    res.redirect("/");
  }),
);

app.post("/api/cloud/logout", (_req, res) => {
  setCloudCookie(res, "", 0);
  res.json({ ok: true });
});

/** Who is signed in, and which workspace they are in. Answers for signed-out callers too. */
app.get(
  "/api/cloud/me",
  handler(async (req, res) => {
    if (!CLOUD_ENABLED) {
      res.json({ cloud: false, user: null, repo: null });
      return;
    }
    const session = (req as CloudRequest).cloud;
    res.json({
      cloud: true,
      user: session ? session.user : null,
      repo: session?.repo ?? null,
    });
  }),
);

/** Repositories this person could open as a workspace. */
app.get(
  "/api/cloud/repos",
  handler(async (req, res) => {
    const { identity } = await cloudReady();
    const session = (req as CloudRequest).cloud;
    if (!session) throw new CloudError("sign in to continue", 401);

    res.json({ repos: await identity.listRepos(session.token) });
  }),
);

/**
 * Open a repository as the workspace.
 *
 * Access is re-checked here rather than trusted from the listing, because the listing may be
 * minutes old and access can be removed in between. This is the only place that decides somebody
 * may read a model, so it asks GitHub at the moment of the decision.
 */
app.post(
  "/api/cloud/workspace",
  handler(async (req, res) => {
    const { identity, sealer } = await cloudReady();
    const tenants = await tenantsReady();
    const session = (req as CloudRequest).cloud;

    if (!session) throw new CloudError("sign in to continue", 401);
    if (!tenants) throw new CloudError("this deployment has no workspace storage", 500);

    const body = req.body as { repo?: string };
    const access = await identity.repoAccess(session.token, parseRepoInput(body.repo));

    const id = tenantIdForRepo(access.fullName, await auth.signingSecret());
    const root = tenants.rootFor(id);

    /*
      Clone on first open, reuse afterwards. `bootstrapWorkspace` already refuses to clone over an
      existing checkout and keeps the token out of `.git/config`, so this is one call rather than
      a second clone path written to a different standard.
    */
    await bootstrapWorkspace({
      workspace: root,
      repo: access.cloneUrl,
      branch: access.defaultBranch,
      token: session.token,
      log: (message) => log("info", "cloud.workspace", { detail: message }),
    });

    /*
      The role is sealed into the session rather than looked up per request.

      Checking GitHub on every request would be correct and unaffordable: the REST API allows five
      thousand calls an hour per user, which a single active session would spend on page loads
      alone. The cost is staleness. A permission *reduced* at GitHub stays in effect here until the
      session expires, so `CLOUD_SESSION_TTL_MS` is the revocation window, and that is the number to
      lower if a deployment needs a tighter one.
    */
    setCloudCookie(
      res,
      sealer.seal({ ...session, repo: access.fullName, role: access.role }),
      Math.floor(CLOUD_SESSION_TTL_MS / 1000),
    );

    await recordAudit(req, "auth.login", { target: `${session.user.login} -> ${access.fullName}` });

    res.json({ repo: access.fullName, role: access.role, private: access.private });
  }),
);

/** Validated at the edge, so `parseRepo` never sees `undefined`. */
function parseRepoInput(value: string | undefined): string {
  if (!value) throw new CloudError("a repository is required", 422);
  const { owner, name } = parseRepo(value);
  return `${owner}/${name}`;
}


app.use(userRoutes);
// ---------------------------------------------------------------- invitations

/**
 * The link an invitation produces.
 *
 * **The token goes in the fragment, not the path.** A fragment is never sent to a server, so it
 * stays out of our access logs, out of any reverse proxy's logs, and out of the `Referer` header
 * if the page ever links onward. A token in the path would be written to disk by every hop
 * between the browser and the process, which for a credential that creates an account is a poor
 * place for it to sit.
 */
function inviteLink(req: express.Request, token: string): string {
  const base = CLOUD_BASE_URL ?? `${req.protocol}://${req.get("host") ?? "localhost:4000"}`;
  return `${trimTrailingSlashes(base)}/invite#${token}`;
}


/**
 * The mail settings, or `undefined` when this deployment has none.
 *
 * Held in the secret store rather than in a new file, which gets three things for free: it is
 * encrypted at rest, it is per tenant, and every value can be injected as
 * `STRATA_SECRET_SMTP_HOST` and friends instead of typed into a browser, which is what a
 * Kubernetes operator will want.
 *
 * Host and from address are the minimum. Everything else has a defensible default, and plenty of
 * internal relays accept mail from the local network with no credentials at all.
 */
async function smtpConfig(): Promise<SmtpConfig | undefined> {
  const store = secrets();
  const [host, port, username, password, from, fromName, security] = await Promise.all([
    store.get("smtp.host"),
    store.get("smtp.port"),
    store.get("smtp.username"),
    store.get("smtp.password"),
    store.get("smtp.from"),
    store.get("smtp.from_name"),
    store.get("smtp.security"),
  ]);

  if (!host?.trim() || !from?.trim()) return undefined;

  return {
    host: host.trim(),
    port: Number(port) || 587,
    ...(username?.trim() ? { username: username.trim() } : {}),
    ...(password ? { password } : {}),
    from: from.trim(),
    ...(fromName?.trim() ? { fromName: fromName.trim() } : {}),
    security: (["auto", "tls", "starttls", "none"] as const).includes(security as never)
      ? (security as SmtpConfig["security"])
      : "auto",
  };
}

/**
 * Try to email an invitation, and report what happened without ever failing the caller.
 *
 * **Sending is best effort on purpose.** The invitation already exists and its link is in the
 * response, so a mail server that is down, misconfigured or slow costs the admin a copy and paste
 * rather than the invitation itself. Throwing here would roll back nothing and lose the link.
 */
async function tryEmailInvite(input: {
  to: string;
  link: string;
  role: string;
  invitedBy: string;
}): Promise<{ emailed: boolean; error?: string }> {
  const config = await smtpConfig();
  if (!config) return { emailed: false };

  try {
    await sendMail(config, invitationMessage({ ...input, instance: CLOUD_BASE_URL ?? undefined }));
    return { emailed: true };
  } catch (error) {
    const message = error instanceof MailError ? error.message : "the invitation could not be sent";
    log("error", "invitation email failed", { detail: message });
    return { emailed: false, error: message };
  }
}

app.get(
  "/api/invites",
  admins,
  handler(async (_req, res) => {
    res.json({ items: await auth.listInvites(), roles: ROLES });
  }),
);

app.post(
  "/api/invites",
  admins,
  handler(async (req, res) => {
    const body = req.body as {
      role?: Role;
      username?: string;
      displayName?: string;
      email?: string;
    };

    const email = body.email?.trim();
    if (email && !looksLikeEmail(email)) {
      res.status(422).json({ error: `\`${email}\` is not an email address` });
      return;
    }

    const { invite, token } = await auth.createInvite({
      role: body.role ?? "viewer",
      ...(body.username ? { username: body.username } : {}),
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(email ? { email } : {}),
      createdBy: req.user?.username ?? "unknown",
    });

    const link = inviteLink(req, token);
    const sent = email
      ? await tryEmailInvite({
          to: email,
          link,
          role: invite.role,
          invitedBy: req.user?.displayName || req.user?.username || "An administrator",
        })
      : { emailed: false };

    await recordAudit(req, "auth.invite.created", {
      target: email ?? invite.username ?? invite.id,
      ...(sent.error ? { detail: `email failed: ${sent.error}` } : {}),
    });

    /*
      The link is returned whether or not the email went out, and it is returned only here,
      because the server keeps a hash and cannot produce it again. An admin whose mail server is
      misconfigured still has something to send.
    */
    res.status(201).json({
      invite,
      link,
      emailed: sent.emailed,
      ...(sent.error ? { emailError: sent.error } : {}),
    });
  }),
);

app.delete(
  "/api/invites/:id",
  admins,
  handler(async (req, res) => {
    const invite = await auth.revokeInvite(req.params.id ?? "");
    await recordAudit(req, "auth.invite.revoked", { target: invite.username ?? invite.id });
    res.json({ invite });
  }),
);

/**
 * What the redemption screen needs to render, for an unauthenticated caller.
 *
 * POST rather than GET with the token in the path, for the same reason the link uses a fragment:
 * a request body is not written to an access log, and `requestLogger` redacts any field whose
 * name contains "token" before anything is written at all.
 *
 * A bad token, a used one, a revoked one and an expired one all answer the same way. Telling them
 * apart would confirm to somebody guessing that a token had once been real.
 */
app.post(
  "/api/invites/check",
  handler(async (req, res) => {
    const body = req.body as { token?: string };
    const invite = await auth.inviteForToken(body.token);

    if (!invite) {
      res.status(404).json({ error: "this invitation is no longer valid" });
      return;
    }

    res.json({
      role: invite.role,
      username: invite.username ?? null,
      displayName: invite.displayName ?? null,
      expiresAt: invite.expiresAt,
    });
  }),
);

/** Redeem an invitation: the person sets their own password, and is signed in. */
app.post(
  "/api/invites/accept",
  handler(async (req, res) => {
    const body = req.body as {
      token?: string;
      username?: string;
      password?: string;
      displayName?: string;
    };

    const user = await auth.redeemInvite(body.token ?? "", {
      username: body.username ?? "",
      password: body.password ?? "",
      ...(body.displayName ? { displayName: body.displayName } : {}),
    });

    // Signed in immediately. Redeeming already proved they hold the invitation, and asking them
    // to type the password they just chose into a second form proves nothing further.
    const full = await auth.findById(user.id);
    if (full) setSessionCookie(res, await auth.issueToken(full), COOKIE_SECURE);

    await recordAudit(req, "auth.invite.redeemed", { target: user.username });

    res.status(201).json({ user });
  }),
);


/** Whether mail is configured, so the UI can say so without revealing the settings. */
app.get(
  "/api/mail",
  admins,
  handler(async (_req, res) => {
    const config = await smtpConfig();
    res.json({
      configured: Boolean(config),
      ...(config ? { host: config.host, port: config.port, from: config.from } : {}),
    });
  }),
);

/**
 * Send a test message.
 *
 * **Mail configuration is the classic thing that looks saved and does nothing.** A wrong port, a
 * from address the provider will not send as, or a password with a trailing space all produce
 * settings that appear correct, and the first sign of trouble is a colleague who never received
 * their invitation. This turns that into an answer now.
 */
app.post(
  "/api/mail/test",
  admins,
  handler(async (req, res) => {
    const config = await smtpConfig();
    if (!config) {
      res.status(422).json({ error: "no mail server is configured" });
      return;
    }

    const body = req.body as { to?: string };
    const to = body.to?.trim() || "";
    if (!looksLikeEmail(to)) {
      res.status(422).json({ error: "a recipient address is required" });
      return;
    }

    await sendMail(config, {
      to,
      subject: "Strata test message",
      text: [
        "This is a test from your Strata instance.",
        "",
        "If you are reading it, invitations will send.",
      ].join("\n"),
    });

    res.json({ ok: true, to });
  }),
);

// ---------------------------------------------------------------- files

/**
 * The repository, as files.
 *
 * The premise of this tool is that the model *is* files in a git repo, and until now the
 * UI never showed you one: you edited boxes, pressed Propose, and raised a pull request
 * over changes you had not seen. These three endpoints back the Repository view, which is
 * one toggle away from the diagram.
 *
 * Every path is validated by `resolveInside` before it touches the filesystem, see
 * `files.ts` for why that guard is written the way it is.
 */
app.get(
  "/api/files",
  readers,
  handler(async (_req, res) => {
    /**
     * The git status of each file, folded into the listing.
     *
     * Sent together because the tree is where "what have I changed" is most useful, a
     * marker on the file itself, rather than a separate list you have to cross-reference
     * against the tree you are already looking at.
     */
    const [entries, git] = await Promise.all([
      listFiles(workspaceRoot()),
      gitState(workspaceRoot()).catch(() => undefined),
    ]);

    const status = new Map((git?.files ?? []).map((file) => [file.path, file.label]));

    res.json({
      root: workspaceRoot(),
      entries: entries.map((entry) => ({
        ...entry,
        ...(status.has(entry.path) ? { status: status.get(entry.path) } : {}),
      })),
    });
  }),
);

app.get(
  "/api/files/content",
  readers,
  handler(async (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    try {
      res.json(await readWorkspaceFile(workspaceRoot(), path));
    } catch (error) {
      if (error instanceof PathError) {
        res.status(400).json({ error: error.message });
        return;
      }
      // A missing file is a 404, not a 500, the client links to paths that may have been
      // deleted by a colleague between the listing and the click.
      res.status(404).json({ error: `cannot read ${path}` });
    }
  }),
);

app.put(
  "/api/files/content",
  editors,
  handler(async (req, res) => {
    const body = req.body as { path?: unknown; contents?: unknown };
    const path = typeof body.path === "string" ? body.path : "";
    const contents = typeof body.contents === "string" ? body.contents : undefined;

    if (contents === undefined) {
      res.status(422).json({ error: "contents are required" });
      return;
    }

    try {
      const result = await writeWorkspaceFile(workspaceRoot(), path, contents);
      /**
       * Re-read the workspace after a raw file write.
       *
       * This is the one write path that can change *any* object, or make the workspace
       * unparseable, because it edits YAML directly rather than going through the object
       * editor. Refreshing means the diagram, the problems list and the object count all
       * reflect what was just typed, including when what was typed is broken.
       */
      const reloaded = await refresh();
      res.json({
        ...result,
        diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts,
      });
    } catch (error) {
      if (error instanceof PathError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }),
);

app.use(setupRoutes);
// ---------------------------------------------------------------- read

app.get(
  "/api/workspace",
  readers,
  handler(async (req, res) => {
    /**
     * Say "there is no workspace" distinctly from "the workspace is broken".
     *
     * Without this the two are indistinguishable to the client: both surface as a 500
     * from `loadWorkspace`, so the UI could only ever show a generic failure. They call
     * for opposite responses, a missing workspace should offer to create one, a
     * corrupt one must not, because the fix there is reading the parse error.
     */
    if (!workspaceExists()) {
      /*
        The writability check belongs here, not on the create attempt.

        Before this, any directory without a config file reported `needsInit: true`, so the setup
        screen offered "Create repository" whether or not the process could write there. An
        operator whose `STRATA_WORKSPACE` had been mangled by their shell got a button, pressed
        it, and learned the truth from a 500. Deciding it up front turns a dead control into an
        explanation, which is the only thing they can act on from a browser.
      */
      const diagnosis = await diagnoseRoot(workspaceRoot());
      res.status(404).json({
        error: `no ${CONFIG_FILENAME} in ${workspaceRoot()}`,
        needsInit: true,
        root: workspaceRoot(),
        ...diagnosis,
      });
      return;
    }

    const workspace = await getWorkspace(req.query.reload === "true");
    // Computed once and used twice: for the workspace-wide counts, and to attribute
    // problems to the model that owns each one.
    const diagnostics = allDiagnostics(workspace);

    /* Resolved once here: the capability map needs it and so does nothing else on this route. */
    const gitStatus = await status(workspace.root).catch(() => ({
      isRepo: false,
      remoteUrl: undefined,
    }));

    /*
      What *this caller* may use, which in a hosted deployment is not what the process permits.

      Reported rather than assumed, because the client hides a feature it is told it does not
      have. Sending the deployment-wide answer here was the visible half of the same mistake
      `featuresFor` exists to fix: the routes would have refused a hosted customer anyway, but
      the UI never got far enough to find out, so the pages simply were not there.
    */
    const features = featuresFor(req);

    res.json({
      name: workspace.config.name,
      description: workspace.config.description,
      root: workspace.root,
      layout: workspace.config.layout,
      presets: LAYOUT_PRESETS,
      kinds: OBJECT_KINDS,
      fileCount: workspace.filesByPath.size,
      objectCount: workspace.graph.all().length,
      models: modelViews(workspace.graph, diagnostics),
      dataform: workspace.config.dataform.map((c) => ({
        name: c.name,
        remote: c.remote ?? c.path ?? null,
        gcp: c.gcp ?? null,
        managed: c.managed,
        models: c.models,
      })),
      diagnostics: diagnosticsView(diagnostics).counts,
      /*
        What this deployment can actually do.

        The UI reads this instead of inferring from scattered fields. Every one of these is a
        component that may or may not be connected, and a feature whose component is missing has
        to say so rather than fail when someone clicks it, that distinction is the whole
        difference between "optional" and "broken".
      */
      capabilities: {
        github: Boolean(await githubTokenFor(req)),
        git: gitStatus.isRepo,
        remote: Boolean(gitStatus.remoteUrl),
        /*
          Two conditions, and both have to hold. The feature has to be permitted for this caller,
          *and* a credential has to exist. Reporting only the credential was survivable while the
          feature flag was deployment-wide, because a deployment with the feature off had no
          credential either. Per caller they come apart: the operator's own instance has a service
          account and a hosted tenant does not, and the tenant must not be told otherwise.
        */
        bigquery: features.bigquery && Boolean(await gcpAuth()),
        dataform: workspace.config.dataform.length > 0,
        integrations: features.integrations,
        /*
          Two separate questions, and conflating them cost the demo a dead tab.

          `skills` is whether this deployment permits the feature at all. `agentSkills` is whether
          an agent skill can actually run, which additionally needs a model provider key.

          The difference matters to the UI. Feature off means the page should not exist. Feature on
          with no key means the page is useful -- `check` skills are deterministic and need no key
          -- and only the agent ones report themselves skipped. One boolean could not express that,
          so the client showed a route refusal as an error.
        */
        skills: features.skills,
        agentSkills: features.skills && Boolean(await agentCompletion()),
        auth: !auth.disabled,
        multiTenant: Boolean(TENANT_DIR),
      },
      user: req.user ? toPublicUser(req.user) : null,
    });
  }),
);

app.get(
  "/api/models/:name/graph",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const name = req.params.name ?? "";
    const diagramId = typeof req.query.diagram === "string" ? req.query.diagram : undefined;
    const view = buildGraphView(workspace, name, diagramId);
    if (!view) {
      res.status(404).json({ error: `no model named \`${name}\`` });
      return;
    }
    res.json(view);
  }),
);

/**
 * The data dictionary: every field of every object in one model.
 *
 * Separate from the graph rather than folded into it. The graph is fetched on every
 * navigation and every position nudge, and carrying full structured classification for
 * several hundred columns in it would make the canvas pay for a screen it never renders.
 */
app.get(
  "/api/models/:name/dictionary",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const name = req.params.name ?? "";
    if (!workspace.graph.modelNamed(name)) {
      res.status(404).json({ error: `no model named \`${name}\`` });
      return;
    }
    res.json(dictionaryView(workspace.graph, name));
  }),
);

/**
 * Where a column comes from, and what breaks if it changes.
 *
 * One traversal behind two routes because the two questions have different audiences and
 * different shapes: lineage is a picture an analyst reads, impact is a ranked list a
 * reviewer acts on. Collapsing them into one endpoint would force each caller to do the
 * other one's work.
 */
app.get(
  "/api/objects/:id/lineage",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const column = typeof req.query.column === "string" ? req.query.column : undefined;
    const direction = req.query.direction === "downstream" ? "downstream" : "upstream";
    const depth = Number(req.query.depth);

    const result = lineage(workspace.graph, req.params.id ?? "", {
      ...(column ? { column } : {}),
      direction,
      ...(Number.isFinite(depth) && depth > 0 ? { depth } : {}),
    });

    if (!result) {
      res.status(404).json({ error: `no object with id \`${req.params.id}\`` });
      return;
    }
    res.json(result);
  }),
);

app.get(
  "/api/objects/:id/impact",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const column = typeof req.query.column === "string" ? req.query.column : undefined;

    const result = impact(workspace.graph, req.params.id ?? "", (column ? { column } : {}));

    if (!result) {
      res.status(404).json({ error: `no object with id \`${req.params.id}\`` });
      return;
    }
    res.json(result);
  }),
);

/**
 * Why this object exists: the commit, the pull request, and the ticket behind it.
 *
 * **Not gated on the integrations feature**, deliberately. The commit and the pull request come
 * out of git, which every workspace has, and they are most of the value. Gating the whole route
 * would mean a deployment with `STRATA_FEATURES=""` loses provenance it never needed an
 * integration for. Jira is consulted only when it is both enabled and configured, so the ticket
 * half switches itself off.
 */
app.get(
  "/api/objects/:id/provenance",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const id = req.params.id ?? "";

    if (!workspace.graph.get(id)) {
      res.status(404).json({ error: `no object with id \`${id}\`` });
      return;
    }

    res.json(
      await objectProvenance({
        root: workspace.root,
        file: workspace.pathById.get(id),
        ...(await jiraReadConfig(req, workspace)),
      }),
    );
  }),
);

/**
 * Jira credentials for reading, or nothing.
 *
 * Requires the provider to be *enabled* as well as configured. An operator who filled the fields
 * in and then turned the integration off has said no, and honouring that only for the outbound
 * half would be a surprising asymmetry: the same switch should stop us calling them at all.
 */
async function jiraReadConfig(
  req: express.Request,
  workspace: LoadedWorkspace,
): Promise<{ jira: JiraReadConfig } | undefined> {
  // `featuresFor(req)`, not a captured value: features are resolved per request, and a
  // deployment-wide constant read at import time is a bug this file has already had once.
  if (!featuresFor(req).integrations) return undefined;

  const configured = workspace.config.integrations?.jira;
  if (!configured?.enabled) return undefined;

  const settings = configured.settings ?? {};
  const token = await secrets().get(secretKey("jira", "token"));
  if (!settings.baseUrl || !settings.email || !token) return undefined;

  return {
    jira: {
      baseUrl: settings.baseUrl,
      email: settings.email,
      token,
      ...(settings.projectKeys ? { projectKeys: settings.projectKeys } : {}),
    },
  };
}

/**
 * The data dictionary as a document.
 *
 * A preview by default and a write only when asked, matching how DDL generation behaves, * because committing `docs/` is a real decision about what lands in the repo, and a GET that
 * quietly wrote files would make it for you.
 */
app.post(
  "/api/generate/docs",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      model?: string;
      format?: "markdown" | "html";
      governance?: boolean;
      write?: boolean;
      folder?: string;
    };

    let files;
    try {
      files = generateDocs(workspace.graph, {
        ...(body.model ? { model: body.model } : {}),
        format: body.format === "html" ? "html" : "markdown",
        ...(body.governance !== undefined ? { governance: body.governance } : {}),
        workspaceName: workspace.config.name,
        /*
          Stamped by the caller, not by the generator.

          A document that embeds the current time changes on every run, so committing it
          produces a diff when nothing about the model changed, and a file that always shows
          as modified is one people stop reading the diff of.
        */
        generatedAt: new Date().toISOString().slice(0, 10),
      });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const folder = body.folder ?? "docs";

    if (body.write) {
      if (!hasRole(req.user, "editor") && !auth.disabled) {
        res.status(403).json({ error: "writing generated files needs the `editor` role" });
        return;
      }
      for (const file of files) {
        await writeWorkspaceFile(workspace.root, `${folder}/${file.path}`, file.contents);
      }
    }

    res.json({
      folder,
      written: body.write === true,
      files: files.map((file) => ({ path: `${folder}/${file.path}`, contents: file.contents })),
    });
  }),
);

/**
 * Search everything: models, objects, fields, descriptions, glossary definitions.
 *
 * A GET because it is idempotent and cacheable, and because the palette hits it on a debounce
 *, a POST would defeat every layer of caching between here and the browser.
 */
/**
 * Integrations: which providers exist, and how each is configured.
 *
 * Secrets are reported as presence plus a four-character hint, never as values. That is not
 * defensive coding for its own sake, this response ends up in browser devtools, in screenshots,
 * and in bug reports, and a credential that is never sent cannot leak through any of them.
 */
app.get(
  "/api/integrations",
  integrationsOn,
  admins,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    const configured = workspace.config.integrations ?? {};
    const names = await secrets().listNames();
    const byName = new Map(names.map((entry) => [entry.name, entry]));

    const items: IntegrationState[] = [];
    for (const provider of PROVIDERS) {
      const config = configured[provider.id];
      const secretState: IntegrationState["secrets"] = {};

      for (const field of secretFields(provider)) {
        const found = byName.get(secretKey(provider.id, field.key));
        secretState[field.key] = found
          ? { configured: true, hint: found.hint, source: found.source }
          : { configured: false };
      }

      items.push({
        provider,
        enabled: config?.enabled ?? false,
        settings: config?.settings ?? {},
        secrets: secretState,
        events: (config?.events?.length
          ? config.events
          : provider.events) as IntegrationEvent[],
      });
    }

    res.json({
      items,
      /* Reported per provider so the UI can distinguish "off" from "not finished". */
      ready: Object.fromEntries(
        items.map((item) => [item.provider.id, isReady(item.provider, item.settings, item.secrets)]),
      ),
      /*
        The delivery history, sent with the state rather than fetched separately.

        "Configured" and "working" are different claims, and only the second one is worth
        anything. Without the last delivery beside each provider the page can only report what
        an operator typed into it, which is the question they already know the answer to.
      */
      latest: await deliveries().latestByProvider(),
      deliveries: await deliveries().list(50),
      watching: WATCH_INTERVAL_MS > 0,
    });
  }),
);

/** Save a provider's non-secret settings to the config, and its secrets to the store. */
app.put(
  "/api/integrations/:id",
  integrationsOn,
  admins,
  handler(async (req, res) => {
    const provider = providerById(req.params.id ?? "");
    if (!provider) {
      res.status(404).json({ error: `no integration provider \`${req.params.id}\`` });
      return;
    }

    const body = req.body as {
      enabled?: boolean;
      settings?: Record<string, string>;
      events?: string[];
      /** Only the secrets being changed. An absent key leaves the stored value alone. */
      secrets?: Record<string, string>;
    };

    const workspace = await getWorkspace();

    /*
      Written through `updateConfig`, which edits the YAML document in place.

      Rewriting the file from the parsed object would drop every comment in it, and a config
      that loses the operator's notes each time they toggle an integration is one they stop
      editing by hand.
    */
    await updateConfig(workspace.root, (doc) => {
      const known = new Set(provider.fields.filter((field) => field.type !== "secret").map((field) => field.key));

      if (body.enabled !== undefined) doc.setIn(["integrations", provider.id, "enabled"], body.enabled);
      if (body.events) doc.setIn(["integrations", provider.id, "events"], body.events);

      for (const [key, value] of Object.entries(body.settings ?? {})) {
        // Only fields the provider declares, so a client cannot write arbitrary keys into config.
        if (!known.has(key)) continue;
        if (value.trim()) doc.setIn(["integrations", provider.id, "settings", key], value);
        else doc.deleteIn(["integrations", provider.id, "settings", key]);
      }
    });

    const allowed = new Set(secretFields(provider).map((field) => field.key));
    for (const [key, value] of Object.entries(body.secrets ?? {})) {
      if (!allowed.has(key)) continue;
      // An empty string means "clear it"; an absent key means "leave it".
      await secrets().set(secretKey(provider.id, key), value.trim() ? value : undefined);
    }

    await refresh();
    res.json({ ok: true });
  }),
);

/**
 * Check the credentials reach the right place.
 *
 * Every test is read-only. An operator pressing Test is asking a question, and a test that
 * proved it could post by posting would be a genuinely unpleasant surprise.
 */
app.post(
  "/api/integrations/:id/test",
  integrationsOn,
  admins,
  handler(async (req, res) => {
    const provider = providerById(req.params.id ?? "");
    if (!provider) {
      res.status(404).json({ error: `no integration provider \`${req.params.id}\`` });
      return;
    }

    const workspace = await getWorkspace();
    const stored = workspace.config.integrations?.[provider.id];
    const body = req.body as { settings?: Record<string, string> };

    // Unsaved edits in the form are honoured, so an operator can test before committing config.
    const settings = { ...stored?.settings, ...body.settings };

    const resolved: Record<string, string | undefined> = {};
    for (const field of secretFields(provider)) {
      resolved[field.key] = await secrets().get(secretKey(provider.id, field.key));
    }

    res.json(await testProvider(provider, settings, resolved));
  }),
);

/**
 * Poll for a merge right now.
 *
 * The same work the background watcher does on its interval. Exposed because the interval is a
 * minute by default and an operator who has just fixed a credential wants to know immediately
 * whether the fix took, waiting out a poll to find out is the kind of friction that makes
 * people conclude a feature does not work.
 */
app.post(
  "/api/integrations/check",
  integrationsOn,
  admins,
  handler(async (_req, res) => {
    const result = await watcher.check();
    /* `status` is the useful half: every value of it except `dispatched` explains a silence. */
    res.json({ ...result, deliveries: await deliveries().list(50) });
  }),
);

/**
 * The skills in this workspace, with the deterministic ones already run.
 *
 * `check` skills are re-run on every request rather than cached, because they are exact and take
 * milliseconds, a cached result that disagrees with the gate would be worse than no result, and
 * the gate is the thing this page exists to preview.
 *
 * `agent` skills are **not** run here. They cost money and seconds per call, and a page that
 * silently spent both every time someone opened it would be a bad citizen. They report `skipped`
 * until someone presses Run.
 */
app.get(
  "/api/skills",
  skillsOn,
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    const skills = await loadSkills(workspace.root);

    // No `complete`, so agent skills come back as skipped, which is exactly what we want here.
    const gate = await runGate(workspace, { includeDisabled: true });

    res.json({
      skills,
      runs: gate.runs,
      /* So the page can explain why agent skills are inert, rather than just showing them grey. */
      agentsConfigured: Boolean(await agentCompletion()),
      dir: ".strata/skills",
    });
  }),
);

/**
 * Run the skills now, agents included.
 *
 * The authoring loop: write a skill, press Run, see what it catches, without opening a pull
 * request to find out. Deliberately the same `runGate` the propose path calls, so what an author
 * sees here is what the gate will do. A preview that ran a different code path would be worse
 * than no preview.
 */
app.post(
  "/api/skills/run",
  skillsOn,
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { name?: string };
    const complete = await agentCompletion();

    const gate = await runGate(workspace, {
      includeDisabled: true,
      ...(body.name ? { only: body.name } : {}),
      ...(complete ? { complete } : {}),
    });

    res.json({ ...gate, agentsConfigured: Boolean(complete) });
  }),
);

/**
 * Turn a skill on or off.
 *
 * Writes the `enabled:` line in the skill's own file, so the change lands in the repo, appears in
 * Changes, and merges as a reviewable commit. Disabling a governance rule should be at least as
 * visible as writing one, a toggle that silently mutated server state would let someone switch
 * off a control with nothing in the history to show for it.
 *
 * Admin-only for that reason: this is a governance decision, not an editing convenience.
 */
app.put(
  "/api/skills/:name",
  skillsOn,
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const enabled = (req.body as { enabled?: boolean }).enabled === true;

    try {
      const file = await setSkillEnabled(workspace.root, req.params.name ?? "", enabled);
      await refresh();
      res.json({ ok: true, file });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }),
);

/**
 * Sync policy tags from Data Catalog.
 *
 * The clerical job this removes: an operator opens the Google console, finds each policy tag by
 * hand, and pastes its resource path into `strata.config.yaml`, once per category, once per
 * sensitivity level, and again for every environment, because dev and prod have different
 * taxonomy ids for the same logical classification. It is tedious, easy to get subtly wrong, and
 * a wrong path fails at apply time rather than here.
 *
 * Preview and write are separate calls on purpose. This edits the file that decides which columns
 * get column-level security, so seeing the mapping before it lands is what makes running it safe.
 */
app.post(
  "/api/bigquery/taxonomy/preview",
  bigqueryOn,
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { environment?: string; project?: string; location?: string };

    const configured = body.environment
      ? workspace.config.governance?.environments?.[body.environment]
      : undefined;

    const project = body.project?.trim() || configured?.project;
    const location = body.location?.trim() || configured?.location;

    if (!project || !location) {
      res.status(400).json({
        error: "a project and a location are required",
        hint: "policy tags are regional, so a taxonomy is addressed by project *and* location",
      });
      return;
    }

    const auth = await gcpAuth();
    if (!auth) {
      res.status(409).json({
        error: "no Google Cloud credentials are configured",
        hint:
          "set STRATA_GCP_ACCESS_TOKEN for a short-lived token, or store a `gcp.serviceAccount` " +
          "secret containing the service account JSON key",
      });
      return;
    }

    try {
      const listing = await listTaxonomies({
        project,
        location,
        auth,
        /*
          Overridable so an instance behind VPC Service Controls can point at a private endpoint,
          and so the sync can be exercised end to end against a stub without reaching Google.
        */
        ...(process.env.STRATA_GCP_CATALOG_BASE
          ? { base: trimTrailingSlashes(process.env.STRATA_GCP_CATALOG_BASE) }
          : {}),
      });
      res.json({ listing, proposal: proposeMapping(workspace.graph, listing) });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }),
);

/**
 * Write a synced mapping into `strata.config.yaml`.
 *
 * Through `updateConfig`, which edits the YAML document in place, so comments and formatting
 * survive, this file belongs to the customer and their reviewers read it. The result is a diff
 * showing exactly which classification now points at which tag, which is the reviewable artefact
 * the whole design is aiming at.
 */
app.post(
  "/api/bigquery/taxonomy/apply",
  bigqueryOn,
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      environment?: string;
      project?: string;
      location?: string;
      byCategory?: Record<string, string>;
      bySensitivity?: Record<string, string>;
      byName?: Record<string, string>;
    };

    const environment = body.environment?.trim();

    await updateConfig(workspace.root, (doc) => {
      /*
        An environment writes under `governance.environments.<name>`; without one it writes the
        shared `governance.policyTags`. Both shapes are read by `taxonomyFor`, which merges the
        environment over the shared map field by field.
      */
      const path = environment
        ? ["governance", "environments", environment]
        : ["governance", "policyTags"];

      if (environment) {
        if (body.project) doc.setIn([...path, "project"], body.project);
        if (body.location) doc.setIn([...path, "location"], body.location);
        // Stamped so a mapping that has drifted from the catalog is visible rather than assumed.
        doc.setIn([...path, "syncedAt"], new Date().toISOString());
      }

      for (const key of ["byCategory", "bySensitivity", "byName"] as const) {
        const entries = body[key];
        if (!entries) continue;
        for (const [from, to] of Object.entries(entries)) {
          if (to.trim()) doc.setIn([...path, key, from], to);
          else doc.deleteIn([...path, key, from]);
        }
      }
    });

    await refresh();
    res.json({ ok: true, file: "strata.config.yaml", environment: environment ?? null });
  }),
);

/** Which environments this workspace declares, for the UI's picker. */
app.get(
  "/api/bigquery/environments",
  bigqueryOn,
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    const governance = workspace.config.governance;

    res.json({
      environments: environmentNames(governance).map((name) => {
        const entry = governance?.environments?.[name];
        return {
          name,
          project: entry?.project ?? null,
          location: entry?.location ?? null,
          syncedAt: entry?.syncedAt ?? null,
          mapped:
            Object.keys(entry?.byCategory ?? {}).length +
            Object.keys(entry?.bySensitivity ?? {}).length,
        };
      }),
      credentialsConfigured: Boolean(await gcpAuth()),
    });
  }),
);

/**
 * Credentials that belong to a *capability* rather than to an integration provider.
 *
 * Agent skills need a model provider key; the taxonomy sync needs a Google service account.
 * Neither is an integration, so neither had anywhere to live: `secrets().set` was reachable only
 * from the GitHub route and from the integrations form, which writes `<provider>.<field>` for
 * providers in the registry. The result was a pair of credentials the server *read* and nothing
 * could ever *write*, the features worked in development, where an environment variable is easy,
 * and were unreachable in a real deployment.
 *
 * That was the actual failure, and it is worth naming precisely: `STRATA_GCP_ACCESS_TOKEN` holds a
 * token that expires in an hour, so env-only meant restarting the pod hourly to keep the sync
 * working. The service account path is the viable one, and it had no door.
 *
 * **Allow-listed, not arbitrary.** A route that wrote any name the caller supplied could shadow
 * a provider's credential, writing `github.token` or `jira.token` through a door with different
 * validation. The list below is the whole set, and each entry says what it is for so the UI can
 * explain itself.
 */
const CAPABILITY_SECRETS: Record<string, { label: string; hint: string }> = {
  "skills.apiKey": {
    label: "Model provider API key",
    hint: "Runs `kind: agent` skills. Without it agent skills report themselves skipped, never passed.",
  },
  "gcp.serviceAccount": {
    label: "Google service account key (JSON)",
    hint: "Reads Data Catalog taxonomies for the policy tag sync. Needs `datacatalog.taxonomies.list` and `.get`.",
  },

  /*
    Mail, so invitations can send themselves.

    Kept here rather than in a settings file of its own, which buys three things: encrypted at
    rest, per tenant, and every value injectable as `STRATA_SECRET_SMTP_HOST` and friends instead
    of typed into a browser, which is what a Kubernetes operator will want.

    Host and from address are the two that decide whether mail works at all; the rest have
    defensible defaults. Everything here is optional, and an instance with none of it set still
    invites people by link.
  */
  "smtp.host": {
    label: "Mail server host",
    hint: "For example `smtp.sendgrid.net`. A hostname, not an IP. Setting this and the from address turns on emailed invitations.",
  },
  "smtp.port": {
    label: "Mail server port",
    hint: "587 for STARTTLS, 465 for implicit TLS, 25 unencrypted. Defaults to 587.",
  },
  "smtp.username": {
    label: "Mail username",
    hint: "Leave empty for an internal relay that accepts mail from the local network unauthenticated.",
  },
  "smtp.password": {
    label: "Mail password",
    hint: "An app password or API key, never your account password.",
  },
  "smtp.from": {
    label: "Send invitations from",
    hint: "Must be an address your provider lets you send as, or mail is silently dropped or junked.",
  },
  "smtp.from_name": {
    label: "Sender display name",
    hint: "Optional. Shown as the sender in a mail client. Defaults to the address alone.",
  },
  "smtp.security": {
    label: "Mail transport security",
    hint: "`auto` picks TLS on 465 and STARTTLS elsewhere, which is almost always right. `none` is for a relay on localhost.",
  },
};

app.get(
  "/api/secrets/capabilities",
  admins,
  handler(async (_req, res) => {
    const stored = new Map((await secrets().listNames()).map((entry) => [entry.name, entry]));

    res.json({
      items: Object.entries(CAPABILITY_SECRETS).map(([name, meta]) => {
        const found = stored.get(name);
        return {
          name,
          ...meta,
          configured: Boolean(found),
          /* Presence and four characters, never the value, same contract as integrations. */
          ...(found?.hint ? { tail: found.hint } : {}),
          ...(found?.source ? { source: found.source } : {}),
        };
      }),
    });
  }),
);

/** Store or clear one capability credential. An empty value clears it. */
app.put(
  "/api/secrets/capabilities/:name",
  admins,
  handler(async (req, res) => {
    const name = req.params.name ?? "";
    if (!(name in CAPABILITY_SECRETS)) {
      res.status(404).json({
        error: `\`${name}\` is not a capability credential`,
        hint: `known: ${Object.keys(CAPABILITY_SECRETS).join(", ")}`,
      });
      return;
    }

    const value = String((req.body as { value?: unknown }).value ?? "").trim();

    /*
      A service account key is validated before it is stored.

      Storing whatever was pasted means the failure surfaces later as "no credentials
      configured", which sends the operator looking in the wrong place, the value *is* there,
      it is just not a key. Checking the two fields the JWT flow needs costs nothing here.
    */
    if (name === "gcp.serviceAccount" && value) {
      try {
        const parsed = JSON.parse(value) as { client_email?: string; private_key?: string };
        if (!parsed.client_email || !parsed.private_key) {
          res.status(422).json({
            error: "that JSON has no `client_email` and `private_key`",
            hint: "paste the whole service account key file, not a fragment of it",
          });
          return;
        }
      } catch {
        res.status(422).json({ error: "that is not valid JSON" });
        return;
      }
    }

    await secrets().set(name, value || undefined);
    res.json({ ok: true, name, configured: Boolean(value) });
  }),
);

/**
 * Everything the tool noticed without being asked.
 *
 * Cost advice and classification suggestions are different analyses, but they answer the same
 * shape of question, "what would a careful reviewer point at?", and both are advisory, both are
 * ranked, and neither changes anything on its own. Served together so the UI has one place to put
 * them rather than a page each.
 *
 * A GET because it is a pure read of the current model: no side effects, and cheap enough to
 * recompute per request rather than cache. A cached answer that disagreed with the model would be
 * worse than none.
 */
app.get(
  "/api/insights",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const model = typeof req.query.model === "string" ? req.query.model : undefined;

    const cost = advise(workspace.graph, model);
    const classifications = suggestClassifications(workspace.graph, model);

    res.json({
      cost,
      costSummary: adviceSummary(cost),
      classifications,
      coverage: classificationCoverage(workspace.graph, model),
    });
  }),
);

/**
 * The governance report: coverage, the classified-field register, and what is left to decide.
 *
 * `readers`, not `admins`. Governance is a question about the model, not about the instance, and
 * a compliance reviewer is exactly the person most likely to hold a viewer account. Gating it to
 * administrators would mean the one report written for them is the one they cannot open.
 *
 * `?format=markdown` returns the same report as a file, because a compliance officer wants
 * something to attach to a ticket rather than a screenshot of a page.
 */
app.get(
  "/api/governance",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const report = governanceReport(workspace.graph);

    if (req.query.format === "markdown") {
      const name = workspace.config.name;
      res
        .type("text/markdown; charset=utf-8")
        // `attachment`, so a browser downloads it instead of rendering it as text.
        .setHeader("content-disposition", `attachment; filename="governance-${safeFilename(name)}.md"`);
      res.send(renderGovernanceMarkdown(report, name));
      return;
    }

    res.json(report);
  }),
);

/**
 * A workspace name reduced to something safe in a `filename=` parameter.
 *
 * The name comes from `strata.config.yaml`, which arrives by pull request, so it is untrusted
 * input reaching a response header. A quote or a newline there would let the caller write their
 * own `content-disposition` directives, and a path separator would suggest a directory to the
 * client. Word characters only closes all of it.
 */
function safeFilename(name: string): string {
  return name.replace(/[^\w.-]/g, "-").slice(0, 60) || "workspace";
}

/**
 * Accept classification suggestions, writing them into the model.
 *
 * Routed through `updateMember`, the same path the data dictionary uses, rather than writing YAML
 * directly, so a suggestion lands exactly as a human edit would, with the same serialisation and
 * the same file layout, and shows up in Changes as a reviewable diff.
 *
 * Accepts a list rather than one at a time because the whole value is clearing forty obvious
 * columns in one go; doing that one request at a time would be forty commits' worth of churn.
 * Each is applied independently, and a failure on one is reported without abandoning the rest, * a single bad path should not lose the other thirty-nine.
 */
app.post(
  "/api/insights/classifications/accept",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      accept?: { objectId: string; path: string; classification?: unknown }[];
    };

    const requested = body.accept ?? [];
    if (requested.length === 0) {
      res.status(400).json({ error: "nothing to accept" });
      return;
    }

    /*
      Suggestions are recomputed here rather than trusted from the request.

      The client sends which column it accepted, not what to write. Taking the classification from
      the request would let a stale page, or anything else posting to this route, apply a
      classification the analysis never proposed, and classification drives real column-level
      security.
    */
    const current = new Map(
      suggestClassifications(workspace.graph).map((entry) => [
        `${entry.objectId}\u0000${entry.path}`,
        entry,
      ]),
    );

    const applied: { objectId: string; path: string }[] = [];
    const failed: { objectId: string; path: string; error: string }[] = [];

    /*
      The workspace is reloaded before every write, not captured once.

      `updateMember` clones the object out of the workspace it is handed, applies one patch, and
      writes the whole object back. Against a workspace captured before the loop, the second
      write starts from the *original* object and silently discards the first, while the route
      still reports both as applied.

      Observed, not theorised: accepting two suggestions on one table wrote only the second, and
      the response said `applied: 2`. Loading is milliseconds; a governance annotation lost while
      reporting success is not recoverable by anything except somebody noticing.
    */
    for (const item of requested) {
      const fresh = await getWorkspace(true);
      const suggestion = current.get(`${item.objectId}\u0000${item.path}`);
      if (!suggestion) {
        failed.push({
          objectId: item.objectId,
          path: item.path,
          error: "no longer suggested, the model changed since the page loaded",
        });
        continue;
      }

      try {
        await updateMember(fresh, suggestion.objectId, {
          path: suggestion.path,
          classification: {
            ...(suggestion.suggested.sensitivity
              ? { sensitivity: suggestion.suggested.sensitivity }
              : {}),
            ...(suggestion.suggested.categories?.length
              ? { categories: suggestion.suggested.categories }
              : {}),
            ...(suggestion.suggested.subjectIdentifier ? { subjectIdentifier: true } : {}),
          },
        });
        applied.push({ objectId: suggestion.objectId, path: suggestion.path });
      } catch (error) {
        failed.push({
          objectId: item.objectId,
          path: item.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await refresh();
    res.json({ applied: applied.length, failed, appliedItems: applied });
  }),
);

app.get(
  "/api/search",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const limit = Number(req.query.limit);
    res.json(search(workspace.graph, query, Number.isFinite(limit) && limit > 0 ? limit : undefined));
  }),
);

app.get(
  "/api/diagnostics",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    res.json(diagnosticsView(allDiagnostics(workspace)));
  }),
);

/**
 * Apply an autofixable diagnostic.
 *
 * Deliberately routed through the same `updateObject` / `updateMember` the editor uses
 * rather than writing the value at the path directly. Those two already know things a
 * blind write does not: that renaming a column has to update the primary-key list, and
 * that renaming an object has to record its old name so references elsewhere keep
 * resolving. A "quick fix" that skipped them would be the fastest way to break a model.
 *
 * The client sends the fix it was shown, and the server does not trust it: the diagnostic
 * is recomputed and the fix has to still be present and identical. Otherwise a fix computed
 * against a model two edits ago could rename something nobody is looking at any more.
 */
app.post(
  "/api/diagnostics/fix",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { objectId?: string; code?: string; path?: string; value?: unknown };

    if (!body.objectId || !body.path) {
      res.status(400).json({ error: "objectId and path are required" });
      return;
    }

    const current = allDiagnostics(workspace).find(
      (item) =>
        item.objectId === body.objectId &&
        item.code === body.code &&
        item.fix?.path === body.path &&
        item.fix?.value === body.value,
    );

    if (!current?.fix) {
      res.status(409).json({
        error:
          "that fix no longer applies, the model has changed since it was suggested. Reload and try again.",
      });
      return;
    }

    const value = String(current.fix.value);
    const path = current.fix.path;

    // `name` is the object itself; anything else addresses a member.
    if (path === "name") {
      const object = workspace.graph.get(body.objectId)?.object;
      if (!object) {
        res.status(404).json({ error: `no object with id \`${body.objectId}\`` });
        return;
      }
      const result = await updateObject(workspace, body.objectId, { ...object, name: value });
      const reloaded = await refresh();
      res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
      return;
    }

    /*
      Member paths arrive in two shapes because the lint reports them differently for the
      two tiers: `columns.address.postcode` is dotted, `attributes[2].name` is indexed.
      `updateMember` addresses members by name, so the index has to be resolved first.
    */
    let memberPath: string | undefined;
    if (path.startsWith("columns.")) {
      memberPath = path.slice("columns.".length);
    } else {
      const indexed = /^attributes\[(\d+)\]\.name$/.exec(path);
      if (indexed) {
        const object = workspace.graph.get(body.objectId)?.object;
        const attribute =
          object?.kind === "entity" ? object.attributes[Number(indexed[1])] : undefined;
        memberPath = attribute?.name;
      }
    }

    if (!memberPath) {
      res.status(400).json({ error: `cannot apply a fix at \`${path}\`` });
      return;
    }

    const result = await updateMember(workspace, body.objectId, { path: memberPath, name: value });
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.get(
  "/api/objects",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const search = typeof req.query.q === "string" ? req.query.q.toLowerCase() : undefined;

    res.json({
      items: workspace.graph
        .all()
        .filter((entry) => !kind || entry.object.kind === kind)
        .filter((entry) => !search || entry.object.name.toLowerCase().includes(search))
        .map((entry) => ({
          id: entry.object.id,
          kind: entry.object.kind,
          name: entry.object.name,
          model: entry.object.model ?? null,
          file: entry.file ?? null,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    });
  }),
);

app.get(
  "/api/objects/:id",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const id = req.params.id ?? "";
    const detail = objectDetail(workspace, id);
    if (!detail) {
      res.status(404).json({ error: `no object with id \`${id}\`` });
      return;
    }
    res.json({
      ...detail,
      revision: revisionOf(detail.object),
      yaml: serializeObject(detail.object),
    });
  }),
);

app.use(writeRoutes);
app.use(settingsRoutes);
// ---------------------------------------------------------------- git

app.get(
  "/api/git/status",
  readers,
  handler(async (_req, res) => {
    /**
     * Read git from the configured path, not from the loaded workspace.
     *
     * `getWorkspace()` parses every model file, and it throws when there is no config, * which made a fresh instance answer this with a 500 before the setup flow had a
     * chance to create anything. Whether a directory is a git repository has nothing to
     * do with whether it parses as a workspace, and the client treats a failure here as
     * "not a repo", so the error was both noisy in the log and quietly wrong.
     *
     * `workspaceRoot()` resolves to the same path `loadWorkspace` would have used, so nothing changes
     * for a healthy instance.
     */
    const result = await gitState(workspaceRoot());
    res.json({
      ...result,
      canOpenPullRequest: Boolean(await secrets().githubToken()) && Boolean(result.github),
    });
  }),
);

/** Branches available as a pull request base, split by whether the remote has them. */
/**
 * Turn the workspace into a git repository, after the fact.
 *
 * The gap this closes: `git init` was offered once, as a checkbox during first-run setup, and
 * nowhere else. Untick it, or have it fail, which happens when the volume is owned by another
 * uid, and the workspace was permanently un-versioned with no way to fix it from the app.
 * `/api/workspace/init` refuses a second time (a workspace already exists) and setting a remote
 * on a non-repo fails with a raw git error. Recovery meant shell access to the container, which
 * on Kubernetes is a `kubectl exec` and for most admins is a wall.
 *
 * Admin-only, and refuses when the directory is already a repository rather than running `git
 * init` again. `git init` on an existing repo is technically harmless, but reporting success
 * would hide the far more likely reality, that the operator is looking at the wrong directory.
 */
app.post(
  "/api/git/init",
  admins,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    const before = await status(workspace.root);

    if (before.isRepo) {
      res.status(409).json({
        error: "this workspace is already a git repository",
        ...(before.branch ? { branch: before.branch } : {}),
      });
      return;
    }

    try {
      await initRepo(workspace.root);
    } catch (error) {
      /*
        Reported as 422 rather than 500: the overwhelmingly common cause is the environment
        rather than a bug, a read-only mount, or a volume owned by a uid the container is not.
        A 500 sends the operator to the logs; this sends them to the mount.
      */
      res.status(422).json({
        error: error instanceof Error ? error.message : String(error),
        hint: "check the workspace volume is writable by the container's user",
      });
      return;
    }

    await refresh();
    res.json({ ok: true, ...(await gitState(workspace.root)) });
  }),
);

app.get(
  "/api/git/branches",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    const state = await gitState(workspace.root);
    res.json(await listBranches(workspace.root, state.defaultBranch));
  }),
);

app.get(
  "/api/git/diff",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const path = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json({ diff: await diff(workspace.root, path) });
  }),
);

app.post(
  "/api/git/propose",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      branch?: string;
      commitMessage?: string;
      title?: string;
      body?: string;
      base?: string;
      paths?: string[];
      allowInvalid?: boolean;
      publishBase?: boolean;
    };

    const branch = (body.branch ?? "").trim();
    if (!branch) {
      res.status(400).json({ error: "a branch name is required" });
      return;
    }

    /**
     * Writing an invalid model is allowed, a rename legitimately breaks references
     * until the follow-up edit lands, and blocking that would make the editor
     * unusable. Proposing one for review is different: it wastes a reviewer's time and
     * the CI gate will reject it anyway. So warn here, and require the caller to say
     * they meant it.
     */
    const errors = allDiagnostics(workspace).filter((d) => d.severity === "error");
    if (errors.length > 0 && !body.allowInvalid) {
      /*
        Announce the refusal, then refuse.

        A validation failure is exactly the event a team wants in their channel, it is the
        moment someone is blocked, and reporting it only to the person already looking at the
        error message helps nobody else.
      */
      fireAndForget(
        await buildChangeSummary(workspace, {
          event: "validationFailed",
          branch,
          errors: errors.slice(0, 20).map((error) => ({
            code: error.code,
            message: error.message,
            ...(error.file ? { file: error.file } : {}),
          })),
        }),
      );

      res.status(409).json({
        error: `the model has ${errors.length} validation error(s); \`strata check\` would fail on this branch`,
        validationErrors: errors.slice(0, 20),
        hint: "fix them, or send allowInvalid to propose anyway",
      });
      return;
    }

    /**
     * The skills gate.
     *
     * This is the point of the skills feature. A rule that only runs when somebody remembers to
     * press a button enforces nothing, it is a linter you have to ask permission from. Running
     * it here, on the path every change takes to review, is what turns a team's conventions into
     * something the tool actually holds the line on.
     *
     * Two deliberate choices:
     *
     * **`blocking` refuses, `advisory` annotates.** Set per skill, because a team adopting this
     * against an existing estate needs to turn rules on one at a time; an all-or-nothing gate is
     * switched off wholesale on the first false positive.
     *
     * **`allowInvalid` does not override it.** That escape hatch exists for validation errors,
     * which are often a transient consequence of a rename mid-edit. A skill is a rule the team
     * wrote down on purpose, and letting the same checkbox wave it through would make it advice
     * with extra steps. Someone who genuinely needs to bypass one edits the skill, in the repo,
     * as a reviewable commit.
     */
    const complete = await agentCompletion();
    const gate = await runGate(workspace, (complete ? { complete } : {}));

    if (gate.blocking.length > 0) {
      res.status(409).json({
        error: `${gate.blocking.length} finding(s) from blocking skills`,
        skillFindings: gate.blocking,
        skillRuns: gate.runs,
        hint: "fix them, or change the skill's severity to `advisory` in .strata/skills",
      });
      return;
    }

    /*
      The caller's own token in hosted mode, the instance's when self-hosted.

      This is the line that decides whether Propose works at all in the managed cloud, and it
      previously could not: a tenant's secret store is empty, so the push had no credential.
      It is also the authorization boundary. The token belongs to the person who signed in, so
      GitHub refuses the push for a repository they may only read, and the answer comes from the
      place that actually owns the permission rather than from this process's opinion of it.
    */
    const resolvedToken = await githubTokenFor(req);
    const title = (body.title ?? "").trim() || `Model changes on ${branch}`;

    // Attribute the commit to the signed-in user when we know who they are.
    const author = req.user?.username
      ? { name: req.user.displayName, email: `${req.user.username}@strata.local` }
      : GIT_AUTHOR;

    // Auth off means one anonymous local user, and `| local` on every title would be
    // noise that identifies nobody.
    const stampWith = auth.disabled ? undefined : req.user?.username;

    // Resolve the base here rather than letting `propose` fall back to the literal
    // `main`, which is wrong for any repo whose default is named something else.
    const base =
      body.base?.trim() || (await gitState(workspace.root, resolvedToken)).defaultBranch;

    const result = await propose({
      cwd: workspace.root,
      branch,
      // The commit message stays unstamped: `--author` already carries identity there,
      // and `git log --oneline` should read as a changelog, not an attribution list.
      commitMessage: (body.commitMessage ?? "").trim() || title,
      prTitle: attributeTitle(title, stampWith),
      prBody: proposeBody(body.body ?? "", req.user),
      ...(base ? { base } : {}),
      ...(body.publishBase ? { publishBase: true } : {}),
      ...(body.paths?.length ? { paths: body.paths } : {}),
      ...(author ? { author } : {}),
      ...(resolvedToken ? { githubToken: resolvedToken } : {}),
    });

    const reloaded = await refresh();

    /*
      The proposal event describes the branch against its base, not the working tree.

      By this point the commit exists, so the range is well defined and describes exactly what a
      reviewer is being asked to approve.
    */
    if (base) {
      fireAndForget(
        await buildChangeSummary(reloaded, {
          event: "proposed",
          range: { from: base, to: branch },
          branch,
          subject: title,
          /* Derived from the URL: `propose` returns the link, not the number. */
          ...(prNumber(result.pullRequestUrl) ? { pullRequest: prNumber(result.pullRequestUrl)! } : {}),
          ...(result.pullRequestUrl ? { pullRequestUrl: result.pullRequestUrl } : {}),
          ...(req.user?.displayName ? { author: req.user.displayName } : {}),
        }),
      );
    }

    /*
      Advisory findings ride along with the successful proposal.

      Returned rather than discarded because "it went through, and here is what the rules noticed"
      is the whole value of an advisory rule, a finding nobody ever sees is not advice, it is a
      log line.
    */
    res.json({
      ...result,
      ...(gate.advisory.length > 0 ? { skillFindings: gate.advisory } : {}),
      skillRuns: gate.runs,
    });
  }),
);

/**
 * Point the workspace at a GitHub repository.
 *
 * Admin-only, because it decides where this instance's work ends up, a mistake here
 * sends the organisation's data models to someone else's repository.
 *
 * The URL is verified before it is saved. Storing an unreachable remote would move the
 * failure to the next propose, which is after a commit has already been made, and the
 * error there reads as "push failed" rather than "that URL is wrong".
 */
app.post(
  "/api/git/remote",
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const url = String((req.body as { url?: string }).url ?? "");

    const validated = validateRemoteUrl(url);
    if (!validated.ok) {
      res.status(422).json({ error: validated.error });
      return;
    }

    /*
      Where the remote points, not just what it looks like.

      `validateRemoteUrl` checks the scheme and that the path has an owner and a repo. It says
      nothing about the host, so `https://169.254.169.254/a/b.git` passed. Setting that remote and
      pushing makes the server open a connection from inside its own network, and git puts the
      server's response text into the error it hands back -- which turns a blind request into a
      readable one. Same class as the integration URLs, same guard, and it throws a
      `BlockedUrlError` the route wrapper turns into a 422 with the reason.
    */
    await assertSafeUrl(validated.url, { protocols: ["https:"] });

    const previous = (await status(workspace.root)).remoteUrl;
    await setRemote(workspace.root, validated.url);

    const reachable = await checkRemoteAccess(workspace.root, await secrets().githubToken());
    if (!reachable.ok) {
      // Put it back rather than leaving the workspace pointing somewhere unusable.
      if (previous) await setRemote(workspace.root, previous);
      else await removeRemote(workspace.root);
      res.status(422).json({ error: reachable.error });
      return;
    }

    res.json({ ...(await status(workspace.root)), verified: true });
  }),
);

app.post(
  "/api/git/discard",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const paths = (req.body as { paths?: string[] }).paths ?? [];
    if (paths.length === 0) {
      res.status(400).json({ error: "no paths given" });
      return;
    }
    await discard(workspace.root, paths);
    await refresh();
    res.json({ discarded: paths });
  }),
);

app.use(compareRoutes);
app.use(importRoutes);
app.use(generationRoutes);
// ---------------------------------------------------------------- secrets

app.get(
  "/api/secrets/github",
  admins,
  handler(async (_req, res) => {
    res.json(await secrets().status());
  }),
);

app.put(
  "/api/secrets/github",
  admins,
  handler(async (req, res) => {
    const status = await secrets().status();
    if (!status.editable) {
      res.status(409).json({
        error: `the token comes from ${status.source === "file" ? "a mounted secret file" : "an environment variable"}; change it there`,
      });
      return;
    }
    const token = String((req.body as { token?: unknown }).token ?? "").trim();
    await secrets().setGithubToken(token || undefined);
    res.json(await secrets().status());
  }),
);


/**
 * Take the whole workspace away as one file.
 *
 * **The missing exit.** A hosted trial with no export is a trial people abandon: an hour of
 * modelling, and the only way out is copying YAML out of a dialog one file at a time. It matters
 * for self-hosting too, as the fastest honest backup of a workspace that is not yet a git repo.
 *
 * `readers`, not `editors`. Exporting reads exactly what a viewer can already read one file at a
 * time through `/api/files/content`, so requiring more would be theatre -- and a trial visitor is
 * whatever role the deployment gives anonymous sessions.
 */
app.get(
  "/api/workspace/export",
  readers,
  handler(async (req, res) => {
    if (!workspaceExists()) {
      res.status(404).json({ error: "there is no workspace to export yet" });
      return;
    }

    /*
      The archive's top-level directory is named for the workspace, with a date.

      Extracting `strata-export.tgz` and getting `my-models-2026-08-29/` back tells you what you
      have six months later. Getting a pile of loose YAML into your home directory does not.
    */
    let name = "workspace";
    try {
      name = (await getWorkspace()).config.name || name;
    } catch {
      // An unparseable workspace is still worth exporting -- arguably more so, since the export
      // is how somebody gets the broken files somewhere they can fix them.
    }
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) || "workspace";
    const stamp = new Date().toISOString().slice(0, 10);
    const prefix = `${safeName}-${stamp}`;

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${prefix}.tgz"`);

    try {
      const result = await writeArchive(workspaceRoot(), prefix, res);
      log("info", "workspace exported", {
        requestId: req.context?.id,
        files: result.files,
        bytes: result.bytes,
      });
    } catch (error) {
      /*
        The headers are already sent by the time gzip fails, so there is no status left to change.
        Destroying the socket is the only honest signal: a truncated archive that looks complete
        is worse than a download that visibly breaks.
      */
      log("error", "export failed", {
        requestId: req.context?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.destroy();
    }
  }),
);

/**
 * Who did the privileged things.
 *
 * The gap this closes: model changes are auditable by design, because they are commits. Instance
 * changes were not auditable at all. An admin could disable a blocking governance skill and leave
 * no trace anywhere, and the next pull request would merge without a control everybody believed
 * was running.
 */
app.get(
  "/api/audit",
  admins,
  handler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const action = typeof req.query.action === "string" ? (req.query.action as AuditAction) : undefined;
    const actor = typeof req.query.actor === "string" ? req.query.actor : undefined;

    const entries = await audit().list(limit, {
      ...(action ? { action } : {}),
      ...(actor ? { actor } : {}),
    });

    res.json({ entries, count: entries.length });
  }),
);

/**
 * Liveness. Unauthenticated by necessity, so it says as little as possible.
 *
 * It used to return the absolute workspace path. That is not a breach on its own, but it is a
 * free first step: an unauthenticated scanner confirms this is a strata instance and learns its
 * mount point before trying anything else. A liveness probe needs to answer "is the process
 * answering", and that is all this does now.
 */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * The detail that used to be on the liveness route, behind the role it always needed.
 *
 * Worth having rather than simply deleting: a readiness probe that only checks the process is up
 * will happily route traffic to an instance whose workspace failed to clone, and a post-deploy
 * check wants to compare the model count against what it was before. Both need real numbers, and
 * both are operator activities, so they sit behind an operator's role.
 */
app.get(
  "/api/health/detail",
  admins,
  handler(async (_req, res) => {
    const git = await gitState(workspaceRoot()).catch(() => undefined);

    let objectCount: number | undefined;
    let modelCount: number | undefined;
    try {
      const workspace = await getWorkspace();
      objectCount = workspace.graph.all().length;
      modelCount = workspace.graph.models().length;
    } catch {
      // A workspace that will not parse is exactly what this route exists to report, so the
      // failure is data rather than an error.
    }

    res.json({
      ok: true,
      version: process.env.STRATA_VERSION ?? null,
      /*
        Platform-provided build identifiers, so this works without configuration.

        Render, Fly and Vercel each set their own variable on every deploy. Reading them directly
        means a post-deploy check can prove which build is live without an operator having wired
        anything up, which is exactly when you most want to know.
      */
      commit:
        process.env.STRATA_COMMIT ??
        process.env.RENDER_GIT_COMMIT ??
        process.env.FLY_MACHINE_VERSION ??
        null,
      workspace: workspaceRoot(),
      workspaceLoads: objectCount !== undefined,
      objectCount: objectCount ?? null,
      modelCount: modelCount ?? null,
      git: git ? { isRepo: git.isRepo, branch: git.branch ?? null } : null,
      auth: { enabled: !auth.disabled, needsSetup: await auth.needsSetup() },
      features: FEATURES,
      multiTenant: Boolean(TENANT_DIR),
      trackedTenants: stores.trackedTenants,
      throttledKeys: loginThrottle.size,
      watcher: { intervalMs: WATCH_INTERVAL_MS, running: WATCH_INTERVAL_MS > 0 },
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

// ------------------------------------------------- serve the built UI, if present

const webDist = process.env.STRATA_WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // Single-page app: anything not under /api falls through to index.html.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, "index.html"));
  });
  process.stdout.write(`serving UI from ${webDist}\n`);
}

/*
  Last in the chain, and it has to be.

  `tenantMiddleware` hands failures to `next(error)`, and with nothing registered here those fell
  through to Express's built-in handler: an HTML stack trace in development, a bare 500 otherwise.
  Either way a different shape from the JSON body every other route returns, so a client that
  parses one and receives the other shows the user nothing useful.
*/
app.use(errorHandler());

/**
 * Fetch the model repo, then listen.
 *
 * The clone runs *before* the first request can arrive, because the alternative is a race:
 * a health check or an eager browser hitting `/api/workspace` mid-clone would read a
 * half-populated directory and cache a workspace missing most of its files.
 *
 * A clone failure is logged but does not stop the server. On a platform deployment a
 * process that exits non-zero becomes a crash loop, and a crash loop gives the operator no
 * UI to read the error in, whereas the app already degrades to "Cannot read the model
 * repo" with the reason on screen, which is the more useful failure.
 */
async function start(): Promise<void> {
  /*
    Hosted mode cannot run with authorisation switched off.

    `requireRole` short-circuits to `next()` when `STRATA_AUTH=off`, which is correct for a
    single-user local instance and correct for the anonymous trial, where everyone is alone in a
    scratch directory and there is nothing of anybody else's to reach.

    In hosted mode it is a hole. Roles there come from the caller's GitHub permission on the
    repository, so with the checks disabled somebody with **read-only** access signs in and gets
    write access to a repository they were deliberately not given write access to. Nothing in the
    UI would look wrong, and the first sign of it would be a commit nobody could account for.

    Fatal rather than a warning. This is the one combination where carrying on means quietly
    handing strangers more access than their own organisation granted them, and a log line at boot
    is not something anybody reads in time.
  */
  const refusal = startupRefusal();
  if (refusal) {
    log("error", `refusing to start: ${refusal}`, {});
    process.exit(1);
  }

  const cloudWarning = cloudConfigWarning();
  if (cloudWarning) log("error", cloudWarning, {});

  /*
    Seed the administrator before the listener opens.

    Order matters. Doing this after `app.listen` would leave a window, however short, in which
    `/api/auth/setup` is open on a reachable port -- which is the exact hole this closes.
  */
  try {
    const seeded = await auth.seedAdmin({
      username: process.env.STRATA_ADMIN_USERNAME,
      password: process.env.STRATA_ADMIN_PASSWORD,
      passwordHash: process.env.STRATA_ADMIN_PASSWORD_HASH,
    });
    if (seeded.action === "created") {
      log("info", "seeded the administrator from configuration", {
        username: process.env.STRATA_ADMIN_USERNAME,
      });
    }
  } catch (error) {
    /*
      A malformed seed is fatal, deliberately.

      Every other startup failure here degrades to a usable UI showing the problem. This one
      cannot: carrying on means booting with no admin and an open setup route, which is the
      failure the seed exists to prevent. Refusing to start is the safe direction.
    */
    log("error", "admin seed rejected", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (MODEL_REPO || !existsSync(join(WORKSPACE, "strata.config.yaml"))) {
    try {
      const result = await bootstrapWorkspace({
        workspace: WORKSPACE,
        repo: MODEL_REPO,
        branch: MODEL_BRANCH,
        // Resolved the same way as every other git operation: mounted file, then env var,
        // then whatever an admin pasted into Settings.
        token: await secrets().githubToken(),
        ...(GIT_AUTHOR ? { author: GIT_AUTHOR } : {}),
      });
      if (result.action === "skipped") {
        process.stdout.write(`workspace bootstrap skipped: ${result.reason}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `workspace bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /*
    Merge detection starts with the server.

    Gated on the interval so an operator can switch it off entirely with
    `STRATA_WATCH_INTERVAL_MS=0`, a shared instance behind a rate-limited enterprise remote has a
    real reason not to fetch every minute, and the alternative would be leaving the integration
    enabled and wondering why the remote complains.
  */
  if (WATCH_INTERVAL_MS > 0) watcher.start();

  /*
    Actually expire trial workspaces.

    `TenantStore.expire` was written, tested and never called, so the TTL was a value in a config
    table that did nothing: every visitor's scratch workspace lived until the disk filled. On a
    free hosting tier a full disk is an outage, and the models it loses are not backed by a repo.

    Sweeping hourly rather than on a request, because expiry should not depend on somebody
    happening to visit -- an instance nobody has opened for a week is exactly the one holding the
    most stale workspaces.
  */
  if (TENANT_DIR && TENANT_TTL_MS > 0) {
    const sweep = async (): Promise<void> => {
      try {
        const tenants = await tenantsReady();
        const removed = (await tenants?.expire()) ?? [];
        for (const id of removed) await stores.dispose(id);
        if (removed.length > 0) log("info", "expired trial workspaces", { count: removed.length });
      } catch (error) {
        log("warn", "tenant sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), 60 * 60_000);
    // A bare interval keeps the process alive through an otherwise clean shutdown.
    timer.unref?.();
  }

  const server = app.listen(PORT, () => {
    process.stdout.write(`strata server listening on http://localhost:${PORT}\n`);
    process.stdout.write(`workspace: ${workspaceRoot()}\n`);
    if (MODEL_REPO) process.stdout.write(`model repo: ${stripCredentials(MODEL_REPO)}\n`);
    if (AUTH_DISABLED) {
      process.stdout.write(
        "warning: authentication is DISABLED, anyone who can reach this port can edit\n",
      );
    } else {
      process.stdout.write(`auth data: ${DATA_DIR}\n`);
      void auth.needsSetup().then((needed) => {
        if (!needed) return;

        process.stdout.write("first run: open the UI to create the administrator account\n");
        /*
          Say plainly what this state means.

          An open setup route is correct on a laptop and dangerous on a public address, and the
          difference is invisible from inside the process. Naming it here, every time, is what
          stops an operator discovering it the hard way -- and points at the fix in the same
          breath, because a warning with no remedy just gets scrolled past.
        */
        process.stdout.write(
          "warning: /api/auth/setup is OPEN until that account exists. " +
            "Anyone who can reach this port right now can become the administrator. " +
            "Set STRATA_ADMIN_USERNAME and STRATA_ADMIN_PASSWORD_HASH to close it at boot.\n",
        );
      });
    }

    if (TENANT_DIR && !CLOUD_ENABLED && (FEATURES.integrations || FEATURES.bigquery)) {
      /*
        An anonymous trial whose deployment list still permits outbound features.

        Narrower than it used to be, in both directions, because `featuresFor` changed what this
        can and cannot be warning about.

        It no longer fires for hosted mode. A cloud deployment *should* permit these: its callers
        are signed in, GitHub has confirmed their access to a repository, and the features run on
        credentials they supplied themselves. Warning there would have told the operator to break
        the product to fix a risk that mode does not carry, which is worse than saying nothing.

        And it is now advice rather than the last line of defence. An anonymous caller is refused
        these features by `featuresFor` whatever this list says, so a misconfigured trial is
        already contained. What is left is worth one line anyway: the list is still the ceiling
        for anyone who does sign in, and an operator who did not mean to raise it should know.
      */
      process.stdout.write(
        "note: multi-tenant mode is on and STRATA_FEATURES still permits outbound features. " +
          "Anonymous visitors are refused them regardless; this only affects signed-in callers.\n",
      );
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      watcher.stop();
      server.close(() => process.exit(0));
    });
  }
}

/**
 * The express app, exported so it can be tested without a listener.
 *
 * **This is what makes the route layer testable at all.** Until now `index.ts` bound a port and
 * cloned a repository the moment it was imported, so no test could touch it: 3,551 lines
 * containing every authorization decision and every tenant resolution had no coverage, which is
 * exactly how three routes came to read the operator's workspace regardless of who was asking.
 *
 * Nothing else changes for a real deployment: `node dist/index.js` is still the entry point and
 * still starts the same way.
 */
/**
 * Configuration combinations the server refuses to run with, as a string rather than an exit.
 *
 * Separated from `start` so the rule can be tested. Asserting on a `process.exit(1)` means either
 * stubbing it, which proves the stub works, or booting a subprocess, which is slow enough that
 * nobody adds the second case. A pure function gets tested properly.
 */
/**
 * Hosted sign-in configured, but not completely.
 *
 * **Silence here cost real time.** Cloud mode needs four variables and one of them,
 * `STRATA_TENANT_DIR`, is not named like a cloud setting at all, so it is the one people miss.
 * Miss it and the server boots happily into self-hosted mode: no GitHub button, a local sign-in
 * form instead, and nothing anywhere saying why. The operator is left staring at a screen that
 * looks like the wrong build.
 *
 * A warning rather than a refusal. Refusing would turn a half-finished migration into a dead
 * service, and the fallback is a working self-hosted instance rather than a broken one. But it
 * says exactly which variable is absent, because "cloud mode is off" without a name is the same
 * silence in a longer sentence.
 */
export function cloudConfigWarning(): string | undefined {
  const required: Record<string, string | undefined> = {
    STRATA_CLOUD_CLIENT_ID: CLOUD_CLIENT_ID,
    STRATA_CLOUD_CLIENT_SECRET: CLOUD_CLIENT_SECRET,
    STRATA_CLOUD_BASE_URL: CLOUD_BASE_URL,
    // Not optional, and not obviously part of this set. Hosted mode gives each customer their own
    // workspace, and that is what tenant directories are.
    STRATA_TENANT_DIR: TENANT_DIR,
  };

  /*
    The trigger is a `STRATA_CLOUD_*` variable, not any of the four.

    `STRATA_TENANT_DIR` on its own is the anonymous trial, which is a deliberate and complete
    configuration in its own right. Treating it as half-finished hosted sign-in would warn on
    every trial deployment, and a warning that fires when nothing is wrong is one people learn to
    scroll past.
  */
  const intendsCloud = Boolean(CLOUD_CLIENT_ID || CLOUD_CLIENT_SECRET || CLOUD_BASE_URL);
  if (!intendsCloud) return undefined;

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length === 0) return undefined;

  return (
    `hosted sign-in is OFF because ${missing.join(" and ")} ` +
    `${missing.length === 1 ? "is" : "are"} not set. The other cloud variables are configured, so ` +
    `this is almost certainly not what you intended: visitors will be asked for a local account ` +
    `instead of being sent to GitHub.`
  );
}

export function startupRefusal(): string | undefined {
  if (CLOUD_ENABLED && auth.disabled) {
    return (
      "hosted sign-in is configured but STRATA_AUTH is off. Hosted mode takes each person's " +
      "role from their GitHub permission on the repository, and STRATA_AUTH=off disables every " +
      "role check, so read-only collaborators would get write access. Set STRATA_AUTH=on, or " +
      "unset the STRATA_CLOUD_* variables."
    );
  }
  return undefined;
}

export { app, start };

/**
 * Start only when this file is what was run.
 *
 * Comparing the module URL against `argv[1]` rather than reading a `STRATA_TEST` flag, because a
 * flag is one forgotten environment variable away from a production instance that boots and
 * never listens. Under vitest, `argv[1]` is the test runner, so the comparison is false and the
 * server stays inert.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) void start();
