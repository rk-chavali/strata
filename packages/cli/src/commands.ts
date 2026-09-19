import { relative, resolve } from "node:path";
import { OBJECT_KINDS, WORKSPACE_SCOPED_KINDS, type ObjectKind } from "@strata/metamodel";
import {
  CONFIG_FILENAME,
  LAYOUT_PRESETS,
  initWorkspace,
  loadWorkspace,
  planWrites,
  setLayoutPreset,
  applyWrites,
  type LayoutPreset,
  type LoadedWorkspace,
} from "@strata/storage";
import { runChecks } from "./checks.js";
import {
  detail,
  failure,
  formatDiagnostics,
  formatSummaryLine,
  heading,
  info,
  shouldFail,
  success,
  summarize,
  type OutputFormat,
} from "./reporter.js";

/** Exit codes: 0 clean, 1 findings, 2 usage or internal failure. */
export const EXIT = { ok: 0, findings: 1, failure: 2 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface InitArgs {
  directory: string;
  name?: string;
  preset?: LayoutPreset;
}

export async function commandInit(args: InitArgs): Promise<ExitCode> {
  const root = resolve(args.directory);
  const name = args.name ?? basename(root);

  const path = await initWorkspace(root, {
    name,
    ...(args.preset ? { preset: args.preset } : {}),
  });

  success(`created ${path}`);
  detail(`workspace \`${name}\`, layout \`${args.preset ?? "by-model-and-kind"}\``);
  info("");
  info("Next: add a model, then run `strata check`.");
  return EXIT.ok;
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "models";
}

export interface CheckArgs {
  cwd: string;
  format: OutputFormat;
  strict: boolean;
  /** Run structural validation. */
  structural: boolean;
  /** Run naming standards linting. */
  naming: boolean;
}

export async function commandCheck(args: CheckArgs): Promise<ExitCode> {
  const workspace = await loadWorkspace(args.cwd);
  const diagnostics = runChecks(workspace, {
    structural: args.structural,
    naming: args.naming,
    strict: args.strict,
  });

  const output = formatDiagnostics(diagnostics, args.format);
  if (output) info(output);

  return shouldFail(diagnostics, args.strict || workspace.config.lint.strict)
    ? EXIT.findings
    : EXIT.ok;
}

export interface FormatArgs {
  cwd: string;
  /** Report files that are not canonical without rewriting them. */
  checkOnly: boolean;
}

/**
 * Rewrite every file in canonical form at the *current* layout.
 *
 * `--check` makes this a CI gate. That matters more than it sounds: if canonical
 * form is enforced, every diff a reviewer sees is a real modelling change rather
 * than an artefact of whichever editor last touched the file.
 */
export async function commandFormat(args: FormatArgs): Promise<ExitCode> {
  const workspace = await loadWorkspace(args.cwd);
  if (blockedByLoadErrors(workspace)) return EXIT.failure;

  const plan = planWrites(workspace);
  const result = await applyWrites(workspace, plan, { dryRun: args.checkOnly });

  if (args.checkOnly) {
    if (result.written.length === 0 && result.deleted.length === 0) {
      success("all files are in canonical form");
      return EXIT.ok;
    }
    heading(`${result.written.length + result.deleted.length} file(s) are not in canonical form:`);
    for (const path of result.written) info(`  ${path}`);
    for (const path of result.deleted) info(`  ${path} (would be removed)`);
    info("");
    detail("run `strata fmt` to fix");
    return EXIT.findings;
  }

  if (result.written.length === 0 && result.deleted.length === 0) {
    success("nothing to do, already canonical");
    return EXIT.ok;
  }
  for (const path of result.written) info(`  wrote   ${path}`);
  for (const path of result.deleted) info(`  removed ${path}`);
  success(`${result.written.length} written, ${result.deleted.length} removed, ${result.unchanged.length} unchanged`);
  return EXIT.ok;
}

export interface ReorganizeArgs {
  cwd: string;
  preset?: LayoutPreset;
  dryRun: boolean;
}

/**
 * Move every file to the layout implied by the configuration.
 *
 * This command is the payoff of storing identity in file contents rather than
 * paths: reorganising the entire repo is a pure file move, and the resulting
 * commit contains no semantic change whatsoever.
 */
export async function commandReorganize(args: ReorganizeArgs): Promise<ExitCode> {
  const workspace = await loadWorkspace(args.cwd);
  if (blockedByLoadErrors(workspace)) return EXIT.failure;

  // Persisting the preset is deliberate: leaving it unsaved would mean the next
  // `strata fmt` silently moved everything back.
  if (args.preset && !args.dryRun) {
    await setLayoutPreset(workspace.root, args.preset);
  }
  const effective: LoadedWorkspace = args.preset
    ? { ...workspace, config: { ...workspace.config, layout: { ...workspace.config.layout, preset: args.preset } } }
    : workspace;

  const plan = planWrites(effective);
  if (plan.moves.length === 0) {
    success(`already organised as \`${effective.config.layout.preset}\``);
    return EXIT.ok;
  }

  heading(`${plan.moves.length} object(s) move under layout \`${effective.config.layout.preset}\`:`);
  for (const move of plan.moves.slice(0, 50)) {
    info(`  ${move.from}`);
    info(`    -> ${move.to}   ${dim(move.name)}`);
  }
  if (plan.moves.length > 50) detail(`  ... and ${plan.moves.length - 50} more`);
  info("");

  if (args.dryRun) {
    detail("dry run, nothing written");
    return EXIT.ok;
  }

  const result = await applyWrites(effective, plan);
  success(`${result.written.length} written, ${result.deleted.length} removed`);
  detail("commit this separately from semantic changes so the diff stays reviewable");
  return EXIT.ok;
}

function dim(text: string): string {
  return `(${text})`;
}

export interface InfoArgs {
  cwd: string;
  format: OutputFormat;
}

export async function commandInfo(args: InfoArgs): Promise<ExitCode> {
  const workspace = await loadWorkspace(args.cwd);
  const summary = buildSummary(workspace);

  if (args.format === "json") {
    info(JSON.stringify(summary, null, 2));
    return EXIT.ok;
  }

  heading(summary.name);
  detail(`${CONFIG_FILENAME} in ${workspace.root}`);
  info("");
  info(
    `layout  ${summary.layout}          files ${summary.fileCount}          objects ${summary.objectCount}`,
  );

  if (summary.models.length > 0) {
    info("");
    heading("MODELS");
    for (const model of summary.models) {
      const breakdown = Object.entries(model.counts)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ");
      info(`  ${model.name.padEnd(20)} ${model.tier.padEnd(11)} ${breakdown || "empty"}`);
    }
  }

  if (Object.keys(summary.shared).length > 0) {
    info("");
    heading("SHARED");
    info(
      `  ${Object.entries(summary.shared)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ")}`,
    );
  }

  if (summary.dataform.length > 0) {
    info("");
    heading("DATAFORM");
    for (const connection of summary.dataform) {
      info(`  ${connection.name.padEnd(20)} ${connection.target}`);
    }
  }

  if (summary.diagnosticCount > 0) {
    info("");
    detail(`${summary.diagnosticCount} file(s) failed to load, run \`strata check\` for detail`);
  }

  info("");
  detail(formatSummaryLine(summarize(workspace.diagnostics)));
  return EXIT.ok;
}

interface WorkspaceSummary {
  name: string;
  layout: string;
  fileCount: number;
  objectCount: number;
  models: { name: string; tier: string; counts: Partial<Record<ObjectKind, number>> }[];
  shared: Partial<Record<ObjectKind, number>>;
  dataform: { name: string; target: string }[];
  diagnosticCount: number;
}

function buildSummary(workspace: LoadedWorkspace): WorkspaceSummary {
  const models = workspace.graph.models().map((entry) => {
    const counts: Partial<Record<ObjectKind, number>> = {};
    for (const member of workspace.graph.inModel(entry.object.name)) {
      counts[member.object.kind] = (counts[member.object.kind] ?? 0) + 1;
    }
    return { name: entry.object.name, tier: entry.object.tier, counts };
  });

  // Only objects with no model are genuinely shared; one that names a model is
  // already counted under that model above.
  const shared: Partial<Record<ObjectKind, number>> = {};
  for (const entry of workspace.graph.all()) {
    if (!WORKSPACE_SCOPED_KINDS.has(entry.object.kind) || entry.object.model) continue;
    shared[entry.object.kind] = (shared[entry.object.kind] ?? 0) + 1;
  }

  return {
    name: workspace.config.name,
    layout: workspace.config.layout.preset,
    fileCount: workspace.filesByPath.size,
    objectCount: workspace.graph.all().length,
    models: models.sort((a, b) => a.name.localeCompare(b.name)),
    shared,
    dataform: workspace.config.dataform.map((connection) => ({
      name: connection.name,
      target: connection.gcp
        ? `${connection.gcp.project}/${connection.gcp.location}/${connection.gcp.repository}`
        : (connection.remote ?? connection.path ?? "<not configured>"),
    })),
    diagnosticCount: new Set(workspace.diagnostics.map((d) => d.file).filter(Boolean)).size,
  };
}

/**
 * Refuse to rewrite files when some failed to load.
 *
 * Writing the graph back out while part of it is missing would delete the
 * unparseable files' objects. Better to stop and say so.
 */
function blockedByLoadErrors(workspace: LoadedWorkspace): boolean {
  const errors = workspace.diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return false;

  failure(`${errors.length} file(s) could not be loaded; refusing to rewrite the repo`);
  for (const diagnostic of errors.slice(0, 10)) {
    info(`  ${diagnostic.file ?? "<unknown>"}  ${diagnostic.message}`);
  }
  info("");
  detail("fix these first, or run `strata check` for the full list");
  return true;
}

/** Values accepted by `--preset`, for help text and validation. */
export const PRESET_NAMES = LAYOUT_PRESETS;
/** Object kinds, for help text. */
export const KIND_NAMES = OBJECT_KINDS;

export function relativeToCwd(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === "" ? "." : rel.split("\\").join("/");
}
