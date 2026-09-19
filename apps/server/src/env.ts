/**
 * Every environment variable this server reads, resolved once at import.
 *
 * Pulled out of `index.ts` so that "what can an operator configure, and what does it default
 * to" is one file rather than a search. These are the deployment's dials: the port, which
 * workspace to serve, whether auth is on, whether the instance is multi-tenant, and which
 * features it permits at all.
 *
 * Read once on purpose. A value re-read from `process.env` per request could change underneath
 * a running process, and several of these decide authorization; a constant cannot drift between
 * the check and the use.
 */
import { resolve } from "node:path";

export const PORT = Number(process.env.PORT ?? 4000);
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
export const WORKSPACE = resolve(process.env.STRATA_WORKSPACE ?? process.argv[2] ?? "workspace");

/**
 * Where to clone the model repo from, when the workspace is not already a checkout.
 *
 * This is what makes a platform deployment possible. Docker Compose bind-mounts a clone
 * from the host; Render, Cloud Run and friends give you an empty disk, so the container has
 * to fetch the repository itself. Unset means the previous behaviour exactly: use whatever
 * is at `STRATA_WORKSPACE`.
 */
export const MODEL_REPO = process.env.STRATA_MODEL_REPO?.trim() || undefined;
export const MODEL_BRANCH = process.env.STRATA_MODEL_BRANCH?.trim() || undefined;
export const GIT_AUTHOR =
  process.env.STRATA_GIT_AUTHOR_NAME && process.env.STRATA_GIT_AUTHOR_EMAIL
    ? { name: process.env.STRATA_GIT_AUTHOR_NAME, email: process.env.STRATA_GIT_AUTHOR_EMAIL }
    : undefined;

export const DATA_DIR = resolve(process.env.STRATA_DATA_DIR ?? ".strata-data");
/**
 * Auth can be turned off for single-user local work. It is on by default: a tool that
 * writes to a shared repo should not be open to anyone who can reach the port, and
 * defaulting to insecure would mean most deployments quietly stay that way.
 */
export const AUTH_DISABLED = process.env.STRATA_AUTH === "off" || process.env.STRATA_AUTH_DISABLED === "true";
export const COOKIE_SECURE = process.env.STRATA_COOKIE_SECURE === "true";

/**
 * Whether `X-Forwarded-For` may be believed.
 *
 * Off by default, because a client can send that header itself and trusting it unconditionally
 * would let an attacker mint a fresh throttle key on every request. Turn it on when strata genuinely
 * sits behind a proxy or ingress, which is every real deployment with TLS.
 */
export const TRUST_PROXY = process.env.STRATA_TRUST_PROXY === "true";

/**
 * How often the default branch is polled for merges.
 *
 * Configurable because the right answer depends on the deployment: a team that merges twice a
 * day does not need a request every thirty seconds, and a shared instance behind a rate-limited
 * enterprise remote actively should not. Set to `0` to switch merge detection off entirely.
 */
export const WATCH_INTERVAL_MS = Number(process.env.STRATA_WATCH_INTERVAL_MS ?? 60_000);

/**
 * Multi-tenant mode.
 *
 * Off unless `STRATA_TENANT_DIR` is set, and that default matters: a self-hosted instance must behave
 * exactly as before, serving the one workspace its operator mounted. Everything below is inert
 * until a deployment opts in.
 */
export const TENANT_DIR = process.env.STRATA_TENANT_DIR?.trim() || undefined;
/** Trial workspaces are seeded from here, so a visitor lands on something rather than nothing. */
export const TENANT_SEED = process.env.STRATA_TENANT_SEED?.trim() || undefined;
export const TENANT_TTL_MS = Number(process.env.STRATA_TENANT_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);
export const TENANT_COOKIE = "strata_workspace";

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
export const CLOUD_CLIENT_ID = process.env.STRATA_CLOUD_CLIENT_ID?.trim() || undefined;
export const CLOUD_CLIENT_SECRET = process.env.STRATA_CLOUD_CLIENT_SECRET?.trim() || undefined;
export const CLOUD_BASE_URL = process.env.STRATA_CLOUD_BASE_URL?.trim() || undefined;
/** A GitHub Enterprise Server, if this is not the public GitHub. */
export const CLOUD_GITHUB_URL = process.env.STRATA_CLOUD_GITHUB_URL?.trim() || undefined;
/** Only needed if an Enterprise Server serves its API somewhere other than `/api/v3`. */
export const CLOUD_API_URL = process.env.STRATA_CLOUD_API_URL?.trim() || undefined;
export const CLOUD_ENABLED = Boolean(
  CLOUD_CLIENT_ID && CLOUD_CLIENT_SECRET && CLOUD_BASE_URL && TENANT_DIR,
);
export const CLOUD_COOKIE = "strata_cloud";
export const CLOUD_STATE_COOKIE = "strata_cloud_state";
/** A working day, so signing in each morning is the worst case. */
export const CLOUD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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
export const FEATURES = (() => {
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

export type FeatureSet = typeof FEATURES;

/** Nothing outbound. What an anonymous caller gets in any multi-tenant deployment. */
export const NO_FEATURES: FeatureSet = { integrations: false, skills: false, bigquery: false };
