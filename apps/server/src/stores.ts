import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AuditLog } from "./audit.js";
import { DeliveryLog } from "./deliveries.js";
import { Presence } from "./presence.js";
import { SecretStore } from "./secrets.js";
import { currentTenant, isTenantId } from "./tenancy.js";

/**
 * Instance state, resolved per tenant.
 *
 * Tenancy originally partitioned exactly one thing: the workspace directory. Everything else --
 * stored credentials, the delivery log, presence, and now the audit log -- was constructed once
 * against `STRATA_DATA_DIR` and shared by every visitor. In single-tenant self-hosting that is
 * correct and nothing changes. In a hosted deployment it meant one visitor could see that another
 * had configured a provider key, read its last four characters, and trigger a dispatch that ran
 * on somebody else's credential.
 *
 * **Same shape as the workspace, deliberately.** `getWorkspace()` reads the tenant out of async
 * context and returns the right directory. These do the same, through the same mechanism, so
 * there is one rule to remember rather than two: *nothing that holds state takes its directory
 * from a module constant.*
 *
 * **One subdirectory per tenant, under the data directory.** `<STRATA_DATA_DIR>/tenants/<id>`. The
 * stores themselves are unchanged: each already takes a directory in its constructor, so this is
 * a resolver rather than a rewrite, and the single-tenant path still hands them the same
 * directory they have always used.
 *
 * **Accounts stay global on purpose.** `AuthStore` is not in here. A hosted trial has no accounts
 * -- visitors are anonymous and identified by a signed workspace cookie -- and the session
 * signing secret has to be one value or every tenant cookie breaks on the next request. Splitting
 * it would create a per-tenant user database nothing populates.
 */

/**
 * How many tenants keep their state in memory.
 *
 * Matches the workspace cache bound, and for the same reason: a hosted instance accumulates
 * visitors, and an unbounded cache is a memory leak with a slow fuse. A parsed workspace is the
 * expensive thing; these four objects are a path and a lazy file read, so the bound can be
 * generous without costing anything.
 */
const MAX_CACHED_TENANTS = 64;

export class Stores {
  private readonly secretStores = new Map<string, SecretStore>();
  private readonly deliveryLogs = new Map<string, DeliveryLog>();
  private readonly auditLogs = new Map<string, AuditLog>();
  private readonly presences = new Map<string, Presence>();

  constructor(private readonly baseDataDir: string) {}

  /**
   * The data directory for a tenant, with containment enforced.
   *
   * Tenant ids are generated and signed, so a hostile id should never reach here. The check is
   * present anyway, for the same reason `TenantStore.rootFor` has one: it costs a comparison, and
   * a future code path that resolves an id from somewhere else would otherwise inherit a path
   * traversal into the directory holding every tenant's encrypted credentials.
   */
  dataDirFor(tenantId: string | undefined): string {
    if (!tenantId) return this.baseDataDir;
    if (!isTenantId(tenantId)) throw new Error("invalid tenant id");

    const base = resolve(this.baseDataDir, "tenants");
    const dir = resolve(base, tenantId);
    if (!dir.startsWith(base + sep)) throw new Error("tenant data path escapes the base directory");
    return dir;
  }

  /** Key for the per-tenant caches. The empty string is the single-tenant case. */
  private key(): string {
    return currentTenant()?.id ?? "";
  }

  private resolveStore<T>(cache: Map<string, T>, build: (dir: string) => T): T {
    const key = this.key();
    const hit = cache.get(key);
    if (hit) {
      // Re-insert so recently used keys move to the end. `Map` preserves insertion order, which
      // is how eviction below approximates least-recently-used without a second structure.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }

    const made = build(this.dataDirFor(key || undefined));
    cache.set(key, made);
    this.evict();
    return made;
  }

  /**
   * Keep the in-memory caches bounded.
   *
   * Four maps keyed by tenant, and nothing was trimming them. Expiry sweeps hourly and deletes
   * directories, but a visitor who arrives and leaves between two sweeps left four objects behind
   * for good, and with `STRATA_TENANT_TTL_MS=0` nothing was ever removed at all. On a public demo
   * that is a slow memory leak with a queue of strangers feeding it.
   *
   * These objects are cheap to rebuild: each one is a directory path and a lazy file read. So
   * evicting is nearly free, which is why the bound can be low.
   *
   * **A tenant with an open event stream is never evicted.** `Presence` holds the response objects
   * for connected clients, and throwing it away would leave those browsers attached to something
   * nothing writes to again. That presents as live updates silently stopping, which is worse than
   * holding a few kilobytes longer than necessary.
   */
  private evict(): void {
    const keys = [...this.secretStores.keys()];
    if (keys.length <= MAX_CACHED_TENANTS) return;

    for (const key of keys) {
      if (this.secretStores.size <= MAX_CACHED_TENANTS) break;
      if (key === "") continue; // never the single-tenant entry
      if ((this.presences.get(key)?.connectionCount ?? 0) > 0) continue;

      this.secretStores.delete(key);
      this.deliveryLogs.delete(key);
      this.auditLogs.delete(key);
      this.presences.delete(key);
    }
  }

  secrets(): SecretStore {
    return this.resolveStore(this.secretStores, (dir) => new SecretStore(dir));
  }

  deliveries(): DeliveryLog {
    return this.resolveStore(this.deliveryLogs, (dir) => new DeliveryLog(dir));
  }

  audit(): AuditLog {
    return this.resolveStore(this.auditLogs, (dir) => new AuditLog(dir));
  }

  /**
   * Presence for the current tenant.
   *
   * In memory rather than on disk, so this ignores the directory entirely and keys on the tenant
   * alone. One instance per tenant means a visitor's peer list and advisory locks contain only
   * their own session, which is the whole point: seeing a stranger's cursor on your model would
   * be a more visible leak than the credential one.
   *
   * The sweeper timer inside `Presence` starts on the first connection and stops when the last
   * one closes, so an idle tenant's instance holds no timer.
   */
  presence(): Presence {
    const key = this.key();
    const hit = this.presences.get(key);
    if (hit) return hit;

    const made = new Presence();
    this.presences.set(key, made);
    return made;
  }

  /**
   * Forget a tenant, and delete its data directory.
   *
   * Called when `TenantStore.expire` removes a workspace. Without this the encrypted credentials
   * of an expired trial would outlive the models they belonged to, which is exactly backwards:
   * the models are the part somebody might want back, and the credentials are the part that
   * should not linger.
   */
  async dispose(tenantId: string): Promise<void> {
    this.secretStores.delete(tenantId);
    this.deliveryLogs.delete(tenantId);
    this.auditLogs.delete(tenantId);
    this.presences.delete(tenantId);

    try {
      await rm(this.dataDirFor(tenantId), { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(
        `could not remove tenant data for ${tenantId}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /** Every tenant with state in memory. For the health detail route. */
  get trackedTenants(): number {
    return this.secretStores.size;
  }
}

/** Where a tenant's data directory sits, as a path fragment. Exported for the tests. */
export function tenantDataPath(baseDataDir: string, tenantId: string): string {
  return join(baseDataDir, "tenants", tenantId);
}
