import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards on the things that only break when somebody self-hosts.
 *
 * Every assertion here corresponds to a defect found by walking a real first-run rather than by
 * reading the code, which is the point. A missing manifest, a credential the server reads and
 * nothing can write, an environment variable no deployment surface mentions: none of these fail a
 * type check, none fail a unit test, and all of them fail for the customer.
 */

/** Repo root, from this file's location. */
const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every non-test source file under `apps/server/src`, read as one string.
 *
 * A hardcoded list of files used to stand here, and splitting the server into modules is
 * exactly what it could not survive: the environment reads moved to `env.ts` and the credential
 * reads to `credentials.ts`, neither of which was on the list. Both audits below would have gone
 * on passing while checking a shrinking fraction of the server, which is the same silent
 * narrowing the route audit in `routes.test.ts` guards against.
 *
 * Walking the directory means a new module is covered the day somebody adds it, rather than the
 * day somebody remembers to list it.
 */
async function serverSources(): Promise<string> {
  const read = async (base: string): Promise<string[]> => {
    const entries = await readdir(base, { withFileTypes: true });
    const texts = await Promise.all(
      entries.map(async (entry) => {
        const path = join(base, entry.name);
        if (entry.isDirectory()) return (await read(path)).join("\n");
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return "";
        return readFile(path, "utf8");
      }),
    );
    return texts;
  };

  return (await read(join(ROOT, "apps", "server", "src"))).join("\n");
}

describe("the container build", () => {
  it("copies a manifest for every workspace package", async () => {
    /*
      The Dockerfile lists each `package.json` explicitly so the dependency-install layer caches
      independently of source. That means adding a package silently desynchronises it, pnpm
      tolerates the omission by creating a dangling symlink, so the build still succeeds and the
      list quietly stops describing the real graph.

      Found when `packages/query` was extracted and the list was not updated.
    */
    const dockerfile = await readFile(join(ROOT, "Dockerfile"), "utf8");
    const packages = (await readdir(join(ROOT, "packages"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(packages.length).toBeGreaterThan(0);
    for (const name of packages) {
      expect(dockerfile, `Dockerfile does not COPY packages/${name}/package.json`).toContain(
        `packages/${name}/package.json`,
      );
    }
  });
});

describe("configuration reachability", () => {
  it("gives every credential the server reads a way to be written", async () => {
    /*
      The defect this exists for: `gcpAuth()` read a `gcp.serviceAccount` secret, and the agent
      runner read `skills.apiKey`, but `secrets.set` was reachable only from the GitHub route and
      the integrations form, which writes `<provider>.<field>` for providers in the registry.

      Both features therefore worked in development, where an environment variable is easy, and
      were unreachable in a real deployment. Worse for BigQuery: the env fallback holds a token
      that expires in an hour, so env-only meant restarting the pod hourly.
    */
    const source = await serverSources();

    // Every `secrets.get("literal")` in the server, minus the ones a provider owns.
    const read = [...source.matchAll(/secrets\(\)\.get\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
    const capability = read.filter((name) => !name.startsWith("integration"));

    expect(capability.length).toBeGreaterThan(0);
    const allowList = await readFile(join(ROOT, "apps", "server", "src", "index.ts"), "utf8");

    for (const name of capability) {
      expect(
        allowList,
        `nothing can write the \`${name}\` secret; add it to CAPABILITY_SECRETS`,
      ).toContain(`"${name}"`);
    }
    // And the allow-list is what the write route is gated on.
    expect(allowList).toContain("CAPABILITY_SECRETS");
  });

  it("documents every environment variable somewhere an operator will look", async () => {
    /*
      A feature configured only by an undocumented environment variable is a feature no
      self-hoster will ever switch on. `extraEnv` in the Helm chart makes them *settable*, which
      is not the same as discoverable.
    */
    const source = await serverSources();
    const used = new Set([...source.matchAll(/process\.env\.(STRATA_[A-Z_]+)/g)].map((m) => m[1]!));

    const documented = [
      await readFile(join(ROOT, "docs", "SELF-HOSTING.md"), "utf8"),
      await readFile(join(ROOT, "docker-compose.yml"), "utf8"),
      await readFile(join(ROOT, "deploy", "helm", "strata", "values.yaml"), "utf8"),
    ].join("\n");

    const missing = [...used].filter((name) => !documented.includes(name)).sort();

    expect(missing, `undocumented environment variables: ${missing.join(", ")}`).toEqual([]);
  });
});
