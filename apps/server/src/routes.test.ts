import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { GuardHandler, Role } from "./auth.js";

/**
 * The route layer, tested.
 *
 * **This file exists because its absence had consequences.** There were 243 server tests and not
 * one of them called a route or exercised `requireRole`. Every authorization decision and every
 * tenant resolution in the product lived in the one file with no coverage, and three separate
 * defects shipped through that gap:
 *
 *   1. `/api/files` read and wrote the operator's configured workspace regardless of which tenant
 *      was asking, so a hosted visitor could edit the directory every later visitor is seeded from.
 *   2. `STRATA_FEATURES` was parsed and reported in the capability map but no route consulted it, so
 *      the switch that was supposed to turn integrations off did nothing.
 *   3. The history routes had the same tenancy defect as the file routes, unnoticed.
 *
 * Each is a one-line mistake that reads correctly. None is catchable by inspection at scale.
 *
 * **Two kinds of test here, and the split matters.** The *audits* walk the express router and
 * assert a property of every route that exists, so a route added tomorrow without a guard fails
 * this suite rather than waiting to be noticed. The *live* tests boot the real app on a real port
 * and make real requests, because a guard that is present but wired in the wrong order still
 * lets the request through, and only a request finds that out.
 *
 * **No mocking, and no supertest.** Node has `fetch` and express has `listen(0)`, so a real
 * socket costs nothing and proves more. That is the same reasoning `dispatch.test.ts` records for
 * using a real HTTP server rather than a stubbed `fetch`.
 */

interface Booted {
  app: Express;
  server: Server;
  url: string;
  workspace: string;
  dataDir: string;
  tenantDir: string;
  close: () => Promise<void>;
}

const booted: Booted[] = [];
const tempRoots: string[] = [];

/** A fresh directory for tenant workspaces, tracked for cleanup. */
async function tenantDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "strata-tenants-"));
  tempRoots.push(dir);
  return dir;
}

/** A minimal but loadable workspace: the config file is what makes a directory a workspace. */
async function seedWorkspace(root: string, name: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "strata.config.yaml"), `version: 1\nname: ${name}\nroots:\n  - "."\n`, "utf8");
  await writeFile(
    join(root, "marker.yaml"),
    `kind: model\nid: mdl_${name}\nname: ${name}\ntier: logical\n`,
    "utf8",
  );
}

/**
 * Boot the real server with a given environment.
 *
 * `resetModules` then a dynamic import, because the configuration constants in `index.ts` are read
 * once at module scope. That is the right shape for a server -- re-reading `process.env` per
 * request would let a deployment drift mid-flight -- and it means a test that wants a different
 * configuration has to load the module again.
 */
async function boot(env: Record<string, string | undefined> = {}): Promise<Booted> {
  const base = await mkdtemp(join(tmpdir(), "strata-routes-"));
  tempRoots.push(base);

  const workspace = join(base, "workspace");
  const dataDir = join(base, "data");
  const tenantDir = join(base, "tenants");
  await seedWorkspace(workspace, "host_workspace");
  await mkdir(dataDir, { recursive: true });

  const previous = { ...process.env };

  /*
    `undefined` has to mean *unset*, and assigning it does the opposite.

    `process.env` coerces every value to a string, so `Object.assign(process.env, { KEY: undefined })`
    writes the literal seven characters `undefined`. That is not "no seed configured", it is a seed
    directory named `undefined`, and `TenantStore.create` then fails to copy it and answers 500 to
    every request that needs a workspace.

    It stayed hidden because it depends on test order: `close()` restores a snapshot taken before
    the first boot, so whichever test ran first left the variable genuinely absent for the next
    one and the suite passed as a whole. Every multi-tenant test here fails when run on its own,
    including ones that predate this comment. Deleting rather than assigning makes each test mean
    what it says regardless of what ran before it.
  */
  const overrides: Record<string, string | undefined> = {
    STRATA_WORKSPACE: workspace,
    STRATA_DATA_DIR: dataDir,
    STRATA_AUTH: "on",
    STRATA_WATCH_INTERVAL_MS: "0",
    STRATA_TENANT_DIR: undefined,
    STRATA_TENANT_SEED: undefined,
    STRATA_FEATURES: undefined,
    STRATA_ADMIN_USERNAME: undefined,
    STRATA_ADMIN_PASSWORD: undefined,
    STRATA_ADMIN_PASSWORD_HASH: undefined,
    STRATA_SKILLS_API_KEY: undefined,
    STRATA_GCP_ACCESS_TOKEN: undefined,
    ...env,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  const module = (await import("./index.js")) as { app: Express };
  const app = module.app;

  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;

  const entry: Booted = {
    app,
    server,
    url: `http://127.0.0.1:${port}`,
    workspace,
    dataDir,
    tenantDir,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      process.env = previous;
    },
  };
  booted.push(entry);
  return entry;
}

afterEach(async () => {
  while (booted.length) await booted.pop()?.close();
});

afterEach(async () => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------- router introspection

interface RouteInfo {
  method: string;
  path: string;
  role?: Role;
  feature?: string;
}

/**
 * Every route the app registered, with the guards it carries.
 *
 * Reads `app._router.stack`, which is an express internal. Acceptable here and nowhere else: the
 * alternative is a hand-maintained list of routes, and a hand-maintained list is exactly the
 * thing that goes stale and then silently stops covering the route somebody just added.
 */
function routesOf(app: Express): RouteInfo[] {
  const stack = (app as unknown as { _router?: { stack: unknown[] } })._router?.stack ?? [];
  const routes: RouteInfo[] = [];

  for (const layer of stack) {
    const route = (layer as { route?: { path: unknown; stack: { handle: GuardHandler }[]; methods: Record<string, boolean> } })
      .route;
    if (!route || typeof route.path !== "string") continue;

    const guards = route.stack.map((entry) => entry.handle);
    const role = guards.find((handle) => handle?.strataRole)?.strataRole;
    const feature = guards.find((handle) => handle?.strataFeature)?.strataFeature;

    for (const [method, enabled] of Object.entries(route.methods)) {
      if (!enabled) continue;
      routes.push({
        method: method.toUpperCase(),
        path: route.path,
        ...(role ? { role } : {}),
        ...(feature ? { feature } : {}),
      });
    }
  }

  return routes;
}

/**
 * Routes that are deliberately open, each with the reason.
 *
 * An explicit list rather than a pattern, so adding an unauthenticated route is a decision
 * somebody writes down here and a reviewer sees in the diff.
 */
const INTENTIONALLY_OPEN: Record<string, string> = {
  "GET /api/health": "liveness probe, and it returns nothing but ok",
  "POST /api/auth/setup": "creates the first administrator; refuses once one exists",
  "POST /api/auth/login": "signing in is what produces a role",
  "POST /api/auth/logout": "clearing your own cookie needs no privilege",
  "GET /api/auth/me": "reports who you are, which is nobody when signed out",

  /*
    Hosted sign-in. These carry no role because a role is what they produce: in hosted mode the
    role comes from the caller's GitHub permissions on the repository, so it does not exist until
    a repository has been chosen.

    The last two are not actually open. They refuse without a sealed cloud session, which the
    route audit cannot see because it looks for role guards. `cloud mode` below tests them
    directly for that reason.
  */
  "GET /api/cloud/login": "starts the GitHub redirect; signing in is what produces a role",
  "GET /api/cloud/callback": "GitHub redirects here; guarded by the signed state parameter",
  "POST /api/cloud/logout": "clearing your own cookie needs no privilege",
  "GET /api/cloud/me": "reports who you are, which is nobody when signed out",
  "GET /api/cloud/repos": "requires a cloud session, which is not a role the audit can see",
  "POST /api/cloud/workspace": "requires a cloud session, and re-checks GitHub access itself",

  /*
    Redeeming an invitation. Open by necessity: the caller has no account yet, which is the whole
    point of the invitation, so there is no role to check.

    The invitation token is the credential. It is 32 random bytes, single use, time boxed, and
    revocable, and it carries its own role, so redeeming one cannot produce an account more
    privileged than the invitation allowed.
  */
  "POST /api/invites/check": "an invitee has no account yet; the token is the credential",
  "POST /api/invites/accept": "same, and the role comes from the invitation rather than the request",
};

describe("route audit", () => {
  it("guards every API route with a role, or names why it is open", async () => {
    const { app } = await boot();

    const unguarded = routesOf(app)
      .filter((route) => route.path.startsWith("/api"))
      .filter((route) => !route.role)
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !(key in INTENTIONALLY_OPEN));

    expect(
      unguarded,
      `these API routes have no role guard. Add one, or add an entry to INTENTIONALLY_OPEN ` +
        `explaining why the route is public: ${unguarded.join(", ")}`,
    ).toEqual([]);
  });

  it("gates every integrations, skills and bigquery route on its feature flag", async () => {
    const { app } = await boot();

    const expected: [RegExp, string][] = [
      [/^\/api\/integrations/, "integrations"],
      [/^\/api\/skills/, "skills"],
      [/^\/api\/bigquery/, "bigquery"],
    ];

    const ungated: string[] = [];
    for (const route of routesOf(app)) {
      for (const [pattern, feature] of expected) {
        if (!pattern.test(route.path)) continue;
        if (route.feature !== feature) {
          ungated.push(`${route.method} ${route.path} (expected \`${feature}\`, got \`${route.feature ?? "none"}\`)`);
        }
      }
    }

    expect(
      ungated,
      `STRATA_FEATURES cannot disable these routes: ${ungated.join(", ")}`,
    ).toEqual([]);
  });

  it("finds a substantial number of routes, so a broken walk cannot pass vacuously", async () => {
    /*
      The guard on the guards.

      Both audits above are "the bad list is empty" assertions, which pass just as happily when
      the router walk returns nothing at all. A rename of an express internal would do exactly
      that, and the suite would go green while checking nothing.
    */
    const { app } = await boot();
    expect(routesOf(app).length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------- live role matrix

async function createUser(
  boot: Booted,
  username: string,
  password: string,
  role: Role,
): Promise<void> {
  const { AuthStore } = await import("./auth.js");
  const store = new AuthStore(boot.dataDir, false);
  await store.createUser({ username, password, role });
}

/** Sign in and return the cookie, so later requests carry it. */
async function signIn(boot: Booted, username: string, password: string): Promise<string> {
  const response = await fetch(`${boot.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status, `sign-in failed for ${username}`).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0]!;
}

describe("role enforcement", () => {
  /**
   * One representative route per role, exercised as every role.
   *
   * The matrix is deliberately small and hand-picked rather than generated across all 79 routes:
   * a generated matrix would need a valid body for every write route, and a route that 422s on a
   * bad body tells you nothing about whether its role guard works. The audit above is what
   * provides exhaustiveness; this proves the guards actually fire.
   */
  const cases: { name: string; method: string; path: string; body?: unknown; needs: Role }[] = [
    { name: "reading the workspace", method: "GET", path: "/api/workspace", needs: "viewer" },
    { name: "listing files", method: "GET", path: "/api/files", needs: "viewer" },
    {
      name: "writing a file",
      method: "PUT",
      path: "/api/files/content",
      body: { path: "marker.yaml", contents: "kind: model\nid: mdl_x\nname: x\ntier: logical\n" },
      needs: "editor",
    },
    { name: "listing users", method: "GET", path: "/api/users", needs: "admin" },
    { name: "reading the audit log", method: "GET", path: "/api/audit", needs: "admin" },
    { name: "health detail", method: "GET", path: "/api/health/detail", needs: "admin" },
  ];

  const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

  it("admits each role to exactly what its rank allows", async () => {
    const instance = await boot();

    await createUser(instance, "vic", "password123", "viewer");
    await createUser(instance, "ed", "password123", "editor");
    await createUser(instance, "ada", "password123", "admin");

    const cookies: Record<Role, string> = {
      viewer: await signIn(instance, "vic", "password123"),
      editor: await signIn(instance, "ed", "password123"),
      admin: await signIn(instance, "ada", "password123"),
    };

    const failures: string[] = [];

    for (const testCase of cases) {
      for (const role of ["viewer", "editor", "admin"] as const) {
        const response = await fetch(`${instance.url}${testCase.path}`, {
          method: testCase.method,
          headers: {
            cookie: cookies[role],
            ...(testCase.body ? { "content-type": "application/json" } : {}),
          },
          ...(testCase.body ? { body: JSON.stringify(testCase.body) } : {}),
        });

        const permitted = rank[role] >= rank[testCase.needs];

        if (permitted && response.status === 403) {
          failures.push(`${role} was refused ${testCase.name} but needs only ${testCase.needs}`);
        }
        if (!permitted && response.status !== 403) {
          failures.push(
            `${role} got ${response.status} for ${testCase.name}, which needs ${testCase.needs}`,
          );
        }
      }
    }

    expect(failures, failures.join("; ")).toEqual([]);
  });

  it("refuses an unauthenticated request with 401 rather than serving it", async () => {
    const instance = await boot();
    await createUser(instance, "ada", "password123", "admin");

    const response = await fetch(`${instance.url}/api/workspace`);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------- feature gates, live

describe("deployment feature gates", () => {
  it("refuses a disabled feature at the route, not just in the capability map", async () => {
    /*
      The regression test for the defect that mattered most.

      `STRATA_FEATURES` was parsed and reported for months while no route consulted it, so a hosted
      deployment that switched integrations off still served every integration route. The
      capability map said one thing and the server did another.
    */
    const instance = await boot({ STRATA_FEATURES: "skills" });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const integrations = await fetch(`${instance.url}/api/integrations`, { headers: { cookie } });
    expect(integrations.status, "integrations should be off").toBe(404);

    const bigquery = await fetch(`${instance.url}/api/bigquery/environments`, { headers: { cookie } });
    expect(bigquery.status, "bigquery should be off").toBe(404);

    const skills = await fetch(`${instance.url}/api/skills`, { headers: { cookie } });
    expect(skills.status, "skills was listed, so it should be on").not.toBe(404);
  });

  it("turns everything off when STRATA_FEATURES is set but empty", async () => {
    /*
      The configuration a public trial actually wants, and the one that used to do the opposite.

      An empty list previously fell through to the same branch as "unset" and enabled
      everything. So an operator locking a trial down with `STRATA_FEATURES=` got the least safe
      configuration available, silently.
    */
    const instance = await boot({ STRATA_FEATURES: "" });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    for (const path of ["/api/integrations", "/api/skills", "/api/bigquery/environments"]) {
      const response = await fetch(`${instance.url}${path}`, { headers: { cookie } });
      expect(response.status, `${path} should be off`).toBe(404);
    }
  });

  it("leaves every feature on when STRATA_FEATURES is unset", async () => {
    const instance = await boot();
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const integrations = await fetch(`${instance.url}/api/integrations`, { headers: { cookie } });
    expect(integrations.status).toBe(200);
  });

  it("reports the gate honestly in the capability map", async () => {
    const instance = await boot({ STRATA_FEATURES: "skills" });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const response = await fetch(`${instance.url}/api/workspace`, { headers: { cookie } });
    const body = (await response.json()) as { capabilities: Record<string, boolean> };

    expect(body.capabilities.integrations).toBe(false);
    expect(body.capabilities.bigquery).toBe(false);
  });

  it("separates whether skills are permitted from whether an agent skill can run", async () => {
    /*
      The regression test for a dead tab that reached the live demo.

      `agentSkills` was the only skills field, and it was `FEATURES.skills && hasKey`. So a
      deployment with skills enabled but no model provider key looked identical to one where the
      feature was switched off entirely. The client could not tell them apart, kept the Skills page
      visible in both, and a visitor clicking it got a red "could not load skills" error for a
      deployment that had simply not enabled the feature.

      The two fields answer different questions and must stay separate.
    */
    const off = await boot({ STRATA_FEATURES: "" });
    await createUser(off, "ada", "password123", "admin");
    const offCookie = await signIn(off, "ada", "password123");
    const offBody = (await (
      await fetch(`${off.url}/api/workspace`, { headers: { cookie: offCookie } })
    ).json()) as { capabilities: Record<string, boolean> };

    expect(offBody.capabilities.skills, "feature off means the page should not exist").toBe(false);
    expect(offBody.capabilities.agentSkills).toBe(false);

    // Feature on, but no STRATA_SKILLS_API_KEY, so `check` skills work and `agent` skills do not.
    const on = await boot({ STRATA_FEATURES: "skills" });
    await createUser(on, "ada", "password123", "admin");
    const onCookie = await signIn(on, "ada", "password123");
    const onBody = (await (
      await fetch(`${on.url}/api/workspace`, { headers: { cookie: onCookie } })
    ).json()) as { capabilities: Record<string, boolean> };

    expect(onBody.capabilities.skills, "feature on, so the page is useful").toBe(true);
    expect(onBody.capabilities.agentSkills, "no key, so agent skills cannot run").toBe(false);
  });
});

// ---------------------------------------------------------------- per-caller feature profiles

/**
 * Which features a *caller* gets, as opposed to which the deployment permits.
 *
 * The gap these cover is the one that made the hosted product look broken. `STRATA_FEATURES` is
 * deployment-wide, one process serves every tenant, so the only way to keep an anonymous trial
 * visitor away from an outbound request was to switch the feature off for everybody, paying
 * customers included. Integrations, skills and BigQuery were therefore invisible in the managed
 * cloud, and the cause was not in any of those features.
 *
 * Two properties, pulling in opposite directions, and both have to hold at once:
 *
 *   - an anonymous caller in a multi-tenant deployment gets nothing, *whatever the environment
 *     says*, so a trial that is misconfigured is still a contained trial;
 *   - an authenticated one gets the deployment's list, so proving who you are is what earns the
 *     feature back.
 *
 * A test asserting only the first would pass on a server that had simply disabled everything.
 */
describe("caller feature profiles", () => {
  /**
   * Did the *feature gate* refuse this, as opposed to anything else that answers 404?
   *
   * Worth being precise about, because a missing workspace also 404s and the two are otherwise
   * indistinguishable. `requireFeature` names the feature in its body, so this reads the reason
   * rather than the status, and a test that passes for the wrong reason is worse than no test.
   */
  async function refusedByFeatureGate(url: string, path: string, cookie?: string): Promise<boolean> {
    const response = await fetch(`${url}${path}`, cookie ? { headers: { cookie } } : {});
    if (response.status !== 404) return false;
    const body = (await response.json().catch(() => ({}))) as { feature?: string };
    return typeof body.feature === "string";
  }

  it("refuses outbound features to an anonymous trial visitor even when the deployment permits them", async () => {
    /*
      The security property, and the reason this is structural rather than a default.

      Integrations let whoever configures them make the server fetch a URL of their choosing. On a
      public trial that is every stranger on the internet pointed at the host's own network, where
      the metadata endpoint hands out the node's credentials to anything that can reach it. Until
      now the only thing standing in the way was an operator remembering `STRATA_FEATURES=""` on
      the right service, which had already been got wrong in production.

      `STRATA_FEATURES` is deliberately left unset here, which is the *most* permissive setting
      there is. The caller must still get nothing.
    */
    const instance = await boot({
      STRATA_TENANT_DIR: await tenantDir(),
      STRATA_AUTH: "off",
      STRATA_FEATURES: undefined,
    });

    for (const path of ["/api/integrations", "/api/bigquery/environments", "/api/skills"]) {
      expect(await refusedByFeatureGate(instance.url, path), `${path} must be refused`).toBe(true);
    }
  });

  it("leaves a single-tenant deployment exactly as it was", async () => {
    /*
      The other half, and the one that would make this change unacceptable if it failed.

      Self-hosting is the deployment most people run: one operator, one mounted workspace, no
      tenancy. Nothing above applies to it, and an anonymous caller there is simply the operator
      with auth switched off. Tightening that would break working installations to fix a problem
      they do not have.
    */
    const instance = await boot({ STRATA_AUTH: "off", STRATA_FEATURES: undefined });

    expect(await refusedByFeatureGate(instance.url, "/api/integrations")).toBe(false);
  });

  it("gives an authenticated caller the deployment's features in a multi-tenant deployment", async () => {
    const instance = await boot({
      STRATA_TENANT_DIR: await tenantDir(),
      STRATA_AUTH: "on",
      STRATA_FEATURES: "integrations,skills",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    expect(
      await refusedByFeatureGate(instance.url, "/api/integrations", cookie),
      "a signed-in caller should get the permitted feature",
    ).toBe(false);

    // Anonymous on the very same instance still gets nothing.
    expect(await refusedByFeatureGate(instance.url, "/api/integrations")).toBe(true);
  });

  it("never raises the ceiling the deployment set", async () => {
    /*
      `STRATA_FEATURES` stays the operator's word on what is available at all. Signing in lifts a
      caller off the floor; it must not lift them past the ceiling, or an operator who switched
      BigQuery off everywhere would find it back on for anyone who logged in.
    */
    const instance = await boot({
      STRATA_TENANT_DIR: await tenantDir(),
      STRATA_AUTH: "on",
      STRATA_FEATURES: "",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    expect(await refusedByFeatureGate(instance.url, "/api/integrations", cookie)).toBe(true);
  });

  it("reports the caller's own features in the capability map, not the deployment's", async () => {
    /*
      The visible half of the same defect. The client hides a feature it is told it does not have,
      so a capability map answering the deployment-wide question meant the pages were never
      rendered, and the route refusals underneath were never even reached.
    */
    const dir = await tenantDir();
    const instance = await boot({
      STRATA_TENANT_DIR: dir,
      STRATA_AUTH: "on",
      STRATA_FEATURES: "integrations,skills",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const body = (await (
      await fetch(`${instance.url}/api/workspace`, { headers: { cookie } })
    ).json()) as { capabilities: Record<string, boolean> };

    expect(body.capabilities.integrations, "signed in, and the deployment permits it").toBe(true);
    expect(body.capabilities.skills).toBe(true);
    expect(body.capabilities.bigquery, "not in the deployment list").toBe(false);
  });
});

// ---------------------------------------------------------------- credential containment

describe("operator credentials in a multi-tenant deployment", () => {
  /**
   * The bug this covers is silent in the worst way: the feature works, on somebody else's key.
   *
   * `STRATA_SKILLS_API_KEY` and `STRATA_GCP_ACCESS_TOKEN` were read before the tenant's own
   * secret store. That precedence is right for self-hosting, where the operator and the user are
   * the same organisation and an environment variable is how a secret manager presents itself.
   * Put the same code in front of several tenants and every one of them spends the operator's
   * model key and introspects the operator's GCP project, with nothing anywhere to show it
   * happened.
   */
  it("ignores an operator model key when a tenant is in context", async () => {
    const instance = await boot({
      STRATA_TENANT_DIR: await tenantDir(),
      STRATA_AUTH: "on",
      STRATA_FEATURES: "skills",
      STRATA_SKILLS_API_KEY: "sk-operator-key-that-tenants-must-not-spend",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const body = (await (
      await fetch(`${instance.url}/api/workspace`, { headers: { cookie } })
    ).json()) as { capabilities: Record<string, boolean> };

    expect(body.capabilities.skills, "the feature itself is permitted").toBe(true);
    expect(
      body.capabilities.agentSkills,
      "the tenant configured no key of their own, so agent skills cannot run",
    ).toBe(false);
  });

  it("still uses the operator's model key when self-hosting", async () => {
    /*
      The control. Without it the test above would pass on a server that had broken environment
      credentials entirely, which would silently disable agent skills for every self-hosted
      installation.
    */
    const instance = await boot({
      STRATA_FEATURES: "skills",
      STRATA_SKILLS_API_KEY: "sk-operator-key",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const body = (await (
      await fetch(`${instance.url}/api/workspace`, { headers: { cookie } })
    ).json()) as { capabilities: Record<string, boolean> };

    expect(body.capabilities.agentSkills, "one operator, one instance, one key").toBe(true);
  });
});

// ---------------------------------------------------------------- reverse engineering

/**
 * The BigQuery importer, at the route.
 *
 * The reader itself is covered in `packages/import/src/bigquery.test.ts`, including the dataset
 * validation, so what is worth testing here is the wiring around it: that it is gated like every
 * other BigQuery route, that it refuses a hostile dataset before that value reaches a query, and
 * that an unconfigured credential is a clear answer rather than a crash.
 *
 * Nothing here reaches Google. A route that gets as far as needing a token is already past
 * everything these tests are about.
 */
describe("bigquery reverse engineering", () => {
  it("is gated by the deployment feature like every other bigquery route", async () => {
    const instance = await boot({ STRATA_FEATURES: "skills" });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    for (const path of [
      "/api/import/bigquery/analyze",
      "/api/import/bigquery/apply",
      "/api/import/bigquery/drift",
    ]) {
      const response = await fetch(`${instance.url}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ dataset: "analytics", model: "host_workspace" }),
      });
      expect(response.status, `${path} should be gated`).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ feature: "bigquery" });
    }
  });

  it("reports drift only against a model that exists", async () => {
    /*
      Drift is a comparison, so the thing being compared against has to be named. Defaulting to
      "every model" would compare a dataset against tables from unrelated models and report the
      whole warehouse as missing.
    */
    const instance = await boot({
      STRATA_FEATURES: "bigquery",
      STRATA_GCP_ACCESS_TOKEN: "ya29.test-token-never-used",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const noModel = await fetch(`${instance.url}/api/import/bigquery/drift`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dataset: "analytics" }),
    });
    expect(noModel.status, "no model named").toBe(400);

    const unknown = await fetch(`${instance.url}/api/import/bigquery/drift`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dataset: "analytics", model: "no_such_model" }),
    });
    expect(unknown.status, "model does not exist").toBe(404);
  });

  it("says plainly when no Google credentials are configured", async () => {
    /*
      The alternative is a 500 from a token exchange that was never going to work, which sends
      the operator looking at their dataset instead of at their credentials.
    */
    const instance = await boot({ STRATA_FEATURES: "bigquery" });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const response = await fetch(`${instance.url}/api/import/bigquery/analyze`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dataset: "analytics" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Google credentials"),
    });
  });

  it("refuses a dataset that could break out of the query text", async () => {
    /*
      The dataset is interpolated into SQL, so this is the trust boundary. Asserted at the route
      as well as at the reader because the guard and the query builder are separate functions, and
      the thing that actually protects anyone is that the route calls them in the right order.

      Credentials are deliberately absent, so a passing guard would answer 400 for the missing
      credential. 422 proves the dataset was rejected first, before anything was built from it.
    */
    const instance = await boot({
      STRATA_FEATURES: "bigquery",
      STRATA_GCP_ACCESS_TOKEN: "ya29.test-token-never-used",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const response = await fetch(`${instance.url}/api/import/bigquery/analyze`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dataset: "analytics`.x`; DROP TABLE t; --", project: "p" }),
    });

    expect(response.status).toBe(422);
  });

  it("refuses to write without a model to write into", async () => {
    const instance = await boot({
      STRATA_FEATURES: "bigquery",
      STRATA_GCP_ACCESS_TOKEN: "ya29.test-token-never-used",
    });
    await createUser(instance, "ada", "password123", "admin");
    const cookie = await signIn(instance, "ada", "password123");

    const response = await fetch(`${instance.url}/api/import/bigquery/apply`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dataset: "analytics" }),
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------- tenancy isolation

describe("tenant isolation", () => {
  /**
   * The test that would have caught the leak.
   *
   * Two visitors, two cookies, two workspaces. The assertion is not "they see different content"
   * but the stronger one: **neither of them can reach the directory the operator configured.**
   * That is the property that was broken, and it was broken in a way the weaker assertion would
   * have missed, because both tenants saw the same wrong thing and therefore agreed.
   */
  it("gives each visitor their own workspace, and neither the operator's", async () => {
    const hosted = await boot({ STRATA_AUTH: "off", STRATA_TENANT_DIR: await tenantDir() });

    // Two visitors, distinguished only by whether they send the workspace cookie back.
    const first = await fetch(`${hosted.url}/api/workspace`);
    expect(first.status).toBe(200);
    const firstCookie = first.headers.get("set-cookie")?.split(";")[0];
    expect(firstCookie, "a visitor should be given a workspace cookie").toBeTruthy();

    const second = await fetch(`${hosted.url}/api/workspace`);
    const secondCookie = second.headers.get("set-cookie")?.split(";")[0];
    expect(secondCookie).toBeTruthy();
    expect(secondCookie).not.toBe(firstCookie);

    // Neither visitor's file listing may be rooted at the configured workspace.
    for (const cookie of [firstCookie!, secondCookie!]) {
      const files = await fetch(`${hosted.url}/api/files`, { headers: { cookie } });
      expect(files.status).toBe(200);
      const body = (await files.json()) as { root: string };
      expect(
        body.root,
        "a tenant listed the operator's workspace instead of its own",
      ).not.toBe(hosted.workspace);
    }
  });

  it("does not let a visitor write into the directory new tenants are seeded from", async () => {
    /*
      The exact exploit, as a test.

      `PUT /api/files/content` used the module-level workspace constant, so a write landed in the
      operator's directory. Because `TenantStore.create` seeds a new visitor by copying that
      directory, the write was then handed to every visitor who arrived afterwards.
    */
    const seedRoot = await mkdtemp(join(tmpdir(), "strata-seed-"));
    tempRoots.push(seedRoot);
    await seedWorkspace(seedRoot, "seed_workspace");

    const hosted = await boot({
      STRATA_AUTH: "off",
      STRATA_TENANT_DIR: await tenantDir(),
      STRATA_TENANT_SEED: seedRoot,
    });

    const opened = await fetch(`${hosted.url}/api/workspace`);
    const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;

    const written = await fetch(`${hosted.url}/api/files/content`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        path: "poison.yaml",
        contents: "kind: model\nid: mdl_poison\nname: poison\ntier: logical\n",
      }),
    });
    expect([200, 201]).toContain(written.status);

    // The operator's workspace and the seed must both be untouched.
    expect(
      existsSync(join(hosted.workspace, "poison.yaml")),
      "a tenant wrote into the operator's configured workspace",
    ).toBe(false);
    expect(
      existsSync(join(seedRoot, "poison.yaml")),
      "a tenant wrote into the seed every later visitor is copied from",
    ).toBe(false);
  });

  it("keeps stored credentials out of another tenant's reach", async () => {
    /*
      The credential half of the same defect. SecretStore was constructed once against the data
      directory, so every tenant shared one set of stored credentials: one visitor could see that
      another had configured a provider key, read its last four characters, and trigger a dispatch
      that ran on it.
    */
    const hosted = await boot({ STRATA_AUTH: "off", STRATA_TENANT_DIR: await tenantDir() });

    const first = await fetch(`${hosted.url}/api/workspace`);
    const firstCookie = first.headers.get("set-cookie")!.split(";")[0]!;

    const stored = await fetch(`${hosted.url}/api/secrets/capabilities/skills.apiKey`, {
      method: "PUT",
      headers: { cookie: firstCookie, "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-ant-not-a-real-key-000000" }),
    });
    expect([200, 204]).toContain(stored.status);

    const second = await fetch(`${hosted.url}/api/workspace`);
    const secondCookie = second.headers.get("set-cookie")!.split(";")[0]!;

    const seen = await fetch(`${hosted.url}/api/secrets/capabilities`, {
      headers: { cookie: secondCookie },
    });
    const body = (await seen.json()) as { items: { name: string; configured: boolean }[] };
    const skills = body.items.find((item) => item.name === "skills.apiKey");

    expect(
      skills?.configured,
      "one tenant could see another tenant's stored credential",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- hardening, live

describe("hardening", () => {
  it("throttles repeated failed sign-ins", async () => {
    const instance = await boot();
    await createUser(instance, "ada", "password123", "admin");

    let throttled = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${instance.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "ada", password: "wrong-password" }),
      });
      if (response.status === 429) {
        expect(response.headers.get("retry-after")).toBeTruthy();
        throttled = true;
        break;
      }
    }

    expect(throttled, "unlimited sign-in attempts were allowed").toBe(true);
  });

  it("seeds the administrator from configuration, so setup is never open", async () => {
    const { hashPassword } = await import("./auth.js");
    const hash = await hashPassword("seeded-password");

    const instance = await boot({
      STRATA_ADMIN_USERNAME: "root",
      STRATA_ADMIN_PASSWORD_HASH: hash,
    });

    // Seeding happens in `start()`, which the test harness does not call, so drive it directly
    // through the same code path rather than duplicating the logic here.
    const { AuthStore } = await import("./auth.js");
    const store = new AuthStore(instance.dataDir, false);
    const result = await store.seedAdmin({
      username: "root",
      passwordHash: hash,
    });
    expect(result.action).toBe("created");
    expect(await store.needsSetup()).toBe(false);

    const cookie = await signIn(instance, "root", "seeded-password");
    expect(cookie).toBeTruthy();

    // And a second boot does not reset the password.
    const again = await store.seedAdmin({ username: "root", passwordHash: hash });
    expect(again.action).toBe("skipped");
  });

  it("sends security headers on every response", async () => {
    const instance = await boot();
    const response = await fetch(`${instance.url}/api/health`);

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not reflect an arbitrary origin", async () => {
    const instance = await boot();
    const response = await fetch(`${instance.url}/api/health`, {
      headers: { origin: "https://attacker.example" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reflects an origin the operator listed", async () => {
    const instance = await boot({ STRATA_ALLOWED_ORIGINS: "https://models.example" });
    const response = await fetch(`${instance.url}/api/health`, {
      headers: { origin: "https://models.example" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://models.example");
  });

  it("keeps the workspace path off the unauthenticated health route", async () => {
    const instance = await boot();
    const response = await fetch(`${instance.url}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toEqual({ ok: true });
  });

  it("gives every response a request id", async () => {
    const instance = await boot();
    const response = await fetch(`${instance.url}/api/health`);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------- export

describe("workspace export", () => {
  it("returns a gzip archive a viewer can take away", async () => {
    const instance = await boot();
    await createUser(instance, "vic", "password123", "viewer");
    const cookie = await signIn(instance, "vic", "password123");

    const response = await fetch(`${instance.url}/api/workspace/export`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toContain(".tgz");

    const body = Buffer.from(await response.arrayBuffer());
    // Gzip magic number. Proves an archive came back rather than a JSON error with a 200.
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    expect(body.length).toBeGreaterThan(100);
  });

  it("packs the files under a single named directory", async () => {
    const { collectEntries } = await import("./archive.js");
    const instance = await boot();

    const entries = await collectEntries(instance.workspace, "my-models-2026-08-29");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.name.startsWith("my-models-2026-08-29/")).toBe(true);
    }
    expect(entries.some((entry) => entry.name.endsWith("strata.config.yaml"))).toBe(true);
  });
});

// ---------------------------------------------------------------- audit log

describe("audit log", () => {
  it("records a sign-in and a failed sign-in", async () => {
    const instance = await boot();
    await createUser(instance, "ada", "password123", "admin");

    await fetch(`${instance.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "wrong" }),
    });
    const cookie = await signIn(instance, "ada", "password123");

    const response = await fetch(`${instance.url}/api/audit`, { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { entries: { action: string; ok: boolean }[] };
    expect(body.entries.some((entry) => entry.action === "auth.login" && entry.ok)).toBe(true);
    expect(body.entries.some((entry) => entry.action === "auth.login.failed")).toBe(true);
  });

  it("never writes a password into the log", async () => {
    const instance = await boot();
    await createUser(instance, "ada", "password123", "admin");

    await fetch(`${instance.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "hunter2-secret" }),
    });

    const raw = await readFile(join(instance.dataDir, "audit.jsonl"), "utf8").catch(() => "");
    expect(raw).not.toContain("hunter2-secret");
  });
});

// ---------------------------------------------------------------- hosted mode

/**
 * Hosted mode, where the repository is the workspace.
 *
 * The property under test throughout is containment. A hosted instance has its own workspace on
 * disk, the one an operator configured, and a visitor who has not chosen a repository must never
 * be served it. That is not a hypothetical: the same class of mistake is defect (1) in the header
 * of this file, and there it took a route audit to find.
 */
describe("cloud mode", () => {
  const CLOUD_ENV = {
    STRATA_CLOUD_CLIENT_ID: "test-client",
    STRATA_CLOUD_CLIENT_SECRET: "test-secret",
    STRATA_CLOUD_BASE_URL: "https://strata.test",
  };

  async function bootCloud() {
    const dir = await tenantDir();
    return boot({ ...CLOUD_ENV, STRATA_TENANT_DIR: dir });
  }

  it("refuses model routes to a caller with no workspace", async () => {
    const { url } = await bootCloud();

    for (const path of ["/api/models", "/api/objects", "/api/files", "/api/git/status"]) {
      const response = await fetch(`${url}${path}`);
      const body = await response.text();

      expect(response.status, `${path} should refuse`).toBe(401);
      // The real assertion. A 401 that still leaked the body would pass a status check.
      expect(body, `${path} leaked the instance workspace`).not.toContain("host_workspace");
    }
  });

  it("still answers the routes that have to work before sign-in", async () => {
    const { url } = await bootCloud();

    expect((await fetch(`${url}/api/health`)).status).toBe(200);

    const me = await fetch(`${url}/api/cloud/me`);
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({ cloud: true, user: null, repo: null });
  });

  it("sends people to GitHub with a state parameter it can check later", async () => {
    const { url } = await bootCloud();

    const response = await fetch(`${url}/api/cloud/login`, { redirect: "manual" });
    expect(response.status).toBe(302);

    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin).toBe("https://github.com");
    expect(target.searchParams.get("client_id")).toBe("test-client");
    expect(target.searchParams.get("state")).toBeTruthy();

    // The secret must never reach the browser, not even on a redirect it only passes through.
    expect(response.headers.get("location")).not.toContain("test-secret");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("strata_cloud_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("rejects a callback whose state was not issued to this browser", async () => {
    const { url } = await bootCloud();

    // A state we minted ourselves, with no matching cookie. This is the login CSRF: without the
    // cookie comparison it would sign the victim in as whoever owns the code.
    const start = await fetch(`${url}/api/cloud/login`, { redirect: "manual" });
    const stolen = new URL(start.headers.get("location") ?? "").searchParams.get("state");

    const response = await fetch(`${url}/api/cloud/callback?code=abc&state=${stolen}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a callback with no state at all", async () => {
    const { url } = await bootCloud();
    for (const query of ["", "?code=abc", "?state=nonsense", "?code=abc&state=nonsense"]) {
      expect((await fetch(`${url}/api/cloud/callback${query}`, { redirect: "manual" })).status).toBe(400);
    }
  });

  it("refuses the signed-in-only cloud routes without a session", async () => {
    const { url } = await bootCloud();

    expect((await fetch(`${url}/api/cloud/repos`)).status).toBe(401);

    const chosen = await fetch(`${url}/api/cloud/workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/models" }),
    });
    expect(chosen.status).toBe(401);
  });

  it("stays inert on a self-hosted instance", async () => {
    // No cloud configuration, so the mode must not switch on and must not start refusing
    // requests that a self-hosted deployment has always served.
    const { url } = await boot();

    await expect((await fetch(`${url}/api/cloud/me`)).json()).resolves.toEqual({
      cloud: false,
      user: null,
      repo: null,
    });
  });

  it("does not switch on without somewhere to put the workspaces", async () => {
    // Cloud credentials but no tenant directory would otherwise mean one shared workspace for
    // every customer, which is the failure this mode exists to prevent.
    const { url } = await boot(CLOUD_ENV);

    await expect((await fetch(`${url}/api/cloud/me`)).json()).resolves.toMatchObject({
      cloud: false,
    });
  });
});

/**
 * Configurations the server refuses to start with.
 *
 * One entry so far, and it earns its place: hosted sign-in plus `STRATA_AUTH=off` silently hands
 * read-only collaborators write access to somebody else's repository, because `requireRole`
 * short-circuits when auth is disabled. It is a plausible mistake rather than a contrived one,
 * since the anonymous trial deployment sets exactly that value and turning hosted mode on is a
 * matter of adding three variables to a service that already has it.
 */
describe("startup refusal", () => {
  async function refusalFor(env: Record<string, string | undefined>): Promise<string | undefined> {
    const { url } = await boot(env);
    // `boot` has already imported the module with this environment applied.
    const module = (await import("./index.js")) as { startupRefusal: () => string | undefined };
    expect(url).toBeTruthy();
    return module.startupRefusal();
  }

  const CLOUD = {
    STRATA_CLOUD_CLIENT_ID: "test-client",
    STRATA_CLOUD_CLIENT_SECRET: "test-secret",
    STRATA_CLOUD_BASE_URL: "https://strata.test",
  };

  it("refuses hosted sign-in with authorisation turned off", async () => {
    const dir = await tenantDir();
    const refusal = await refusalFor({ ...CLOUD, STRATA_TENANT_DIR: dir, STRATA_AUTH: "off" });

    expect(refusal).toBeDefined();
    expect(refusal).toContain("STRATA_AUTH");
  });

  it("allows hosted sign-in with authorisation on", async () => {
    const dir = await tenantDir();
    expect(
      await refusalFor({ ...CLOUD, STRATA_TENANT_DIR: dir, STRATA_AUTH: "on" }),
    ).toBeUndefined();
  });

  it("leaves the anonymous trial alone", async () => {
    // The trial runs with auth off on purpose: every visitor is alone in a scratch directory, so
    // there is nothing of anyone else's to reach. Only hosted mode makes that combination unsafe.
    const dir = await tenantDir();
    expect(await refusalFor({ STRATA_TENANT_DIR: dir, STRATA_AUTH: "off" })).toBeUndefined();
  });

  it("leaves a plain self-hosted instance alone", async () => {
    expect(await refusalFor({ STRATA_AUTH: "off" })).toBeUndefined();
  });
});

/**
 * Invitations, over HTTP.
 *
 * The unit tests cover what an invitation is. These cover what the routes refuse: an anonymous
 * caller must not be able to list or create them, and the redeem path must not leak whether a
 * token was ever real.
 */
describe("invitations", () => {
  async function signedInAdmin(url: string): Promise<string> {
    const response = await fetch(`${url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin-password" }),
    });
    expect(response.status).toBe(201);
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  it("keeps the admin routes closed to anonymous callers", async () => {
    const { url } = await boot();

    expect((await fetch(`${url}/api/invites`)).status).toBe(401);

    const created = await fetch(`${url}/api/invites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    expect(created.status).toBe(401);
  });

  it("returns a link with the token in the fragment", async () => {
    const { url } = await boot();
    const cookie = await signedInAdmin(url);

    const response = await fetch(`${url}/api/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "editor", username: "dana" }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { link: string; invite: { status: string } };
    expect(body.invite.status).toBe("pending");

    // A fragment is never sent to a server, so the token stays out of every access log
    // between the browser and this process.
    const [path, fragment] = body.link.split("#");
    expect(path).toMatch(/\/invite$/);
    expect(fragment).toBeTruthy();
  });

  it("lets an invitee redeem without an account, and signs them in", async () => {
    const { url } = await boot();
    const cookie = await signedInAdmin(url);

    const created = await fetch(`${url}/api/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "editor" }),
    });
    const token = ((await created.json()) as { link: string }).link.split("#")[1] ?? "";

    // No cookie on either call: an invitee is a stranger until this succeeds.
    const checked = await fetch(`${url}/api/invites/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(checked.status).toBe(200);
    await expect(checked.json()).resolves.toMatchObject({ role: "editor" });

    const accepted = await fetch(`${url}/api/invites/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, username: "dana", password: "chosen-by-dana" }),
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({ user: { role: "editor" } });
    expect(accepted.headers.get("set-cookie") ?? "").toContain("strata_session=");
  });

  it("answers a bad token the same way as a used one", async () => {
    const { url } = await boot();
    const cookie = await signedInAdmin(url);

    const created = await fetch(`${url}/api/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "viewer" }),
    });
    const token = ((await created.json()) as { link: string }).link.split("#")[1] ?? "";

    await fetch(`${url}/api/invites/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, username: "dana", password: "chosen-by-dana" }),
    });

    const used = await fetch(`${url}/api/invites/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const never = await fetch(`${url}/api/invites/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "never-issued" }),
    });

    // Identical, so guessing cannot confirm that a token was once real.
    expect(used.status).toBe(never.status);
    expect(await used.text()).toBe(await never.text());
  });
});

/**
 * Closing your own account.
 *
 * Separate from an administrator deleting somebody else, and the difference is the point: this
 * one is available to any signed-in user, takes its target from the session rather than the URL,
 * and still refuses to remove the last administrator.
 */
describe("closing your own account", () => {
  async function setup(url: string): Promise<string> {
    const r = await fetch(`${url}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin-password" }),
    });
    return r.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  async function addUser(url: string, cookie: string, username: string, role: string): Promise<string> {
    const r = await fetch(`${url}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username, password: "password-1234", role }),
    });
    expect(r.status).toBe(201);

    const signIn = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: "password-1234" }),
    });
    return signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  it("refuses an anonymous caller", async () => {
    const { url } = await boot();
    const response = await fetch(`${url}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(response.status).toBe(401);
  });

  it("lets a viewer close their own account", async () => {
    // The whole reason this route exists: `/api/users/:id` is admin-only, so without it somebody
    // with the lowest role cannot leave without asking an administrator to remove them.
    const { url } = await boot();
    const admin = await setup(url);
    const dana = await addUser(url, admin, "dana", "viewer");

    const closed = await fetch(`${url}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: dana },
      body: JSON.stringify({ username: "dana" }),
    });
    expect(closed.status).toBe(200);

    const remaining = (await (await fetch(`${url}/api/users`, { headers: { cookie: admin } })).json()) as {
      items: { username: string }[];
    };
    expect(remaining.items.map((u) => u.username)).toEqual(["admin"]);
  });

  it("requires the username typed back", async () => {
    const { url } = await boot();
    const admin = await setup(url);
    const dana = await addUser(url, admin, "dana", "editor");

    for (const body of [{}, { username: "" }, { username: "admin" }, { username: "dan" }]) {
      const response = await fetch(`${url}/api/account`, {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie: dana },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("cannot be pointed at somebody else", async () => {
    // The id comes from the session, so naming another user in the body deletes nothing.
    const { url } = await boot();
    const admin = await setup(url);
    const dana = await addUser(url, admin, "dana", "editor");

    const response = await fetch(`${url}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: dana },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(response.status).toBe(422);

    const users = (await (await fetch(`${url}/api/users`, { headers: { cookie: admin } })).json()) as {
      items: { username: string }[];
    };
    expect(users.items.map((u) => u.username).sort()).toEqual(["admin", "dana"]);
  });

  it("refuses to remove the last administrator", async () => {
    // Otherwise this screen is a way to lock everyone out of their own instance.
    const { url } = await boot();
    const admin = await setup(url);

    const response = await fetch(`${url}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(response.status).toBe(409);
  });

  it("allows an administrator to leave when another one remains", async () => {
    const { url } = await boot();
    const admin = await setup(url);
    await addUser(url, admin, "alex", "admin");

    const response = await fetch(`${url}/api/account`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: admin },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(response.status).toBe(200);
    // Signed out on the way, so the cookie cannot be reused against a deleted account.
    expect(response.headers.get("set-cookie") ?? "").toContain("strata_session=");
  });
});

/**
 * Partly configured hosted sign-in.
 *
 * The failure this catches is silence, not a crash: three of four variables set boots a working
 * self-hosted instance with no GitHub button and nothing explaining the absence.
 */
describe("cloud configuration warning", () => {
  async function warningFor(env: Record<string, string | undefined>): Promise<string | undefined> {
    const { url } = await boot(env);
    const module = (await import("./index.js")) as { cloudConfigWarning: () => string | undefined };
    expect(url).toBeTruthy();
    return module.cloudConfigWarning();
  }

  const CLOUD = {
    STRATA_CLOUD_CLIENT_ID: "cid",
    STRATA_CLOUD_CLIENT_SECRET: "secret",
    STRATA_CLOUD_BASE_URL: "https://strata.test",
  };

  it("says nothing on a plain self-hosted instance", async () => {
    // Nothing configured is the default, not a mistake.
    expect(await warningFor({})).toBeUndefined();
  });

  it("says nothing when all four are set", async () => {
    const dir = await tenantDir();
    expect(await warningFor({ ...CLOUD, STRATA_TENANT_DIR: dir })).toBeUndefined();
  });

  it("names STRATA_TENANT_DIR, the one that does not look like a cloud setting", async () => {
    const warning = await warningFor(CLOUD);
    expect(warning).toContain("STRATA_TENANT_DIR");
    expect(warning).toContain("hosted sign-in is OFF");
  });

  it("names a missing client secret", async () => {
    const dir = await tenantDir();
    const warning = await warningFor({
      STRATA_CLOUD_CLIENT_ID: "cid",
      STRATA_CLOUD_BASE_URL: "https://strata.test",
      STRATA_TENANT_DIR: dir,
    });
    expect(warning).toContain("STRATA_CLOUD_CLIENT_SECRET");
  });

  it("names every missing variable, not just the first", async () => {
    const warning = await warningFor({ STRATA_CLOUD_CLIENT_ID: "cid" });
    expect(warning).toContain("STRATA_CLOUD_CLIENT_SECRET");
    expect(warning).toContain("STRATA_CLOUD_BASE_URL");
    expect(warning).toContain("STRATA_TENANT_DIR");
  });

  it("does not warn about the anonymous trial", async () => {
    // Tenant directory set with no cloud variables is the trial, which is a deliberate shape.
    const dir = await tenantDir();
    expect(await warningFor({ STRATA_TENANT_DIR: dir, STRATA_AUTH: "off" })).toBeUndefined();
  });
});
