import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import {
  compareModels,
  isKind,
  lintNames,
  parseObject,
  qualifiedTableName,
  validate,
  OBJECT_KINDS,
  type Diagnostic,
  type ObjectKind,
  type Table,
} from "@strata/metamodel";
import {
  CONFIG_FILENAME,
  LAYOUT_PRESETS,
  initWorkspace,
  loadWorkspace,
  planWrites,
  saveWorkspace,
  serializeObject,
  setLayoutPreset,
  type LoadedWorkspace,
  updateConfig,
} from "@strata/storage";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  addMember,
  createObject,
  createRelationship,
  removeForeignKey,
  removeMember,
  removeObject,
  revisionOf,
  saveLayout,
  scaffold,
  toggleKey,
  updateMember,
  updateObject,
  updateObjectFromYaml,
  type MemberPatch,
} from "./edit.js";
import {
  GitError,
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
  history,
  status,
  type GitStatus,
} from "./git.js";
import { stripCredentials, validateRemoteUrl } from "./gitcreds.js";
import { bootstrapWorkspace } from "./bootstrap.js";
import { MailError, invitationMessage, looksLikeEmail, sendMail, type SmtpConfig } from "./mailer.js";
import { renameNamespace, updateModelSettings } from "./refactor.js";
import { LockedError, Presence } from "./presence.js";
import {
  AuthError,
  AuthStore,
  ROLES,
  attachUser,
  clearSessionCookie,
  hasRole,
  requireRole,
  setSessionCookie,
  toPublicUser,
  type AuthedRequest,
  type GuardHandler,
  type Role,
  type User,
} from "./auth.js";
import { TUNABLE_RULES, applySettings, readSettings } from "./settings.js";
import { SecretStore } from "./secrets.js";
import {
  generateDocs,
  generateAlter,
  generateCodeowners,
  environmentNames,
  taxonomyFor,
  generateDataform,
  generateModelDdl,
  renderAlterScript,
} from "@strata/ddl";
import { PathError, listFiles, readWorkspaceFile, writeWorkspaceFile } from "./files.js";
import {
  assertDatasetId,
  columnsQuery,
  keysQuery,
  mapToObjects,
  read,
  readBigQuery,
  type BigQueryColumnRow,
  type BigQueryKeyRow,
  type MappedObject,
  type SourceFormat,
} from "@strata/import";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { DeliveryLog } from "./deliveries.js";
import { MergeWatcher } from "./watcher.js";
import { loadSkills, runGate, setSkillEnabled, type Completion } from "./skills.js";
import { listTaxonomies, proposeMapping, runQuery, type GcpAuth } from "./bigquery.js";
import { TenantStore, currentTenant, runInTenant, type Tenant } from "./tenancy.js";
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
import { Stores } from "./stores.js";
import { AuditLog, type AuditAction } from "./audit.js";
import { LoginThrottle, clientKey } from "./throttle.js";
import { corsOptions, securityHeaders } from "./security.js";
import { errorHandler, log, requestLogger, respondWithServerError } from "./logging.js";
import { BlockedUrlError, assertSafeUrl } from "./ssrf.js";
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

const PORT = Number(process.env.PORT ?? 4000);
/*
  The workspace, and what happens when nobody says which one.

  **The fallback is deliberately not the shipped example.** It used to be, and the effect was
  that somebody standing up their own instance created the first administrator and landed in a
  fictional shop, with three models and nineteen objects they did not write. Nothing was broken,
  but the first thing a new operator saw was somebody else's data presented as theirs, and the
  obvious next question was how to delete it.

  `./workspace` instead. An empty or absent directory is a state the product already handles
  well: the setup screen offers to create the config, which is the right first screen for a real
  instance.

  The example is still one argument away, and the dev script passes it explicitly for exactly
  that reason. Making it opt-in is the whole change.
*/
const WORKSPACE = resolve(process.env.STRATA_WORKSPACE ?? process.argv[2] ?? "workspace");

/**
 * Where to clone the model repo from, when the workspace is not already a checkout.
 *
 * This is what makes a platform deployment possible. Docker Compose bind-mounts a clone
 * from the host; Render, Cloud Run and friends give you an empty disk, so the container has
 * to fetch the repository itself. Unset means the previous behaviour exactly: use whatever
 * is at `STRATA_WORKSPACE`.
 */
const MODEL_REPO = process.env.STRATA_MODEL_REPO?.trim() || undefined;
const MODEL_BRANCH = process.env.STRATA_MODEL_BRANCH?.trim() || undefined;
const GIT_AUTHOR =
  process.env.STRATA_GIT_AUTHOR_NAME && process.env.STRATA_GIT_AUTHOR_EMAIL
    ? { name: process.env.STRATA_GIT_AUTHOR_NAME, email: process.env.STRATA_GIT_AUTHOR_EMAIL }
    : undefined;

const DATA_DIR = resolve(process.env.STRATA_DATA_DIR ?? ".strata-data");
/**
 * Auth can be turned off for single-user local work. It is on by default: a tool that
 * writes to a shared repo should not be open to anyone who can reach the port, and
 * defaulting to insecure would mean most deployments quietly stay that way.
 */
const AUTH_DISABLED = process.env.STRATA_AUTH === "off" || process.env.STRATA_AUTH_DISABLED === "true";
const COOKIE_SECURE = process.env.STRATA_COOKIE_SECURE === "true";

const auth = new AuthStore(DATA_DIR, AUTH_DISABLED);

/**
 * Instance state, resolved per tenant.
 *
 * Called rather than referenced -- `secrets()` not `secrets` -- and that is the point. A module
 * constant is exactly how the credential store came to be shared by every visitor in the hosted
 * mode: one instance, built at import time, before any request exists to have a tenant. Making
 * these functions means the tenant is read at the moment of use, the same way `getWorkspace()`
 * already does it, and there is no way to accidentally capture the wrong one.
 *
 * In single-tenant self-hosting every call returns the same instance against the same directory,
 * so nothing changes for the deployment that most people run.
 */
const stores = new Stores(DATA_DIR);
const secrets = (): SecretStore => stores.secrets();
const presence = (): Presence => stores.presence();
const deliveries = (): DeliveryLog => stores.deliveries();
const audit = (): AuditLog => stores.audit();

/** Backoff on the sign-in route. See `throttle.ts` for why it is only on that route. */
const loginThrottle = new LoginThrottle();

/**
 * Whether `X-Forwarded-For` may be believed.
 *
 * Off by default, because a client can send that header itself and trusting it unconditionally
 * would let an attacker mint a fresh throttle key on every request. Turn it on when strata genuinely
 * sits behind a proxy or ingress, which is every real deployment with TLS.
 */
const TRUST_PROXY = process.env.STRATA_TRUST_PROXY === "true";

/**
 * How often the default branch is polled for merges.
 *
 * Configurable because the right answer depends on the deployment: a team that merges twice a
 * day does not need a request every thirty seconds, and a shared instance behind a rate-limited
 * enterprise remote actively should not. Set to `0` to switch merge detection off entirely.
 */
const WATCH_INTERVAL_MS = Number(process.env.STRATA_WATCH_INTERVAL_MS ?? 60_000);

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
 * Multi-tenant mode.
 *
 * Off unless `STRATA_TENANT_DIR` is set, and that default matters: a self-hosted instance must behave
 * exactly as before, serving the one workspace its operator mounted. Everything below is inert
 * until a deployment opts in.
 */
const TENANT_DIR = process.env.STRATA_TENANT_DIR?.trim() || undefined;
/** Trial workspaces are seeded from here, so a visitor lands on something rather than nothing. */
const TENANT_SEED = process.env.STRATA_TENANT_SEED?.trim() || undefined;
const TENANT_TTL_MS = Number(process.env.STRATA_TENANT_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
const TENANT_COOKIE = "strata_workspace";

/**
 * Hosted mode: sign in with GitHub, and your repository is your workspace.
 *
 * Distinct from the anonymous trial above, which hands every visitor a scratch directory. Here a
 * workspace belongs to a repository, so two colleagues signing in separately reach the same one,
 * and the models live in the customer's GitHub rather than with us.
 *
 * Requires a tenant directory, because a hosted instance serving one workspace to everybody is
 * exactly the public wiki `tenancy.ts` warns about. Absent any of these, the whole mode is inert
 * and the server behaves as a normal self-hosted instance.
 */
const CLOUD_CLIENT_ID = process.env.STRATA_CLOUD_CLIENT_ID?.trim() || undefined;
const CLOUD_CLIENT_SECRET = process.env.STRATA_CLOUD_CLIENT_SECRET?.trim() || undefined;
const CLOUD_BASE_URL = process.env.STRATA_CLOUD_BASE_URL?.trim() || undefined;
/** A GitHub Enterprise Server, if this is not the public GitHub. */
const CLOUD_GITHUB_URL = process.env.STRATA_CLOUD_GITHUB_URL?.trim() || undefined;
/** Only needed if an Enterprise Server serves its API somewhere other than `/api/v3`. */
const CLOUD_API_URL = process.env.STRATA_CLOUD_API_URL?.trim() || undefined;
const CLOUD_ENABLED = Boolean(
  CLOUD_CLIENT_ID && CLOUD_CLIENT_SECRET && CLOUD_BASE_URL && TENANT_DIR,
);
const CLOUD_COOKIE = "strata_cloud";
const CLOUD_STATE_COOKIE = "strata_cloud_state";
/** A working day, so signing in each morning is the worst case. */
const CLOUD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Features this deployment permits at all.
 *
 * Distinct from configuration an admin can flip. A hosted trial must be able to switch
 * integrations *off entirely*, a trial visitor who can make the server POST to a URL of their
 * choosing has an SSRF primitive pointed at the host's network, and no admin toggle should be
 * able to re-enable that on somebody else's infrastructure.
 *
 * Unset means everything on, so self-hosted behaviour is unchanged.
 */
const FEATURES = (() => {
  const raw = process.env.STRATA_FEATURES;

  /*
    Unset and empty mean different things, and the difference matters.

    `undefined` is "the operator said nothing", so everything stays on and a self-hosted
    deployment behaves exactly as it always has. `STRATA_FEATURES=""` is somebody explicitly asking
    for an empty list, which has to mean *nothing is enabled* -- that is a public trial locking
    itself down, and it is the single most important configuration this flag exists to express.
    Treating the two the same turned the safest possible setting into the least safe one.
  */
  if (raw === undefined) return { integrations: true, skills: true, bigquery: true };

  const enabled = new Set(
    raw
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return {
    integrations: enabled.has("integrations"),
    skills: enabled.has("skills"),
    bigquery: enabled.has("bigquery"),
  };
})();

type FeatureSet = typeof FEATURES;

/** Nothing outbound. What an anonymous caller gets in any multi-tenant deployment. */
const NO_FEATURES: FeatureSet = { integrations: false, skills: false, bigquery: false };

/**
 * Which features this *caller* gets, as opposed to which the deployment permits.
 *
 * `FEATURES` answers a deployment-wide question and was the only answer there was, which is
 * wrong the moment one process serves more than one person. The hosted product and the anonymous
 * trial run the same image, so a signed-in customer who opened their own private repository was
 * handed the same locked-down feature set as a stranger who had proved nothing. That is why
 * integrations, skills and BigQuery were invisible in the managed cloud: not a bug in the
 * integrations, a deployment flag doing a job it cannot do.
 *
 * The split is by what the caller has proved, not by what they clicked:
 *
 * **Single-tenant is untouched.** No tenant directory means self-hosting, where the operator and
 * the user are the same organisation and `STRATA_FEATURES` is the whole answer. This is the
 * deployment most people run and its behaviour does not change at all.
 *
 * **Anonymous in a multi-tenant deployment gets nothing**, whatever the environment says. This is
 * deliberately not merely a default. Integrations let whoever configures them make the server
 * fetch a URL of their choosing, and on a public trial that is every stranger on the internet
 * pointed at the host's own network, where the metadata endpoint hands out the node's
 * credentials to anything that can reach it. Until now the only thing standing between a trial
 * visitor and that was an operator remembering to set `STRATA_FEATURES=""` on the right service,
 * a single env var whose failure is silent and which had already been got wrong in production.
 * Making it structural means a misconfigured trial is still a safe trial.
 *
 * **An authenticated caller gets the deployment's list.** `STRATA_FEATURES` stays a ceiling that
 * nothing here raises, so an operator who genuinely wants BigQuery off everywhere still gets it
 * off everywhere. What changes is that proving who you are is now what lifts you off the floor.
 */
function featuresFor(req: express.Request): FeatureSet {
  if (!TENANT_DIR) return FEATURES;

  // A repository in the session means GitHub confirmed this person's access to it.
  if ((req as CloudRequest).cloud?.repo) return FEATURES;

  /*
    A local account, for a multi-tenant deployment that runs its own sign-in. `auth.disabled` is
    checked because with auth off `req.user` is a stand-in for "nobody signed in", which is the
    trial, and treating that as authenticated would hand the floor away to exactly the caller it
    exists to contain.
  */
  if (!auth.disabled && (req as AuthedRequest).user) return FEATURES;

  return NO_FEATURES;
}

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

interface CloudRequest extends express.Request {
  cloud?: CloudSession | undefined;
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

const readers = requireRole(auth, "viewer");
const editors = requireRole(auth, "editor");
const admins = requireRole(auth, "admin");

/**
 * Refuse a route whose feature this deployment does not permit.
 *
 * **This is the half that was missing.** `FEATURES` was parsed at boot and used in exactly one
 * place: filling in the capability map on `/api/workspace`. So the UI faithfully reported
 * integrations as unavailable while every integration route continued to serve requests. A
 * deployment that set `STRATA_FEATURES=skills` to keep a trial visitor from pointing the server at
 * an arbitrary URL got the label and none of the protection.
 *
 * **Distinct from a role, and from config an admin can flip.** An admin toggle is a preference
 * inside one instance. This is the operator of the *host* saying a capability is not available
 * here at all, and no amount of privilege inside the app should re-enable it. That is why the
 * check is by deployment and why it sits in front of the role guard.
 *
 * **404 rather than 403.** A 403 says "this exists and you may not have it", which invites
 * somebody to go looking for the permission. A feature that is off for the deployment does not
 * exist for that deployment, and saying so is both more honest and less interesting.
 */
function requireFeature(name: keyof FeatureSet): GuardHandler {
  const guard: GuardHandler = (req, res, next) => {
    /*
      Resolved inside the guard, per request, rather than captured when the route is built.

      Capturing would reintroduce exactly the bug this file already learned once: a value read at
      import time, before any request exists to have a caller, that then answers for everybody.
      `featuresFor` is cheap, so there is nothing to gain by hoisting it and a silent
      authorization error to lose.
    */
    if (featuresFor(req)[name]) {
      next();
      return;
    }
    res.status(404).json({
      error: `the \`${name}\` feature is not enabled on this deployment`,
      feature: name,
    });
  };

  // Read by the route audit, so a new integrations route without a gate fails the suite.
  guard.strataFeature = name;
  return guard;
}

const integrationsOn = requireFeature("integrations");
const skillsOn = requireFeature("skills");
const bigqueryOn = requireFeature("bigquery");

/**
 * Record a privileged action.
 *
 * **Awaited, not fired and forgotten.** The first version did not await, on the reasoning that an
 * audit write must never turn a successful password change into an error. That reasoning is
 * sound and is already handled one level down: `AuditLog.record` swallows its own failures and
 * reports them to stderr. What not awaiting actually bought was a race, where an action could be
 * visible in its own response before it was visible in the log.
 *
 * For a log whose entire job is answering "who did this, and when", an entry that may or may not
 * have landed yet is not much of an answer. A file append on the handful of privileged routes
 * costs well under a millisecond, and these are not the hot path.
 */
async function recordAudit(
  req: AuthedRequest,
  action: AuditAction,
  fields: { target?: string; ok?: boolean; detail?: string } = {},
): Promise<void> {
  await audit().record({
    action,
    ok: fields.ok ?? true,
    ...(fields.target ? { target: fields.target } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
    ...(req.user
      ? { actor: { id: req.user.id, username: req.user.username, role: req.user.role } }
      : {}),
    ...(req.context?.id ? { requestId: req.context.id } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
  });
}

/**
 * Parsed workspaces, keyed by root directory.
 *
 * A map rather than a single slot because a hosted deployment serves one workspace per visitor.
 * Single-tenant deployments simply never put more than one entry in it, so the behaviour there is
 * unchanged.
 */
const cached = new Map<string, LoadedWorkspace>();

/**
 * How many parsed workspaces to keep.
 *
 * Bounded because a trial server accumulates visitors, and a parsed graph is not small, an
 * unbounded cache is a memory leak with a slow fuse. Least-recently-used is approximated by
 * insertion order, which `Map` preserves: good enough for a cache whose miss costs milliseconds.
 */
const MAX_CACHED_WORKSPACES = 32;

/**
 * The workspace directory for the current request.
 *
 * **Every route must use this, and none may use `WORKSPACE` directly.** That rule exists because
 * breaking it is silent. `getWorkspace()` has always resolved the tenant correctly, so the model,
 * the diagrams and the object editor were all safe. But five places reached for the module
 * constant instead: the three raw-file routes, the check for whether a workspace exists, and the
 * init route. In a hosted deployment those read and wrote the directory the *operator* mounted,
 * regardless of who was asking -- and because new tenants are seeded by copying that directory,
 * a write through them reached every visitor who arrived afterwards.
 *
 * There is no type that can catch this, so the constant is referenced in exactly one place below
 * and the rule is stated here instead.
 */
function workspaceRoot(): string {
  return currentTenant()?.root ?? WORKSPACE;
}

/**
 * The workspace for the current request.
 *
 * Reads the tenant from async context rather than taking it as an argument. There are sixty-one
 * call sites, and threading an id through all of them would have exactly one failure mode, * a missed call site quietly reading another tenant's model. Resolving it here means no call site
 * *can* be wrong.
 */
async function getWorkspace(force = false): Promise<LoadedWorkspace> {
  const root = workspaceRoot();

  if (!force) {
    const hit = cached.get(root);
    if (hit) return hit;
  }

  const loaded = await loadWorkspace(root);

  // Re-insert so recently used roots move to the end, and evict from the front.
  cached.delete(root);
  cached.set(root, loaded);
  if (cached.size > MAX_CACHED_WORKSPACES) {
    const oldest = cached.keys().next().value;
    if (oldest !== undefined) cached.delete(oldest);
  }

  return loaded;
}

/** Invalidate after any write so the next read sees what is on disk. */
async function refresh(): Promise<LoadedWorkspace> {
  return getWorkspace(true);
}

/**
 * An operator-supplied credential from the environment, or nothing when a tenant is in context.
 *
 * **The precedence was backwards for multi-tenancy, and silently so.** `STRATA_SKILLS_API_KEY`
 * and `STRATA_GCP_ACCESS_TOKEN` were read before the secret store, which is right for
 * self-hosting: one operator, one instance, one set of credentials, and an environment variable
 * is how a secret manager presents itself. Put the same code in front of several tenants and it
 * means every one of them silently spends the *operator's* model key and introspects the
 * operator's GCP project. Nobody would see it happen; the feature would simply work, on somebody
 * else's credential and somebody else's bill.
 *
 * So the environment is consulted only when there is no tenant. With one, the tenant's own
 * encrypted store is the only source there is, and a tenant who has configured nothing gets the
 * feature reported as unconfigured rather than quietly borrowing.
 *
 * `currentTenant()` rather than a parameter, for the reason `tenancy.ts` gives at length: a
 * value threaded through call sites has exactly one failure mode, and it is a silent one.
 */
function operatorEnv(name: string): string | undefined {
  if (currentTenant()) return undefined;
  return process.env[name]?.trim() || undefined;
}

/**
 * The GitHub token to act with, for this caller.
 *
 * **In hosted mode the right credential is the caller's own, and it was never reached.** A cloud
 * session already carries the OAuth token that cloned the repository, but every git operation
 * resolved its token from the secret store instead, which for a tenant is empty and for the
 * instance is the operator's. So Propose in the managed cloud had no usable credential at all:
 * the push failed, and the one thing the product exists to do did not happen.
 *
 * Preferring the session token is also the only way the permission is *real*. A token minted for
 * this person is refused by GitHub for a repository they may only read, so a viewer cannot push
 * no matter what this process believes about their role. Falling back to an operator token would
 * do the opposite, quietly lending write access to somebody who was never granted it.
 *
 * Self-hosting is unchanged: no cloud session, so this is `secrets().githubToken()` exactly as
 * before, including its file and environment precedence.
 */
async function githubTokenFor(req: express.Request): Promise<string | undefined> {
  const session = (req as CloudRequest).cloud;
  if (session?.token) return session.token;
  return secrets().githubToken();
}

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

/**
 * How agent skills reach a language model, or `undefined` when the operator has not said.
 *
 * Resolved per run rather than captured at boot so a key added to the secret store takes effect
 * without a restart. Returning `undefined` is a first-class outcome: agent skills then report
 * themselves *skipped*, which is the honest answer, a governance control that reported success
 * because nothing ran would be a green tick nobody earned.
 *
 * Anthropic's API shape, because that is the model family this tool is developed against. The
 * key is never logged and never sent to the browser.
 */
async function agentCompletion(): Promise<Completion | undefined> {
  const key = operatorEnv("STRATA_SKILLS_API_KEY") || (await secrets().get("skills.apiKey"));
  if (!key) return undefined;

  const model = process.env.STRATA_SKILLS_MODEL?.trim() || "claude-sonnet-5";

  return async ({ prompt, context }) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        /*
          The output contract is stated here rather than left to each skill author.

          One finding per line beats JSON for an advisory control: a model that produces slightly
          malformed JSON yields nothing at all, whereas slightly malformed lines still yield most
          of the findings.
        */
        system:
          "You are reviewing a data model. Report each problem on its own line as " +
          "`OBJECT: what is wrong`. Reply with exactly `OK` if you find nothing. " +
          "Do not add preamble, headings or commentary.",
        messages: [{ role: "user", content: `${prompt}\n\n--- MODEL ---\n${context}` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`the model provider returned ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  };
}

/**
 * Google Cloud credentials, or `undefined` when the operator has not supplied any.
 *
 * Resolved per request rather than captured at boot, so a key added to the secret store takes
 * effect without a restart. Two forms, and the order is deliberate:
 *
 *   1. `STRATA_GCP_ACCESS_TOKEN`, a short-lived token, typically from
 *      `gcloud auth print-access-token`. The easiest thing to try, and it expires on its own.
 *   2. A service account JSON key in the secret store under `gcp.serviceAccount`, encrypted at
 *      rest like every other credential. Signed locally into a JWT; the key never leaves this
 *      process except as a signature.
 *
 * Returning `undefined` is a first-class outcome, not an error: the routes then say plainly that
 * no credentials are configured, which is far more useful than a 401 from Google.
 */
async function gcpAuth(): Promise<GcpAuth | undefined> {
  const token = operatorEnv("STRATA_GCP_ACCESS_TOKEN");
  if (token) return { kind: "token", token };

  const raw = await secrets().get("gcp.serviceAccount");
  if (!raw) return undefined;

  try {
    const key = JSON.parse(raw) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!key.client_email || !key.private_key) return undefined;

    return {
      kind: "serviceAccount",
      clientEmail: key.client_email,
      privateKey: key.private_key,
      /*
        The key file names its own token endpoint, and it is honoured.

        Standard in every service account key Google issues, and it is not decoration: keys minted
        for a non-public partition, or an instance behind VPC Service Controls, carry a different
        one. Ignoring it silently sends the assertion to the public endpoint, which then rejects
        it, with an error about the credentials rather than about the endpoint.
      */
      ...(key.token_uri ? { tokenUri: key.token_uri } : {}),
    };
  } catch {
    /*
      A malformed key is treated as absent rather than thrown.

      The operator pasted something that is not the JSON key file, and the routes' "no credentials
      configured" message plus its hint is a better explanation than a JSON parse error.
    */
    return undefined;
  }
}

/** The pull request number out of a `.../pull/42` URL. */
function prNumber(url: string | undefined): number | undefined {
  const found = url ? /\/pull\/(\d+)/.exec(url) : undefined;
  return found ? Number(found[1]) : undefined;
}

function allDiagnostics(workspace: LoadedWorkspace): Diagnostic[] {
  return [
    ...workspace.diagnostics,
    ...validate(workspace.graph),
    ...lintNames(workspace.graph, {
      severities: workspace.config.lint.rules,
      strict: workspace.config.lint.strict,
    }),
  ];
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

function handler(
  fn: (req: AuthedRequest, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    fn(req as AuthedRequest, res).catch((error: unknown) => {
      // Map domain errors onto the status codes the UI branches on, so the user sees
      // "this changed on disk" rather than a generic failure.
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else if (error instanceof ConflictError) {
        res.status(409).json({ error: error.message });
      } else if (error instanceof ValidationError) {
        res.status(422).json({ error: error.message, issues: error.issues ?? [] });
      } else if (
        error instanceof AuthError ||
        error instanceof CloudError ||
        error instanceof MailError
      ) {
        res.status(error.status).json({ error: error.message });
      } else if (error instanceof GitError) {
        res.status(400).json({ error: error.message, command: error.command });
      } else if (error instanceof BlockedUrlError) {
        /*
          A refused outbound URL is the operator's mistake to fix, not a server fault, so it is a
          422 with the reason. The message names the host and how to allow it deliberately: the
          alternative is somebody staring at a form that will not save, with no idea that the
          address it resolves to is the problem.
        */
        res.status(422).json({ error: error.message });
      } else {
        /*
          Everything unmapped: logged in full server-side, summarised for the client.

          Returning `error.message` here used to hand the browser absolute filesystem paths from
          `ENOENT`, and the attempted URL from a failed `fetch`. On the integration routes that
          made a blind request into a readable one. The request id in the response is how a user
          and an operator find the same line.
        */
        respondWithServerError(error, req, res);
      }
    });
  };
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

// ---------------------------------------------------------------- presence

/**
 * The live event stream.
 *
 * `readers` gates it, so an unauthenticated request gets 401 before any stream opens.
 * `EventSource` cannot set headers, which is exactly why the session is a cookie rather
 * than a bearer token, it rides along automatically.
 */
app.get("/api/events", readers, (req, res) => {
  const user = (req as AuthedRequest).user ?? {
    id: "usr_local",
    username: "local",
    displayName: "Local user",
    role: "admin" as const,
    passwordHash: "",
    createdAt: new Date(0).toISOString(),
  };
  presence().open(res, user);
});

/** Tell the server which model this session is looking at. */
app.post(
  "/api/presence/where",
  readers,
  handler(async (req, res) => {
    const body = req.body as { connectionId?: string; model?: string; diagram?: string };
    if (!body.connectionId) {
      res.status(400).json({ error: "a connectionId is required" });
      return;
    }
    const known = presence().where(body.connectionId, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.diagram ? { diagram: body.diagram } : {}),
    });
    // Not an error: the stream may have reconnected with a new id and the client will
    // pick that up from the next `hello`. Say so rather than failing the request.
    res.json({ ok: known, peers: presence().peers() });
  }),
);

app.get(
  "/api/presence",
  readers,
  handler(async (_req, res) => {
    res.json({ peers: presence().peers(), locks: presence().activeLocks() });
  }),
);

/**
 * Claim an object for editing.
 *
 * Editors only, a viewer cannot write, so letting them lock would be pure denial of
 * service against the people who can.
 */
app.post(
  "/api/locks",
  editors,
  handler(async (req, res) => {
    const body = req.body as { objectId?: string; connectionId?: string; name?: string };
    if (!body.objectId || !body.connectionId) {
      res.status(400).json({ error: "objectId and connectionId are required" });
      return;
    }
    try {
      const lock = presence().claim(body.objectId, body.connectionId, body.name);
      res.json({ lock });
    } catch (error) {
      if (error instanceof LockedError) {
        res.status(409).json({ error: error.message, lock: error.lock });
        return;
      }
      throw error;
    }
  }),
);

app.delete(
  "/api/locks/:objectId",
  editors,
  handler(async (req, res) => {
    const connectionId = String(req.query.connectionId ?? "");
    const released = presence().release(String(req.params.objectId), connectionId);
    res.json({ released });
  }),
);

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


// ---------------------------------------------------------------- users (admin)

app.get(
  "/api/users",
  admins,
  handler(async (_req, res) => {
    res.json({ items: await auth.listUsers(), roles: ROLES });
  }),
);

app.post(
  "/api/users",
  admins,
  handler(async (req, res) => {
    const body = req.body as { username?: string; password?: string; displayName?: string; role?: Role };
    res.status(201).json({
      user: await auth.createUser({
        username: body.username ?? "",
        password: body.password ?? "",
        ...(body.displayName ? { displayName: body.displayName } : {}),
        role: body.role ?? "viewer",
      }),
    });
  }),
);

app.put(
  "/api/users/:id",
  admins,
  handler(async (req, res) => {
    const body = req.body as { displayName?: string; role?: Role; password?: string; disabled?: boolean };
    res.json({ user: await auth.updateUser(req.params.id ?? "", body) });
  }),
);

app.delete(
  "/api/users/:id",
  admins,
  handler(async (req, res) => {
    await auth.deleteUser(req.params.id ?? "");
    res.json({ ok: true });
  }),
);


/**
 * Close your own account.
 *
 * Separate from `DELETE /api/users/:id`, which is an administrator removing somebody else and is
 * gated on `admins`. Without this route a viewer or an editor cannot leave: the only way out is
 * to ask an administrator, which is a strange thing to have to do with your own account.
 *
 * `readers`, so anyone signed in can use it, and it can only ever delete the caller. The id comes
 * from the session rather than the request, so there is no parameter to tamper with.
 *
 * The username has to be typed back. A misclick should not end an account, and a confirmation
 * dialog alone is the thing people click through without reading.
 */
app.delete(
  "/api/account",
  readers,
  handler(async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: "sign in to continue" });
      return;
    }

    const body = req.body as { username?: string };
    if ((body.username ?? "").trim().toLowerCase() !== req.user.username) {
      res.status(422).json({ error: "type your username to confirm" });
      return;
    }

    /*
      `deleteUser` refuses to remove the last remaining administrator, and that guard is what
      stops somebody locking everyone out of their own instance from this screen. Reused rather
      than repeated, so the two routes cannot drift apart on the rule that matters.
    */
    await auth.deleteUser(req.user.id);
    await recordAudit(req, "user.delete", { target: req.user.username, detail: "closed their own account" });

    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

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
  return `${base.replace(/\/+$/, "")}/invite#${token}`;
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

// ---------------------------------------------------------------- setup

/**
 * Whether this instance has a model repo yet.
 *
 * The presence of the config file is the definition of a workspace, the loader globs for
 * content and infers nothing from paths, so `strata.config.yaml` is the only thing that
 * distinguishes a model repo from an arbitrary directory.
 */
function workspaceExists(): boolean {
  return existsSync(join(workspaceRoot(), CONFIG_FILENAME));
}

/**
 * Create the model repo.
 *
 * This closes a genuine hole rather than adding a convenience. Before it, a self-hosted
 * instance started against an empty volume with no `STRATA_MODEL_REPO` to clone had no route
 * forward at all: startup bootstrap skips, `loadWorkspace` throws, and the UI showed
 * "Cannot read the model repo" with instructions to go and run a CLI command, inside a
 * container the operator may not have a shell on. The first thing the tool asked of a new
 * user was to leave it.
 *
 * `initWorkspace` from `@strata/storage` does the work, so this is the same code path as
 * `strata init` and cannot drift from it. Admin-only: it decides the layout every file in
 * the repo will be written under.
 */
app.post(
  "/api/workspace/init",
  admins,
  handler(async (req, res) => {
    if (workspaceExists()) {
      // Not an error the UI should have offered, but refusing is the only safe answer:
      // rewriting the config of a populated repo would relocate every file in it.
      res.status(409).json({ error: `a workspace already exists at ${workspaceRoot()}` });
      return;
    }

    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      preset?: unknown;
      gitInit?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(422).json({ error: "a workspace name is required" });
      return;
    }

    const preset =
      typeof body.preset === "string" && (LAYOUT_PRESETS as readonly string[]).includes(body.preset)
        ? (body.preset as (typeof LAYOUT_PRESETS)[number])
        : undefined;

    const description =
      typeof body.description === "string" && body.description.trim().length > 0
        ? body.description.trim()
        : undefined;

    await initWorkspace(workspaceRoot(), {
      name,
      ...(description ? { description } : {}),
      ...(preset ? { preset } : {}),
    });

    /**
     * `git init`, when asked for.
     *
     * Offered rather than assumed. The whole premise is that the model is files in a git
     * repo, so a workspace that is not one is a half-built install, but the directory
     * may already be inside a parent repo, or the operator may intend to clone over it,
     * and silently creating a nested repository there would be worse than not trying.
     *
     * A failure here is reported without discarding the config that was just written: the
     * workspace is real and usable, it simply is not versioned yet.
     *
     * `POST /api/git/init` finishes the job later, which is what makes skipping it here safe.
     * Before that route existed this was a one-way door: unticking the box left the workspace
     * permanently un-versioned with no in-app recovery.
     */
    let gitInitialised = false;
    let gitError: string | undefined;
    if (body.gitInit === true) {
      try {
        await initRepo(workspaceRoot());
        gitInitialised = true;
      } catch (error) {
        gitError = error instanceof Error ? error.message : String(error);
      }
    }

    const workspace = await refresh();
    res.status(201).json({
      ok: true,
      root: workspace.root,
      name: workspace.config.name,
      gitInitialised,
      ...(gitError ? { gitError } : {}),
    });
  }),
);

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
      res.status(404).json({
        error: `no ${CONFIG_FILENAME} in ${workspaceRoot()}`,
        needsInit: true,
        root: workspaceRoot(),
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
          ? { base: process.env.STRATA_GCP_CATALOG_BASE.replace(/\/+$/, "") }
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

// ---------------------------------------------------------------- write

app.post(
  "/api/objects",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { kind?: string; name?: string; model?: string; object?: unknown };

    const payload =
      body.object ??
      scaffold((body.kind ?? "") as ObjectKind, {
        name: body.name ?? "Untitled",
        ...(body.model ? { model: body.model } : {}),
      });

    const result = await createObject(workspace, payload as Record<string, unknown>);
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.put(
  "/api/objects/:id",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { object: unknown; revision?: string };
    const result = await updateObject(workspace, req.params.id ?? "", body.object, body.revision);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.put(
  "/api/objects/:id/raw",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { yaml: string; revision?: string };
    const result = await updateObjectFromYaml(workspace, req.params.id ?? "", body.yaml, body.revision);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.delete(
  "/api/objects/:id",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const result = await removeObject(workspace, req.params.id ?? "");
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** In-place member edits from the canvas. */
app.patch(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Partial<MemberPatch>;
    if (!body.path) {
      res.status(400).json({ error: "a member path is required" });
      return;
    }
    /*
      Each key is forwarded only when present, because `undefined` and `null` mean different
      things downstream: absent leaves the field alone, `null` clears it. Spreading the body
      wholesale would turn every unsent optional into an explicit "leave alone", which is
      right, but also lets an unknown key through into the object, which is not.
    */
    const result = await updateMember(workspace, req.params.id ?? "", {
      path: body.path,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      ...(body.classification !== undefined ? { classification: body.classification } : {}),
    });
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.post(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const result = await addMember(workspace, req.params.id ?? "");
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.delete(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: "a member path is required" });
      return;
    }
    const result = await removeMember(workspace, req.params.id ?? "", path);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

app.post(
  "/api/objects/:id/members/key",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { name?: string };
    if (!body.name) {
      res.status(400).json({ error: "a member name is required" });
      return;
    }
    const result = await toggleKey(workspace, req.params.id ?? "", body.name);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** Remove a foreign key, deleting a relationship line on a physical diagram. */
app.delete(
  "/api/objects/:id/foreign-keys",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) {
      res.status(400).json({ error: "a foreign key name is required" });
      return;
    }
    const result = await removeForeignKey(workspace, req.params.id ?? "", name);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** Drag one box onto another to relate them. */
app.post(
  "/api/models/:name/relationships",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Omit<Parameters<typeof createRelationship>[1], "modelName">;
    const result = await createRelationship(workspace, { ...body, modelName: req.params.name ?? "" });
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/**
 * What changed, scoped to a model or a domain.
 *
 * **Why paths and not a directory.** A model's files live wherever the layout put them, and
 * under the `flat` or `by-kind` presets they share directories with other models, so
 * "history for this model" cannot be a folder listing. The paths come from the workspace
 * index, which knows exactly which file each object was loaded from, and that is right under
 * every preset including one a team wrote themselves.
 *
 * Scoping to a domain is the union of its models' paths, for the same reason.
 */
app.get(
  "/api/history",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const model = typeof req.query.model === "string" ? req.query.model : undefined;
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const limit = Number(req.query.limit ?? 20);

    const paths = historyPaths(workspace, { model, domain });
    const result = await history(workspaceRoot(), {
      ...(paths ? { paths } : {}),
      limit: Number.isFinite(limit) ? limit : 20,
    });

    res.json({ ...result, scope: model ?? domain ?? "workspace", pathCount: paths?.length ?? 0 });
  }),
);

/**
 * One square on a model's row: enough to draw it, colour it and explain it on hover.
 *
 * Deliberately narrower than `HistoryEntry`, the file list is the bulk of that type and no
 * part of it is used here, so sending it would multiply the size of this response by the
 * number of files in every commit for nothing.
 */
interface HistorySummaryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  merge: boolean;
  pullRequest?: number;
  pullRequestUrl?: string;
  commitUrl?: string;
}

/**
 * Recent changes per model, for the models list.
 *
 * **One `git log`, then bucketed in memory.** The obvious implementation is a scoped log per
 * model, which is correct and unusable: a workspace with three hundred models would spawn
 * three hundred `git` processes to draw one page. Instead this walks a single log of the whole
 * repository once and attributes each commit to the models whose files it touched, which is
 * one process regardless of how many models there are.
 *
 * The trade-off, stated plainly: a commit that only touched files which have since been
 * deleted or moved cannot be attributed to a model, because the mapping is built from the
 * workspace as it stands now. Those commits are absent from a model's squares while still
 * appearing in its full History view, which reads the log with rename detection.
 */
app.get(
  "/api/history/summary",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();

    /** Which model each file on disk belongs to. */
    const modelOfPath = new Map<string, string>();
    for (const entry of workspace.graph.models()) {
      const own = workspace.pathById.get(entry.object.id);
      if (own) modelOfPath.set(own, entry.object.name);
      for (const member of workspace.graph.inModel(entry.object.name)) {
        const path = workspace.pathById.get(member.object.id);
        if (path) modelOfPath.set(path, entry.object.name);
      }
    }

    /**
     * Deep enough that an active model still fills its row.
     *
     * A model touched in one commit out of every fifty needs a wide window before ten of its
     * own changes appear. Three hundred commits is one cheap log and covers that; going
     * deeper buys little because the squares only show ten.
     */
    const { entries } = await history(workspaceRoot(), { limit: 300 });

    const byModel: Record<string, HistorySummaryEntry[]> = {};
    for (const entry of entries) {
      const touched = new Set<string>();
      for (const file of entry.files) {
        const model = modelOfPath.get(file);
        if (model) touched.add(model);
      }
      for (const model of touched) {
        const bucket = (byModel[model] ??= []);
        // Newest first out of git; ten is what the row draws.
        if (bucket.length < 10) {
          bucket.push({
            sha: entry.sha,
            shortSha: entry.shortSha,
            subject: entry.subject,
            author: entry.author,
            date: entry.date,
            merge: entry.merge,
            ...(entry.pullRequest ? { pullRequest: entry.pullRequest } : {}),
            ...(entry.pullRequestUrl ? { pullRequestUrl: entry.pullRequestUrl } : {}),
            ...(entry.commitUrl ? { commitUrl: entry.commitUrl } : {}),
          });
        }
      }
    }

    res.json({ byModel });
  }),
);

/**
 * Model-level settings: name, domain, tags, description, lifecycle.
 *
 * Its own endpoint rather than `PUT /api/objects/:id` because renaming a model is not a
 * field edit, the name is written into every child object, into other models'
 * `derivedFrom`, into every qualified cross-model reference, into `strata.config.yaml`, and
 * into the path of every file in the model. `updateObject` would write the renamed model
 * object and leave all five of those stale. See `refactor.ts`.
 */
app.patch(
  "/api/models/:id/settings",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Parameters<typeof updateModelSettings>[2];
    const result = await updateModelSettings(workspace, req.params.id ?? "", body);
    const reloaded = await refresh();
    res.json({
      model: result.model,
      objectsChanged: result.objectsChanged,
      moved: result.moves.length,
      configChanged: result.configChanged,
      diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts,
    });
  }),
);

/**
 * Rename a business domain.
 *
 * A domain is not a stored object, it exists only as a `namespace` string repeated on
 * each model, so renaming one means editing every member in a single pass, which is also
 * what keeps the file moves to one plan and one reviewable commit.
 */
app.post(
  "/api/domains/:name/rename",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { name?: string };
    const result = await renameNamespace(workspace, req.params.name ?? "", body.name ?? "");
    const reloaded = await refresh();
    res.json({
      models: result.models,
      objectsChanged: result.result?.objectsChanged ?? 0,
      diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts,
    });
  }),
);

app.put(
  "/api/models/:name/layout",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Parameters<typeof saveLayout>[2];
    const result = await saveLayout(workspace, req.params.name ?? "", body);
    await refresh();
    res.json({ diagramId: result.diagram.id, created: result.created, path: result.path });
  }),
);

// ---------------------------------------------------------------- settings

app.get(
  "/api/settings",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    res.json({
      settings: readSettings(workspace.config),
      presets: LAYOUT_PRESETS,
      tunableRules: TUNABLE_RULES,
      auth: { enabled: !auth.disabled, roles: ROLES },
      server: {
        workspace: workspace.root,
        dataDir: DATA_DIR,
        githubTokenConfigured: (await secrets().status()).configured,
      },
    });
  }),
);

app.put(
  "/api/settings",
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    await applySettings(workspace.root, req.body as Parameters<typeof applySettings>[1]);
    const reloaded = await refresh();
    res.json({ settings: readSettings(reloaded.config) });
  }),
);

// ---------------------------------------------------------------- layout presets

app.post(
  "/api/layout/preview",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const preset = String((req.body as { preset?: unknown }).preset ?? "");
    if (!(LAYOUT_PRESETS as readonly string[]).includes(preset)) {
      res.status(400).json({ error: `unknown preset \`${preset}\`` });
      return;
    }
    const candidate: LoadedWorkspace = {
      ...workspace,
      config: { ...workspace.config, layout: { ...workspace.config.layout, preset: preset as never } },
    };
    const plan = planWrites(candidate);
    res.json({ preset, moves: plan.moves, fileCount: plan.writes.length });
  }),
);

app.post(
  "/api/layout/apply",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const preset = String((req.body as { preset?: unknown }).preset ?? "");
    if (!(LAYOUT_PRESETS as readonly string[]).includes(preset)) {
      res.status(400).json({ error: `unknown preset \`${preset}\`` });
      return;
    }
    if (workspace.diagnostics.some((d) => d.severity === "error")) {
      res.status(409).json({ error: "some files failed to load; fix those before reorganising" });
      return;
    }

    await setLayoutPreset(workspace.root, preset);
    const result = await saveWorkspace(await refresh());
    await refresh();
    res.json({ preset, written: result.written.length, deleted: result.deleted.length });
  }),
);

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

// ---------------------------------------------------------------- compare

/**
 * Pairs worth comparing, so the view opens on something useful.
 *
 * A picker with every model against every other is a Cartesian product nobody wants to
 * read. The comparisons that mean something are between **adjacent tiers of the same
 * product**, that is where drift accumulates, because the two were designed together
 * and then edited apart.
 */
function suggestedPairs(workspace: LoadedWorkspace): { left: string; right: string; label: string }[] {
  const models = workspace.graph.models().map((entry) => entry.object);
  const byNamespace = new Map<string, typeof models>();

  for (const model of models) {
    const key = model.namespace ?? "";
    const bucket = byNamespace.get(key);
    if (bucket) bucket.push(model);
    else byNamespace.set(key, [model]);
  }

  const pairs: { left: string; right: string; label: string }[] = [];
  for (const [namespace, group] of byNamespace) {
    const at = (tier: string): typeof models => group.filter((model) => model.tier === tier);
    for (const [upper, lower] of [
      ["conceptual", "logical"],
      ["logical", "physical"],
    ] as const) {
      for (const left of at(upper)) {
        for (const right of at(lower)) {
          pairs.push({
            left: left.name,
            right: right.name,
            label: `${namespace ? `${namespace} · ` : ""}${upper} ↔ ${lower}`,
          });
        }
      }
    }
  }
  return pairs;
}

app.get(
  "/api/compare/pairs",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    res.json({
      pairs: suggestedPairs(workspace),
      models: workspace.graph.models().map((entry) => ({
        name: entry.object.name,
        tier: entry.object.tier,
        ...(entry.object.namespace ? { namespace: entry.object.namespace } : {}),
      })),
    });
  }),
);

/**
 * The DDL that would migrate one physical model's tables into another's shape.
 *
 * The second half of a compare: the first says two things differ, this says what to run. Only
 * meaningful between two *physical* models, because ALTER statements are about warehouse objects, * a conceptual model has no tables to alter, and offering a migration for one would be nonsense
 * dressed as a feature.
 *
 * Tables are matched by name. `from` is the current shape and `to` is the desired one, so
 * comparing staging against mart produces the statements to make staging look like mart.
 */
app.post(
  "/api/compare/migration",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { from?: string; to?: string; dropColumns?: boolean };

    const from = body.from ? workspace.graph.modelNamed(body.from) : undefined;
    const to = body.to ? workspace.graph.modelNamed(body.to) : undefined;
    if (!from || !to) {
      res.status(404).json({ error: "both a `from` and a `to` model are required" });
      return;
    }

    for (const model of [from, to]) {
      if (model.tier !== "physical") {
        res.status(400).json({
          error: `\`${model.name}\` is a ${model.tier} model. A migration only exists between physical models, there are no tables to alter otherwise.`,
        });
        return;
      }
    }

    const tablesOf = (name: string): Map<string, Table> => {
      const map = new Map<string, Table>();
      for (const entry of workspace.graph.inModel(name)) {
        if (entry.object.kind === "table") map.set(entry.object.name, entry.object as Table);
      }
      return map;
    };

    const current = tablesOf(from.name);
    const desired = tablesOf(to.name);

    const scripts = [];
    for (const [name, target] of desired) {
      const existing = current.get(name);
      if (!existing) {
        /**
         * A table the other side does not have at all.
         *
         * Not an ALTER, there is nothing to alter, so it is reported as a creation and the
         * `CREATE TABLE` for it already comes from the ordinary DDL generator. Emitting a
         * half-migration that silently skipped new tables would be the misleading option.
         */
        scripts.push({
          table: name,
          missing: true,
          requiresRecreate: false,
          changes: [
            {
              code: "table/missing",
              severity: "recreate" as const,
              message: `\`${name}\` does not exist in ${from.name}. Create it from the generated DDL rather than altering it.`,
            },
          ],
          statements: [],
          sql: "",
        });
        continue;
      }

      const script = generateAlter(existing, target, {
        qualifiedName: [target.project ?? to.target?.project, target.dataset ?? to.target?.dataset, name]
          .filter(Boolean)
          .join("."),
        ...(body.dropColumns ? { dropColumns: true } : {}),
      });

      if (script.changes.length === 0) continue;
      scripts.push({ ...script, missing: false, sql: renderAlterScript(script) });
    }

    res.json({
      from: from.name,
      to: to.name,
      scripts,
      /** Tables in `from` with no counterpart in `to`, which a migration cannot speak about. */
      extraTables: [...current.keys()].filter((name) => !desired.has(name)),
    });
  }),
);

/** Drift between two models. Read-only, this reports, it never reconciles. */
app.post(
  "/api/compare",
  readers,
  handler(async (req, res) => {
    const body = req.body as { left?: string; right?: string };
    const workspace = await getWorkspace();

    const names = new Set(workspace.graph.models().map((entry) => entry.object.name));
    for (const side of [body.left, body.right]) {
      if (!side || !names.has(side)) {
        res.status(404).json({ error: `no model named ${side ?? "(missing)"}` });
        return;
      }
    }
    if (body.left === body.right) {
      res.status(422).json({ error: "pick two different models" });
      return;
    }

    res.json(compareModels(workspace.graph, body.left!, body.right!));
  }),
);

// ---------------------------------------------------------------- import

/**
 * What an incoming object would collide with.
 *
 * Comparing ids alone is not enough, and getting this wrong is destructive. The file a
 * object lands in is derived from its **kind, model and name**, not from its id, so an
 * imported domain called `Money` overwrites an existing `money.yaml` even though the two
 * have completely different ids. The preview then reports "no clashes" and the import
 * silently replaces a file other objects reference, breaking them.
 *
 * So the index is keyed both ways: by id, and by the tuple the layout engine actually
 * uses to pick a path.
 */
function collisionIndex(workspace: LoadedWorkspace): {
  byId: Set<string>;
  clashesWith: (object: { id: string; kind: string; name: string; model?: string }) => string | undefined;
} {
  const byId = new Set<string>();
  const byPath = new Map<string, string>();

  const pathKey = (kind: string, model: string | undefined, name: string): string =>
    `${kind} ${model ?? ""} ${name.trim().toLowerCase()}`;

  for (const entry of workspace.graph.all()) {
    const object = entry.object as { id: string; kind: string; name: string; model?: string };
    byId.add(object.id);
    byPath.set(pathKey(object.kind, object.model, object.name), object.id);
  }

  return {
    byId,
    clashesWith: (object) => {
      if (byId.has(object.id)) return object.id;
      return byPath.get(pathKey(object.kind, object.model, object.name));
    },
  };
}

/**
 * Read a source file and report what it would create. Writes nothing.
 *
 * Separate from apply, and always run first, because a migration is the least
 * reversible thing this tool does: hundreds of objects arriving at once, from a file
 * nobody has read, into a repo other people work in. Seeing the count, the names, and
 *, most importantly, everything the reader *could not* map, is what makes it safe to
 * press the button.
 */
app.post(
  "/api/import/analyze",
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      text?: string;
      format?: SourceFormat;
      model?: string;
      tier?: "conceptual" | "logical" | "physical";
      dataset?: string;
    };

    const text = body.text ?? "";
    if (!text.trim()) {
      res.status(400).json({ error: "nothing to import" });
      return;
    }

    const source = read(text, body.format);
    const workspace = await getWorkspace();

    // The tier decides the shape of everything produced, so it has to be settled before
    // mapping. The user's choice wins; the reader's guess is only a default.
    const target = body.model
      ? workspace.graph.models().find((entry) => entry.object.name === body.model)?.object
      : undefined;
    const tier = body.tier ?? target?.tier ?? source.tier ?? "logical";

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model ?? "",
      tier,
      ...(body.dataset ? { dataset: body.dataset } : {}),
    });

    const { byId, clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object)).map((object) => object.id);
    void byId;

    res.json({
      format: source.format,
      tier,
      counts: {
        entities: source.entities.length,
        relationships: source.relationships.length,
        domains: source.domains.length,
        objects: objects.length,
      },
      objects: objects.map((object) => ({
        id: object.id,
        kind: object.kind,
        name: object.name,
        members:
          (object.columns as unknown[] | undefined)?.length ??
          (object.attributes as unknown[] | undefined)?.length ??
          0,
        clashes: Boolean(clashesWith(object)),
      })),
      clashes,
      diagnostics,
    });
  }),
);

/** Write the mapped objects. Editors only, this creates files in the repo. */
app.post(
  "/api/import/apply",
  editors,
  handler(async (req, res) => {
    const body = req.body as {
      text?: string;
      format?: SourceFormat;
      model?: string;
      tier?: "conceptual" | "logical" | "physical";
      dataset?: string;
      overwrite?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to import into" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const source = read(body.text ?? "", body.format);
    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the source could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model,
      tier: body.tier ?? target.tier,
      ...(body.dataset ? { dataset: body.dataset } : {}),
    });

    const { clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object));
    if (clashes.length > 0 && !body.overwrite) {
      res.status(409).json({
        error: `${clashes.length} object(s) already exist; re-run with overwrite to replace them`,
        clashes: clashes.map((object) => object.id),
      });
      return;
    }

    const { written, failed } = await writeImported(workspace, objects, clashesWith);

    await refresh();
    res.json({ written: written.length, files: written, failed, diagnostics });
  }),
);

/**
 * Write mapped objects into the workspace.
 *
 * Lifted out of the apply route when the BigQuery importer arrived and needed the identical
 * behaviour. Duplicating it would have been the shorter diff and the worse one: the two rules
 * below are the only reason a large import is survivable, and a second copy is a second place for
 * them to drift.
 */
async function writeImported(
  workspace: LoadedWorkspace,
  objects: MappedObject[],
  clashesWith: (object: MappedObject) => string | undefined,
): Promise<{ written: string[]; failed: { id: string; error: string }[] }> {
  const written: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const object of objects) {
    try {
      const collides = clashesWith(object);
      const result = collides
        ? // Replace under the *existing* id, not the imported one. Everything already
          // in the repo references that id, and swapping it for the import's would
          // break every one of those references to save a cosmetic rename.
          await updateObject(workspace, collides, {
            ...(object as Record<string, unknown>),
            id: collides,
          })
        : await createObject(workspace, object as Record<string, unknown>);
      written.push(result.path);
    } catch (error) {
      // One bad object must not abandon the other four hundred. An import of a real
      // erwin model will hit something odd; reporting which and carrying on is far
      // more useful than stopping at the first and rolling back the rest.
      failed.push({ id: object.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { written, failed };
}

// ---------------------------------------------------------------- reverse engineering

/**
 * Read a live dataset into the same shape a file import produces.
 *
 * **The whole feature, and it is this small.** `packages/import` already turns a `SourceModel`
 * into objects, and everything after that, preview, collision detection, the write loop above,
 * and proposing the result as a pull request, already existed and was already tested. What was
 * missing was never a reverse-engineering subsystem, only something to produce a `SourceModel`
 * from a warehouse rather than from a file.
 *
 * **Two queries, and the second is allowed to fail.** Columns are the point. Declared primary
 * keys are a bonus that some projects cannot serve at all, older ones have no constraint views,
 * and losing the whole import because the optional half 404'd would be the wrong trade. A missing
 * key becomes a table with no primary key, which is visible in the preview and in validation.
 */
async function readDataset(options: {
  dataset: string;
  auth: GcpAuth;
  project: string;
  location?: string;
}): Promise<{ source: ReturnType<typeof readBigQuery>; truncated: boolean }> {
  const columns = await runQuery({
    project: options.project,
    sql: columnsQuery(options.dataset),
    auth: options.auth,
    ...(options.location ? { location: options.location } : {}),
  });

  let keys: BigQueryKeyRow[] = [];
  try {
    const result = await runQuery({
      project: options.project,
      sql: keysQuery(options.dataset),
      auth: options.auth,
      ...(options.location ? { location: options.location } : {}),
    });
    keys = result.rows as unknown as BigQueryKeyRow[];
  } catch {
    // Optional by design. See above.
  }

  const source = readBigQuery(
    columns.rows as unknown as BigQueryColumnRow[],
    keys,
    { dataset: options.dataset },
  );

  if (columns.truncated) {
    source.diagnostics.push({
      severity: "warning",
      code: "import/truncated",
      message:
        "the dataset returned more columns than one import will read, so this is a partial " +
        "model. Import the largest tables separately, or raise MAX_ROWS.",
    });
  }

  return { source, truncated: columns.truncated };
}

/**
 * Resolve the dataset and the project to bill the query to.
 *
 * The dataset is validated before it is interpolated into SQL, which is the trust boundary here:
 * `assertDatasetId` allows only what Google allows in an identifier, so nothing can close the
 * backtick quoting the query builds. The project may be written into the dataset itself, given
 * explicitly, or inherited from the model's own BigQuery target, which is the case that means a
 * team who has already said where their warehouse lives does not have to say it twice.
 */
function resolveDatasetTarget(
  raw: string | undefined,
  explicitProject: string | undefined,
  target: { project?: string } | undefined,
): { dataset: string; project: string } {
  if (!raw?.trim()) throw new ValidationError("a dataset is required");

  /*
    Rethrown as a `ValidationError` so the caller gets 422 and the reason.

    `assertDatasetId` throws a plain `Error` because it lives in a package that knows nothing
    about HTTP, which is right. Left unwrapped it reaches the catch-all and becomes a bare 500,
    so the one message that says exactly what is wrong with the input is replaced by the one
    status that says nothing at all.
  */
  let dataset: string;
  try {
    dataset = assertDatasetId(raw);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "invalid dataset");
  }
  const qualified = dataset.includes(".") ? dataset.split(".")[0] : undefined;
  const project = explicitProject?.trim() || qualified || target?.project;

  if (!project) {
    throw new ValidationError(
      "no project to run the query in. Give the dataset as `project.dataset`, or set a " +
        "BigQuery target on the model.",
    );
  }

  return { dataset, project };
}

/** What a live dataset would bring in. Writes nothing, the same contract as `/api/import/analyze`. */
app.post(
  "/api/import/bigquery/analyze",
  bigqueryOn,
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
    };

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({
        error: "no Google credentials are configured",
        hint: "add a service account under `gcp.serviceAccount`, or set STRATA_GCP_ACCESS_TOKEN",
      });
      return;
    }

    const workspace = await getWorkspace();
    const target = body.model
      ? workspace.graph.models().find((entry) => entry.object.name === body.model)?.object
      : undefined;

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target?.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    /*
      Physical, always. A warehouse read back is real tables with real warehouse types, and
      importing it as logical would classify `NUMERIC(18, 2)` down to `decimal` and lose the
      scale on the way in.
    */
    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model ?? "",
      tier: "physical",
      dataset,
    });

    const { clashesWith } = collisionIndex(workspace);

    res.json({
      format: source.format,
      tier: "physical",
      dataset,
      project,
      counts: {
        entities: source.entities.length,
        relationships: source.relationships.length,
        domains: source.domains.length,
        objects: objects.length,
      },
      objects: objects.map((object) => ({
        id: object.id,
        kind: object.kind,
        name: object.name,
        members: (object.columns as unknown[] | undefined)?.length ?? 0,
        clashes: Boolean(clashesWith(object)),
      })),
      clashes: objects.filter((object) => clashesWith(object)).map((object) => object.id),
      diagnostics,
    });
  }),
);

/**
 * Where the warehouse and the model disagree, and the DDL that closes the gap.
 *
 * **This is the feature the notes list as blocked on selective apply, and it is not.** Every part
 * already existed: reading a dataset is the importer above, and `generateAlter` has encoded
 * BigQuery's real `ALTER` limits since long before this route. Drift is the two of them pointed at
 * each other, and it costs a loop rather than a subsystem.
 *
 * **The direction is deliberate.** `from` is the live table and `to` is the modelled one, so the
 * statements migrate the *warehouse* to match the *model*. That is the direction the model being
 * authoritative implies: the repository is reviewed and the warehouse is what drifted. The
 * opposite direction is the importer, which is why it is a separate route rather than a flag.
 *
 * **Nothing is executed, ever.** This returns SQL for a person to read and run. A route that
 * applied its own migration would be a tool that rewrites a production warehouse on a button, and
 * the `recreate` class means some of what it produces must never be run unattended at all.
 */
app.post(
  "/api/import/bigquery/drift",
  bigqueryOn,
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
      dropColumns?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to compare against" });
      return;
    }

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({ error: "no Google credentials are configured" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the dataset could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    /*
      Parsed through the real schema rather than cast.

      `mapToObjects` returns plain objects, and `generateAlter` reads `columns[].mode`, nested
      `fields` and the partitioning shape. Casting would work right up to the first table where a
      default mattered, and then compare a column against a field that was never populated.
    */
    const live = new Map<string, Table>();
    for (const object of mapToObjects(source, { model: body.model, tier: "physical", dataset }).objects) {
      const parsed = parseObject(object);
      if (parsed.object && isKind(parsed.object, "table")) {
        live.set(parsed.object.name.toLowerCase(), parsed.object);
      }
    }

    const modelled = workspace.graph
      .inModel(body.model)
      .map((entry) => entry.object)
      .filter((object): object is Table => object.kind === "table");

    const drifted: {
      table: string;
      changes: ReturnType<typeof generateAlter>["changes"];
      statements: string[];
      requiresRecreate: boolean;
      sql: string;
    }[] = [];
    const notDeployed: string[] = [];
    const seen = new Set<string>();

    for (const table of modelled) {
      const current = live.get(table.name.toLowerCase());
      if (!current) {
        // In the model, absent from the warehouse. Not drift: it has never been built.
        notDeployed.push(table.name);
        continue;
      }
      seen.add(table.name.toLowerCase());

      const script = generateAlter(current, table, {
        qualifiedName: qualifiedTableName(table, {
          ...(project ? { project } : {}),
          dataset: dataset.includes(".") ? dataset.split(".")[1]! : dataset,
        }),
        ...(body.dropColumns ? { dropColumns: true } : {}),
      });

      if (script.changes.length > 0) {
        drifted.push({
          table: table.name,
          changes: script.changes,
          statements: script.statements,
          requiresRecreate: script.requiresRecreate,
          sql: renderAlterScript(script),
        });
      }
    }

    /*
      In the warehouse and not in the model.

      Reported rather than ignored, because this is the direction that produces the surprise: a
      column somebody added by hand at 3am is invisible to every other view in this tool, and it
      is exactly what the model claiming to be authoritative is wrong about.
    */
    const notModelled = [...live.values()]
      .filter((table) => !seen.has(table.name.toLowerCase()))
      .map((table) => table.name);

    res.json({
      dataset,
      project,
      model: body.model,
      inSync: drifted.length === 0 && notDeployed.length === 0 && notModelled.length === 0,
      drifted,
      notDeployed,
      notModelled,
      diagnostics: source.diagnostics,
    });
  }),
);

/** Write what the analyze route previewed. Editors only, this creates files in the repo. */
app.post(
  "/api/import/bigquery/apply",
  bigqueryOn,
  editors,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
      overwrite?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to import into" });
      return;
    }

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({ error: "no Google credentials are configured" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the dataset could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model,
      tier: "physical",
      dataset,
    });

    const { clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object));

    /*
      Re-importing a dataset that is already modelled is the *normal* case here, not the exception
      it is for a file import: this is how drift gets noticed. So a clash still refuses by default,
      because overwriting somebody's descriptions and classifications with a bare warehouse read is
      destructive, but it is the expected answer rather than a failure.
    */
    if (clashes.length > 0 && !body.overwrite) {
      res.status(409).json({
        error: `${clashes.length} object(s) already exist; re-run with overwrite to replace them`,
        clashes: clashes.map((object) => object.id),
        hint: "compare the model against the dataset first if you want to see what changed",
      });
      return;
    }

    const { written, failed } = await writeImported(workspace, objects, clashesWith);

    await refresh();
    await recordAudit(req, "import.bigquery", { target: `${project}.${dataset}` });

    res.json({ written: written.length, files: written, failed, diagnostics, dataset, project });
  }),
);

// ---------------------------------------------------------------- generation

/**
 * Preview or write DDL.
 *
 * Preview first, always: this writes files into the user's repo, and seeing exactly what
 * lands before it lands is what makes that safe to run. Everything generated is a *new*
 * file, nothing here edits something a human wrote.
 */
app.post(
  "/api/generate/ddl",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      model?: string;
      write?: boolean;
      /** Which deployment target's policy tags to resolve against. Omitted uses the shared map. */
      environment?: string;
    };

    const blocking = workspace.diagnostics.filter((d) => d.severity === "error");
    if (blocking.length > 0) {
      res.status(409).json({
        error: `${blocking.length} file(s) could not be loaded; refusing to generate from a partial model`,
      });
      return;
    }

    const settings = readSettings(workspace.config);
    const all = workspace.graph.models().map((entry) => entry.object);
    const physical = all
      .filter((model) => model.tier === "physical")
      .filter((model) => !body.model || model.name === body.model);

    if (physical.length === 0) {
      // Three different situations reach here, and telling them apart is the whole
      // value of the message. "No physical models" when the user asked for a model
      // that exists but is logical sends them looking for the wrong problem.
      const named = body.model ? all.find((model) => model.name === body.model) : undefined;
      const error = !body.model
        ? "this workspace has no physical models, so there is no DDL to generate"
        : named
          ? `${body.model} is a ${named.tier} model, DDL is only generated from physical models`
          : `no model named ${body.model} in this workspace`;
      res.status(404).json({ error });
      return;
    }

    const files = physical.flatMap((model) =>
      generateModelDdl(workspace.graph, model.name, {
        orReplace: settings.ddl.orReplace,
        pathTemplate: settings.ddl.pathTemplate,
        /*
          The taxonomy comes from the config, not from settings, and is resolved *per
          environment*.

          Two reasons, and both are about blast radius. It has to be reviewable in a pull request
          alongside the classifications it acts on, a change to which policy tag "pii" maps to
          silently re-scopes column-level security across the whole warehouse. And a policy tag is
          a resource path embedding a project and a taxonomy id, so the same logical `pii` is a
          different string in dev and prod: generating production DDL with development's ids does
          not fail here, it fails at apply time against a taxonomy the target project cannot see.
        */
        taxonomy: taxonomyFor(workspace.config.governance, body.environment),
        // Only name the index after its model when several share the folder. A lone
        // model should still produce a plain `README.md`.
        ...(physical.length > 1 ? { indexSuffix: model.name } : {}),
      }),
    );

    // Writing requires the editor role even though previewing does not.
    if (body.write) {
      if (!hasRole(req.user, "editor") && !auth.disabled) {
        res.status(403).json({ error: "writing generated files needs the `editor` role" });
        return;
      }

      let written = 0;
      for (const file of files) {
        const relative = `${settings.ddl.outputFolder}/${file.path}`.replace(/\/{2,}/g, "/");
        const absolute = join(workspace.root, relative);
        let existing: string | undefined;
        try {
          existing = await readFile(absolute, "utf8");
        } catch {
          existing = undefined;
        }
        if (existing === file.contents) continue;
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.contents, "utf8");
        written++;
      }
      await refresh();
      res.json({ written, total: files.length, folder: settings.ddl.outputFolder });
      return;
    }

    /**
     * Say what each file would actually do, rather than just listing everything.
     *
     * A team that already keeps DDL in the repo sees the same fifty files every time
     * they open this panel, with no way to tell the two that changed from the
     * forty-eight that did not, so the panel is noise and the diff is the only real
     * answer. Comparing against what is on disk turns the list into a changeset.
     */
    const withStatus = await Promise.all(
      files.map(async (file) => {
        const path = `${settings.ddl.outputFolder}/${file.path}`.replace(/\/{2,}/g, "/");
        let existing: string | undefined;
        try {
          existing = await readFile(join(workspace.root, path), "utf8");
        } catch {
          existing = undefined;
        }
        return {
          path,
          kind: file.kind,
          contents: file.contents,
          status:
            existing === undefined ? "new" : existing === file.contents ? "unchanged" : "modified",
        };
      }),
    );

    res.json({
      folder: settings.ddl.outputFolder,
      files: withStatus,
      counts: {
        new: withStatus.filter((file) => file.status === "new").length,
        modified: withStatus.filter((file) => file.status === "modified").length,
        unchanged: withStatus.filter((file) => file.status === "unchanged").length,
      },
    });
  }),
);

/**
 * Dataform SQLX from the mappings.
 *
 * Deliberately a sibling of `/generate/ddl` rather than a flag on it: the two describe
 * different things (what the tables *are* versus how they are *filled*), land in different
 * repositories, and are usually owned by different people. Same preview-then-write
 * contract, because writing into someone's Dataform project unannounced is exactly the
 * behaviour that makes generators untrustworthy.
 */
app.post(
  "/api/generate/dataform",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { model?: string; write?: boolean };

    const blocking = workspace.diagnostics.filter((d) => d.severity === "error");
    if (blocking.length > 0) {
      res.status(409).json({
        error: `${blocking.length} file(s) could not be loaded; refusing to generate from a partial model`,
      });
      return;
    }

    const all = workspace.graph.models().map((entry) => entry.object);
    const physical = all
      .filter((model) => model.tier === "physical")
      .filter((model) => !body.model || model.name === body.model);

    if (physical.length === 0) {
      const named = body.model ? all.find((model) => model.name === body.model) : undefined;
      res.status(404).json({
        error: !body.model
          ? "this workspace has no physical models, so there are no mappings to generate from"
          : named
            ? `${body.model} is a ${named.tier} model, Dataform is only generated from physical models`
            : `no model named ${body.model} in this workspace`,
      });
      return;
    }

    /**
     * Where the Dataform project lives, and how it is laid out.
     *
     * Both come from the matching `dataform:` connection when the workspace declares one,
     * so a team that has already told the tool where its Dataform repo is does not repeat
     * itself here. `dataform/` is the fallback because that is what `dataform init` makes.
     */
    const connectionFor = (modelName: string) =>
      workspace.config.dataform.find(
        (candidate) => candidate.models.length === 0 || candidate.models.includes(modelName),
      );

    const folder =
      physical.map((model) => connectionFor(model.name)?.path).find(Boolean) ?? "dataform";

    const files = physical.flatMap((model) => {
      const connection = connectionFor(model.name);
      return generateDataform(workspace.graph, model.name, (connection?.paths ? { paths: connection.paths } : {}));
    });

    if (body.write) {
      if (!hasRole(req.user, "editor") && !auth.disabled) {
        res.status(403).json({ error: "writing generated files needs the `editor` role" });
        return;
      }

      let written = 0;
      for (const file of files) {
        const relative = `${folder}/${file.path}`.replace(/\/{2,}/g, "/");
        const absolute = join(workspace.root, relative);
        let existing: string | undefined;
        try {
          existing = await readFile(absolute, "utf8");
        } catch {
          existing = undefined;
        }
        if (existing === file.contents) continue;
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.contents, "utf8");
        written++;
      }
      await refresh();
      res.json({ written, total: files.length, folder });
      return;
    }

    const withStatus = await Promise.all(
      files.map(async (file) => {
        const path = `${folder}/${file.path}`.replace(/\/{2,}/g, "/");
        let existing: string | undefined;
        try {
          existing = await readFile(join(workspace.root, path), "utf8");
        } catch {
          existing = undefined;
        }
        return {
          path,
          kind: file.kind,
          contents: file.contents,
          status:
            existing === undefined ? "new" : existing === file.contents ? "unchanged" : "modified",
        };
      }),
    );

    res.json({
      folder,
      files: withStatus,
      counts: {
        new: withStatus.filter((file) => file.status === "new").length,
        modified: withStatus.filter((file) => file.status === "modified").length,
        unchanged: withStatus.filter((file) => file.status === "unchanged").length,
      },
    });
  }),
);

/** CODEOWNERS from ownership metadata, so approvals are enforced by branch protection. */
app.post(
  "/api/generate/codeowners",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const contents = generateCodeowners(workspace.graph, (id) => workspace.pathById.get(id));

    if ((req.body as { write?: boolean }).write) {
      await writeFile(join(workspace.root, "CODEOWNERS"), contents, "utf8");
      await refresh();
      res.json({ written: true, path: "CODEOWNERS" });
      return;
    }
    res.json({ path: "CODEOWNERS", contents });
  }),
);

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
 * The repo-relative files behind a model or a domain.
 *
 * `undefined` means "do not scope", the whole repository, which is what an unqualified
 * request asks for. An empty array is different and meaningful: a model that exists but has
 * no files on disk yet has an empty history, not the workspace's.
 *
 * The model object's own file is included alongside its members', because renaming the model
 * or changing its target edits that file and nothing else, and a history that omitted it
 * would silently drop exactly the changes this feature exists to show.
 */
function historyPaths(
  workspace: LoadedWorkspace,
  scope: { model?: string; domain?: string },
): string[] | undefined {
  if (!scope.model && !scope.domain) return undefined;

  const models = workspace.graph
    .models()
    .filter((entry) =>
      scope.model
        ? entry.object.name === scope.model
        : (entry.object.namespace ?? "Ungrouped") === scope.domain,
    );

  const paths = new Set<string>();
  for (const entry of models) {
    const own = workspace.pathById.get(entry.object.id);
    if (own) paths.add(own);
    for (const member of workspace.graph.inModel(entry.object.name)) {
      const path = workspace.pathById.get(member.object.id);
      if (path) paths.add(path);
    }
  }

  return [...paths];
}

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
