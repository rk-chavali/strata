import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * One workspace per visitor, for the hosted trial.
 *
 * Self-hosted strata serves exactly one model repository: the operator mounts it, and every request
 * refers to the same thing. A hosted trial cannot work that way, the first visitor would be
 * editing the same model as the second, which is not a trial but a public wiki.
 *
 * **The tenant travels in async context, not in a parameter.** `getWorkspace()` is called from
 * sixty-one places, and threading a tenant id through all of them would be a large diff whose
 * only failure mode is silent: one missed call site reads the wrong tenant's model. Async context
 * is set once by middleware and read once by the loader, so there is no call site that *can* be
 * wrong.
 *
 * **Single-tenant remains the default and is untouched.** With no tenant in context, callers get
 * the configured workspace exactly as before. Multi-tenancy is opt-in for the deployment, which
 * keeps the self-hosted story, one container, one repo, no database, completely intact.
 */

export interface Tenant {
  /** Opaque id. Also the directory name, so it must be filesystem-safe. */
  id: string;
  /** Absolute path to this tenant's workspace. */
  root: string;
  createdAt: string;
}

const storage = new AsyncLocalStorage<Tenant>();

/** Run `fn` with this tenant in context. Everything it awaits sees the same tenant. */
export function runInTenant<T>(tenant: Tenant, fn: () => Promise<T>): Promise<T> {
  return storage.run(tenant, fn);
}

/** The tenant for the current request, or `undefined` in single-tenant mode. */
export function currentTenant(): Tenant | undefined {
  return storage.getStore();
}

/**
 * Tenant ids are generated, never accepted from the client verbatim.
 *
 * The id becomes a directory name, so a client-supplied `../../etc` would be a path escape and a
 * client-supplied *other* id would be a straight read of somebody else's model. Both are closed
 * by generating the id here and signing it, see `TenantStore.parse`.
 */
const ID_PATTERN = /^[a-f0-9]{24}$/;

export function isTenantId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export interface TenantStoreOptions {
  /** Directory holding one subdirectory per tenant. */
  base: string;
  /** Secret used to sign tenant cookies. */
  secret: string;
  /** Delete a tenant's workspace after this long. `0` disables expiry. */
  ttlMs?: number;
}

/**
 * Creates, resolves and expires tenant workspaces.
 *
 * Deliberately filesystem-backed rather than database-backed. A trial workspace is a directory of
 * YAML files, which is exactly what the rest of the product already reads and writes, introducing
 * a storage abstraction here would mean two code paths for loading a model, and the one used only
 * in the hosted mode would be the one that rots.
 */
export class TenantStore {
  private readonly base: string;
  private readonly secret: string;
  private readonly ttlMs: number;

  constructor(options: TenantStoreOptions) {
    this.base = resolve(options.base);
    this.secret = options.secret;
    this.ttlMs = options.ttlMs ?? 0;
  }

  /** Create a workspace for a new visitor, seeded from `seedFrom` when given. */
  async create(seedFrom?: string): Promise<Tenant> {
    const id = randomBytes(12).toString("hex");
    const root = this.rootFor(id);

    await mkdir(root, { recursive: true });

    if (seedFrom) {
      await copyTree(resolve(seedFrom), root);
    } else {
      /*
        A workspace with no config is not loadable, so a bare directory would strand the visitor
        on the "needs init" screen before they have seen anything. Seeding a minimal config means
        the trial opens on an empty but working model.
      */
      await writeFile(
        join(root, "strata.config.yaml"),
        `version: 1\nname: my-models\nroots:\n  - "."\n`,
        "utf8",
      );
    }

    return { id, root, createdAt: new Date().toISOString() };
  }

  /**
   * The directory for a tenant, with containment enforced.
   *
   * Even though ids are generated and signed, the join is checked: defence in depth costs one
   * comparison, and a future code path that resolves an id from somewhere else would otherwise
   * inherit a path traversal.
   */
  rootFor(id: string): string {
    if (!isTenantId(id)) throw new Error("invalid tenant id");

    const root = resolve(this.base, id);
    if (root !== this.base && !root.startsWith(this.base + sep)) {
      throw new Error("tenant path escapes the base directory");
    }
    return root;
  }

  /** Whether this tenant's workspace still exists on disk. */
  async exists(id: string): Promise<boolean> {
    try {
      return (await stat(this.rootFor(id))).isDirectory();
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- cookies

  /**
   * `<id>.<signature>`, signed so a visitor cannot claim another tenant's workspace.
   *
   * Signed rather than encrypted: the id is not a secret, and the only property needed is that it
   * cannot be *changed*. HMAC gives exactly that and nothing more.
   */
  sign(id: string): string {
    return `${id}.${this.mac(id)}`;
  }

  /** Verify a cookie value and return the id, or `undefined` if it was tampered with. */
  parse(value: string | undefined): string | undefined {
    if (!value) return undefined;

    const dot = value.lastIndexOf(".");
    if (dot <= 0) return undefined;

    const id = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    if (!isTenantId(id)) return undefined;

    const expected = this.mac(id);
    // Constant-time, so the comparison does not leak the signature a byte at a time.
    if (signature.length !== expected.length) return undefined;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;

    return id;
  }

  private mac(id: string): string {
    return createHmac("sha256", this.secret).update(id).digest("hex").slice(0, 32);
  }

  // ---------------------------------------------------------------- expiry

  /**
   * Delete workspaces older than the TTL.
   *
   * A trial that never expires is a disk that fills up, and on a free tier that is an outage.
   * Returns the ids removed so the caller can log them, silently deleting somebody's work, even
   * expired trial work, should at least be visible in the record.
   */
  async expire(now = Date.now()): Promise<string[]> {
    if (this.ttlMs <= 0) return [];

    let entries: string[];
    try {
      entries = await readdir(this.base);
    } catch {
      return [];
    }

    const removed: string[] = [];
    for (const id of entries) {
      if (!isTenantId(id)) continue;

      try {
        const info = await stat(this.rootFor(id));
        /*
          Modification time, not creation time.

          An active visitor keeps writing files, so mtime is a liveness signal, expiring on
          creation time would delete the workspace of somebody in the middle of using it.
        */
        if (now - info.mtimeMs > this.ttlMs) {
          await rm(this.rootFor(id), { recursive: true, force: true });
          removed.push(id);
        }
      } catch {
        continue;
      }
    }

    return removed;
  }
}

/**
 * Copy a directory tree, skipping anything that is not model content.
 *
 * `.git` is skipped deliberately: a seeded trial workspace should not inherit the example's
 * history or, much worse, its remote, which would point every trial at the same repository.
 */
async function copyTree(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;

    const source = join(from, entry.name);
    const target = join(to, entry.name);

    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, target);
    } else if (entry.isFile()) {
      const { readFile } = await import("node:fs/promises");
      await writeFile(target, await readFile(source));
    }
  }
}
