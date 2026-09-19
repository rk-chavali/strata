/**
 * Parsed workspaces, cached per tenant, and the diagnostics computed over one.
 *
 * Pulled out of `index.ts` because almost every route begins with `await getWorkspace()`, and a
 * route module cannot import that from the file that imports the route module. The tenancy rule
 * in the comments below is the important part: the root is resolved from async context at the
 * moment of use, never captured, and the reason is a defect this codebase has already shipped.
 */
import { lintNames, validate, type Diagnostic } from "@strata/metamodel";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME } from "@strata/storage";
import { currentTenant } from "./tenancy.js";
import { WORKSPACE } from "./env.js";

/**
 * Parsed workspaces, keyed by root directory.
 *
 * A map rather than a single slot because a hosted deployment serves one workspace per visitor.
 * Single-tenant deployments simply never put more than one entry in it, so the behaviour there is
 * unchanged.
 */
export const cached = new Map<string, LoadedWorkspace>();

/**
 * How many parsed workspaces to keep.
 *
 * Bounded because a trial server accumulates visitors, and a parsed graph is not small, an
 * unbounded cache is a memory leak with a slow fuse. Least-recently-used is approximated by
 * insertion order, which `Map` preserves: good enough for a cache whose miss costs milliseconds.
 */
export const MAX_CACHED_WORKSPACES = 32;

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
export function workspaceRoot(): string {
  return currentTenant()?.root ?? WORKSPACE;
}

/**
 * The workspace for the current request.
 *
 * Reads the tenant from async context rather than taking it as an argument. There are sixty-one
 * call sites, and threading an id through all of them would have exactly one failure mode, * a missed call site quietly reading another tenant's model. Resolving it here means no call site
 * *can* be wrong.
 */
export async function getWorkspace(force = false): Promise<LoadedWorkspace> {
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
export async function refresh(): Promise<LoadedWorkspace> {
  return getWorkspace(true);
}

export function allDiagnostics(workspace: LoadedWorkspace): Diagnostic[] {
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
 * Whether this instance has a model repo yet.
 *
 * The presence of the config file is the definition of a workspace, the loader globs for
 * content and infers nothing from paths, so `strata.config.yaml` is the only thing that
 * distinguishes a model repo from an arbitrary directory.
 */
export function workspaceExists(): boolean {
  return existsSync(join(workspaceRoot(), CONFIG_FILENAME));
}
