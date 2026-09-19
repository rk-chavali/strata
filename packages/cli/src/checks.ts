import { lintNames, validate, type Diagnostic } from "@strata/metamodel";
import type { LoadedWorkspace } from "@strata/storage";

/**
 * The check pipeline, shared by `strata validate`, `strata lint` and `strata check`.
 *
 * Load diagnostics always come first and are never optional: if a file failed to
 * parse, every downstream finding is suspect, and reporting a hundred unresolved
 * references caused by one malformed file would bury the actual problem.
 */

export interface CheckOptions {
  /** Structural and referential integrity. */
  structural?: boolean;
  /** Naming standards. */
  naming?: boolean;
  /** Escalate warnings to errors. */
  strict?: boolean;
}

export function runChecks(workspace: LoadedWorkspace, options: CheckOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...workspace.diagnostics];

  const severities = workspace.config.lint.rules;
  const strict = options.strict ?? workspace.config.lint.strict;

  if (options.structural !== false) {
    diagnostics.push(...applyOverrides(validate(workspace.graph), severities, strict));
  }
  if (options.naming) {
    diagnostics.push(...lintNames(workspace.graph, { severities, strict }));
  }

  return sortDiagnostics(diagnostics);
}

/**
 * Apply per-rule severity overrides from config.
 *
 * Teams need this to adopt the tool against an existing estate: demote the rules
 * they cannot fix today, keep the gate on everything else, and ratchet up over
 * time. Without it the only options are a red pipeline or no pipeline.
 */
function applyOverrides(
  diagnostics: readonly Diagnostic[],
  severities: Record<string, "error" | "warning" | "info" | "off">,
  strict: boolean,
): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const override = severities[diagnostic.code];
    if (override === "off") continue;

    let severity = override ?? diagnostic.severity;
    if (strict && severity === "warning") severity = "error";
    result.push(severity === diagnostic.severity ? diagnostic : { ...diagnostic, severity });
  }
  return result;
}

/** Errors first, then by file, so the most important finding is at the top. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...diagnostics].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    const fileCompare = (a.file ?? "").localeCompare(b.file ?? "");
    if (fileCompare !== 0) return fileCompare;
    return (a.path ?? "").localeCompare(b.path ?? "");
  });
}
