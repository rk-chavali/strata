import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenantStore, currentTenant, isTenantId, runInTenant } from "./tenancy.js";

/**
 * Tenant isolation.
 *
 * This is the security boundary of the hosted mode: one visitor reading another's model is the
 * failure that ends the product. So the tests are mostly adversarial, forged signatures, guessed
 * ids, path traversal, and they assert the *specific* safe outcome rather than merely "not a
 * crash".
 */

let base: string;
let seed: string;
let store: TenantStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "strata-tenants-"));
  seed = await mkdtemp(join(tmpdir(), "strata-seed-"));

  await writeFile(join(seed, "strata.config.yaml"), `version: 1\nname: starter\nroots:\n  - "."\n`);
  await mkdir(join(seed, "models"), { recursive: true });
  await writeFile(join(seed, "models", "m.yaml"), `id: mdl\nkind: model\nname: warehouse\ntier: physical\n`);
  // A .git directory that must never be copied into a tenant.
  await mkdir(join(seed, ".git"), { recursive: true });
  await writeFile(join(seed, ".git", "config"), "[remote \"origin\"]\n  url = git@example.com:acme/private.git\n");

  store = new TenantStore({ base, secret: "test-secret", ttlMs: 1000 });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
  await rm(seed, { recursive: true, force: true }).catch(() => {});
});

describe("creating a workspace", () => {
  it("gives each visitor their own directory", async () => {
    const a = await store.create();
    const b = await store.create();

    expect(a.id).not.toBe(b.id);
    expect(a.root).not.toBe(b.root);
    expect((await stat(a.root)).isDirectory()).toBe(true);
  });

  it("seeds a loadable workspace when given nothing", async () => {
    // A bare directory would strand the visitor on "needs init" before they have seen anything.
    const tenant = await store.create();
    const config = await readFile(join(tenant.root, "strata.config.yaml"), "utf8");
    expect(config).toContain("version: 1");
  });

  it("copies the seed workspace", async () => {
    const tenant = await store.create(seed);
    expect(await readFile(join(tenant.root, "models", "m.yaml"), "utf8")).toContain("warehouse");
  });

  it("never copies the seed's .git directory", async () => {
    /*
      The seed is a real checkout with a real remote. Copying `.git` would point every trial
      workspace at the same repository, so the first visitor who pressed Propose would open a
      pull request against somebody else's repo.
    */
    const tenant = await store.create(seed);
    await expect(stat(join(tenant.root, ".git"))).rejects.toThrow();
  });
});

describe("cookies", () => {
  it("round-trips a signed id", async () => {
    const tenant = await store.create();
    expect(store.parse(store.sign(tenant.id))).toBe(tenant.id);
  });

  it("rejects an unsigned id", async () => {
    // Ids are visible in directory listings and logs; possession of one must prove nothing.
    const tenant = await store.create();
    expect(store.parse(tenant.id)).toBeUndefined();
  });

  it("rejects a forged signature", async () => {
    const tenant = await store.create();
    expect(store.parse(`${tenant.id}.deadbeefdeadbeefdeadbeefdeadbeef`)).toBeUndefined();
  });

  it("rejects a signature made with a different secret", async () => {
    const tenant = await store.create();
    const attacker = new TenantStore({ base, secret: "not-the-secret" });
    expect(store.parse(attacker.sign(tenant.id))).toBeUndefined();
  });

  it("rejects a path traversal in the id", async () => {
    expect(store.parse("../../etc.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeUndefined();
    expect(isTenantId("../../etc")).toBe(false);
  });

  it("refuses to resolve a directory outside the base", () => {
    // Defence in depth: ids are generated and signed, but a future caller might not be.
    expect(() => store.rootFor("../escape")).toThrow(/invalid tenant id/);
  });
});

describe("async context", () => {
  it("keeps tenants separate across concurrent work", async () => {
    /*
      The property the whole design rests on: `getWorkspace()` reads the tenant from context, so
      two requests in flight must never observe each other's. Interleaved awaits here would catch
      a context that leaked between tasks.
    */
    const a = await store.create();
    const b = await store.create();

    const seen: string[] = [];
    const observe = async (label: string): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(`${label}:${currentTenant()?.id ?? "none"}`);
    };

    await Promise.all([
      runInTenant(a, () => observe("a")),
      runInTenant(b, () => observe("b")),
    ]);

    expect(seen.sort()).toEqual([`a:${a.id}`, `b:${b.id}`].sort());
  });

  it("has no tenant outside a tenant scope", () => {
    // Single-tenant deployments rely on this: no context means "use the configured workspace".
    expect(currentTenant()).toBeUndefined();
  });
});

describe("expiry", () => {
  it("removes a workspace older than the TTL", async () => {
    const tenant = await store.create();

    // Backdate it well past the 1s TTL.
    const old = new Date(Date.now() - 60_000);
    await utimes(tenant.root, old, old);

    expect(await store.expire()).toEqual([tenant.id]);
    expect(await store.exists(tenant.id)).toBe(false);
  });

  it("leaves a workspace someone is still using", async () => {
    /*
      Expiry is on modification time, not creation time. A visitor mid-session keeps writing
      files, so mtime is a liveness signal, expiring on age would delete work in progress.
    */
    const tenant = await store.create();
    expect(await store.expire()).toEqual([]);
    expect(await store.exists(tenant.id)).toBe(true);
  });

  it("does nothing when expiry is disabled", async () => {
    const forever = new TenantStore({ base, secret: "s", ttlMs: 0 });
    const tenant = await forever.create();
    const old = new Date(Date.now() - 60_000);
    await utimes(tenant.root, old, old);

    expect(await forever.expire()).toEqual([]);
    expect(await forever.exists(tenant.id)).toBe(true);
  });
});
