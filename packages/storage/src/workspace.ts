import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";
import {
  ObjectGraph,
  OBJECT_KINDS,
  parseObject,
  type AnyObject,
  type Diagnostic,
  type ObjectKind,
} from "@strata/metamodel";
import {
  CONFIG_FILENAME,
  DEFAULT_IGNORE,
  parseWorkspaceConfig,
  type WorkspaceConfig,
} from "./config.js";
import { LayoutEngine, type LayoutContext } from "./layout.js";
import {
  looksLikeModelObject,
  parseYamlFile,
  serializeDocuments,
  serializeObject,
} from "./serialize.js";

/**
 * Loading and saving a model repo.
 *
 * Reads are layout-blind by design: we glob for YAML, and every object declares
 * its own `kind`, `id` and owning `model`. Nothing is inferred from the path. The
 * layout engine is consulted only when deciding where to *write*, which is what
 * makes reorganising the repo a no-op semantically, see `layout.ts`.
 */

export interface LoadedWorkspace {
  /** Absolute path to the repo root. */
  root: string;
  config: WorkspaceConfig;
  graph: ObjectGraph;
  /** Parse-time findings: malformed YAML, invalid objects, unknown kinds. */
  diagnostics: Diagnostic[];
  /** Which objects came from which file, so we can write back and detect moves. */
  filesByPath: Map<string, AnyObject[]>;
  /** Reverse index: object id to the file it was loaded from. */
  pathById: Map<string, string>;
}

export class WorkspaceNotFoundError extends Error {
  constructor(root: string) {
    super(`no ${CONFIG_FILENAME} found in ${root} or any parent directory`);
    this.name = "WorkspaceNotFoundError";
  }
}

/** Walk up from `start` looking for the workspace config. */
export async function findWorkspaceRoot(start: string): Promise<string> {
  let current = resolve(start);
  for (;;) {
    try {
      await readFile(join(current, CONFIG_FILENAME), "utf8");
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new WorkspaceNotFoundError(start);
      current = parent;
    }
  }
}

export async function loadWorkspace(startPath: string): Promise<LoadedWorkspace> {
  const root = await findWorkspaceRoot(startPath);
  const configText = await readFile(join(root, CONFIG_FILENAME), "utf8");
  const configDocs = parseYamlFile(configText);

  if (configDocs.errors.length > 0) {
    const first = configDocs.errors[0]!;
    throw new Error(`${CONFIG_FILENAME} is not valid YAML (line ${first.line}): ${first.message}`);
  }
  const config = parseWorkspaceConfig(configDocs.documents[0]?.value ?? {});

  const diagnostics: Diagnostic[] = [];
  const filesByPath = new Map<string, AnyObject[]>();
  const pathById = new Map<string, string>();
  const entries: { object: AnyObject; file: string }[] = [];

  for (const file of await discoverFiles(root, config)) {
    const text = await readFile(join(root, file), "utf8");
    const parsed = parseYamlFile(text);

    for (const error of parsed.errors) {
      diagnostics.push({
        severity: "error",
        code: "yaml/syntax",
        message: error.message,
        file,
        path: `line ${error.line}`,
      });
    }

    for (const doc of parsed.documents) {
      if (!looksLikeModelObject(doc.value)) continue;

      const result = parseObject(doc.value);
      if (!result.object) {
        diagnostics.push({
          severity: "error",
          code: "object/invalid",
          message: result.error ?? "object failed validation",
          file,
          path: `line ${doc.line}`,
        });
        continue;
      }

      entries.push({ object: result.object, file });
      const bucket = filesByPath.get(file);
      if (bucket) bucket.push(result.object);
      else filesByPath.set(file, [result.object]);
      pathById.set(result.object.id, file);
    }
  }

  const graph = ObjectGraph.from(entries.map((e) => ({ object: e.object, file: e.file })));
  return { root, config, graph, diagnostics, filesByPath, pathById };
}

async function discoverFiles(root: string, config: WorkspaceConfig): Promise<string[]> {
  const patterns = config.roots.map((r) => {
    const normalized = r.replace(/\\/g, "/").replace(/^\.\/?$/, "").replace(/\/$/, "");
    return normalized ? `${normalized}/**/*.{yaml,yml}` : "**/*.{yaml,yml}";
  });

  const found = await glob(patterns, {
    cwd: root,
    ignore: [...DEFAULT_IGNORE, ...config.ignore, CONFIG_FILENAME],
    dot: false,
    onlyFiles: true,
  });

  // Normalise separators so paths are stable across platforms, and sort so that
  // load order, and therefore diagnostic order, is deterministic.
  return found.map((f) => f.split(sep).join("/")).sort();
}

/** Order objects within a multi-document file so output is stable. */
const KIND_WRITE_ORDER: readonly ObjectKind[] = [
  "model",
  "namingStandard",
  "subjectArea",
  "glossaryTerm",
  "domain",
  "concept",
  "entity",
  "table",
  "relationship",
  "mapping",
  "diagram",
];

function compareObjects(a: AnyObject, b: AnyObject): number {
  const rankA = KIND_WRITE_ORDER.indexOf(a.kind);
  const rankB = KIND_WRITE_ORDER.indexOf(b.kind);
  if (rankA !== rankB) return rankA - rankB;
  return a.name.localeCompare(b.name);
}

/** Build the layout context for an object: tier, subject area name, layer. */
export function layoutContextFor(graph: ObjectGraph, object: AnyObject): LayoutContext {
  const context: LayoutContext = {};

  const tier = graph.tierOf(object);
  if (tier) context.tier = tier;

  // The owning model's namespace, so a template can group by business domain.
  const owner = object.kind === "model" ? object : graph.modelNamed(object.model ?? "");
  if (owner?.kind === "model" && owner.namespace) context.namespace = owner.namespace;

  if (object.kind === "table" && object.layer) context.layer = object.layer;

  const subjectAreaRef =
    "subjectArea" in object && typeof object.subjectArea === "string" ? object.subjectArea : undefined;
  if (subjectAreaRef) {
    const resolved = graph.resolve(subjectAreaRef, { model: object.model, kind: "subjectArea" });
    context.subjectArea = resolved?.target.object.name ?? subjectAreaRef;
  }

  return context;
}

export interface PlannedWrite {
  path: string;
  objects: AnyObject[];
  content: string;
}

export interface WritePlan {
  writes: PlannedWrite[];
  /** Files that held model objects and no longer should, so they can be removed. */
  deletions: string[];
  /** Objects whose file changes, as `{ id, from, to }`. */
  moves: { id: string; name: string; from: string; to: string }[];
}

/**
 * Work out every file write needed to persist the current graph under the
 * configured layout, without touching the disk.
 *
 * Planning separately from writing is deliberate: it gives `--dry-run` for free,
 * lets the UI preview a reorganisation before committing to it, and means a
 * failure mid-write cannot leave the repo half-migrated.
 */
export function planWrites(workspace: LoadedWorkspace): WritePlan {
  const engine = new LayoutEngine(workspace.config.layout);
  const grouped = new Map<string, AnyObject[]>();
  const moves: WritePlan["moves"] = [];

  for (const entry of workspace.graph.all()) {
    const object = entry.object;
    const target = engine.pathFor(object, layoutContextFor(workspace.graph, object));

    const bucket = grouped.get(target);
    if (bucket) bucket.push(object);
    else grouped.set(target, [object]);

    const current = workspace.pathById.get(object.id);
    if (current && current !== target) {
      moves.push({ id: object.id, name: object.name, from: current, to: target });
    }
  }

  const writes: PlannedWrite[] = [...grouped.entries()]
    .map(([path, objects]) => {
      const ordered = [...objects].sort(compareObjects);
      return { path, objects: ordered, content: serializeDocuments(ordered) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const targetPaths = new Set(writes.map((w) => w.path));
  const deletions = [...workspace.filesByPath.keys()].filter((path) => !targetPaths.has(path)).sort();

  return { writes, deletions, moves };
}

export interface ApplyOptions {
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  /** Leave files that no longer hold objects in place. */
  keepOrphanedFiles?: boolean;
}

export interface ApplyResult {
  written: string[];
  unchanged: string[];
  deleted: string[];
  moves: WritePlan["moves"];
}

/** Execute a write plan. Files whose content is unchanged are left untouched. */
export async function applyWrites(
  workspace: LoadedWorkspace,
  plan: WritePlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  for (const write of plan.writes) {
    const absolute = join(workspace.root, write.path);
    // Skipping identical writes keeps mtimes stable, which matters for watch
    // modes and for not producing empty commits.
    let existing: string | undefined;
    try {
      existing = await readFile(absolute, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing === write.content) {
      unchanged.push(write.path);
      continue;
    }
    if (!options.dryRun) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, write.content, "utf8");
    }
    written.push(write.path);
  }

  if (!options.keepOrphanedFiles) {
    for (const path of plan.deletions) {
      if (!options.dryRun) {
        await rm(join(workspace.root, path), { force: true });
      }
      deleted.push(path);
    }
    if (!options.dryRun && deleted.length > 0) {
      await pruneEmptyDirectories(workspace.root, deleted.map((p) => dirname(p)));
    }
  }

  return { written, unchanged, deleted, moves: plan.moves };
}

/**
 * Remove directories left empty by deletions, walking upwards.
 *
 * Reorganising a repo without this leaves a skeleton of empty folders behind,
 * which makes the resulting commit look far messier than the change actually was.
 *
 * **`rmdir`, not `rm`.** `fs.rm` without `recursive: true` refuses to remove a directory
 * at all, it throws `ERR_FS_EISDIR`, so the earlier `rm(absolute, { recursive: false })`
 * here threw on every single call and the `catch` below swallowed it. The effect was that
 * this function never removed a directory in its life while appearing to work, because its
 * failure mode is silence. `rmdir` is the call that removes an empty directory, and it
 * still refuses a non-empty one, which is the safety property the `readdir` check above is
 * for and the reason not to reach for `recursive: true` instead.
 */
async function pruneEmptyDirectories(root: string, directories: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  const queue = [...directories].sort((a, b) => b.length - a.length);

  while (queue.length > 0) {
    const relativeDir = queue.shift()!;
    if (!relativeDir || relativeDir === "." || seen.has(relativeDir)) continue;
    seen.add(relativeDir);

    const absolute = join(root, relativeDir);
    try {
      const contents = await readdir(absolute);
      if (contents.length > 0) continue;
      await rmdir(absolute);
      queue.push(dirname(relativeDir));
    } catch {
      // Already gone, not a directory, or not empty. Nothing to prune either way.
    }
  }
}

/** Persist the whole workspace under the configured layout. */
export async function saveWorkspace(
  workspace: LoadedWorkspace,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  return applyWrites(workspace, planWrites(workspace), options);
}

/** Write a single object to its layout path, leaving every other file alone. */
export async function writeObject(
  workspace: LoadedWorkspace,
  object: AnyObject,
): Promise<{ path: string; changed: boolean }> {
  const engine = new LayoutEngine(workspace.config.layout);
  const path = engine.pathFor(object, layoutContextFor(workspace.graph, object));
  const absolute = join(workspace.root, path);

  // Preserve any co-tenants already in the target file.
  const existingObjects = (workspace.filesByPath.get(path) ?? []).filter((o) => o.id !== object.id);
  const ordered = [...existingObjects, object].sort(compareObjects);
  const content = ordered.length === 1 ? serializeObject(object) : serializeDocuments(ordered);

  let previous: string | undefined;
  try {
    previous = await readFile(absolute, "utf8");
  } catch {
    previous = undefined;
  }
  if (previous === content) return { path, changed: false };

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return { path, changed: true };
}

/**
 * Remove an object from the repo.
 *
 * When the object shares a file with others, the file is rewritten without it
 * rather than deleted, otherwise deleting one entity from a
 * `single-file-per-model` layout would take the whole model with it.
 */
export async function deleteObject(
  workspace: LoadedWorkspace,
  id: string,
): Promise<{ path: string; fileRemoved: boolean } | undefined> {
  const entry = workspace.graph.get(id);
  if (!entry) return undefined;

  const path = workspace.pathById.get(id) ?? entry.file;
  if (!path) return undefined;

  const absolute = join(workspace.root, path);
  const remaining = (workspace.filesByPath.get(path) ?? []).filter((o) => o.id !== id);

  if (remaining.length === 0) {
    await rm(absolute, { force: true });
    await pruneEmptyDirectories(workspace.root, [dirname(path)]);
    return { path, fileRemoved: true };
  }

  const ordered = [...remaining].sort(compareObjects);
  const content = ordered.length === 1 ? serializeObject(ordered[0]) : serializeDocuments(ordered);
  await writeFile(absolute, content, "utf8");
  return { path, fileRemoved: false };
}

export interface InitOptions {
  name: string;
  description?: string;
  preset?: WorkspaceConfig["layout"]["preset"];
}

/** Create a new model repo: just the config file. Models come next. */
export async function initWorkspace(root: string, options: InitOptions): Promise<string> {
  const config: Record<string, unknown> = {
    version: 1,
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    roots: ["."],
    layout: { preset: options.preset ?? "by-model-and-kind" },
    dataform: [],
    lint: { rules: {}, strict: false },
  };

  const path = join(root, CONFIG_FILENAME);
  await mkdir(root, { recursive: true });
  await writeFile(path, serializeObject(config), "utf8");
  await writeGitAttributes(root);
  return relative(process.cwd(), path).split(sep).join("/") || CONFIG_FILENAME;
}

/**
 * Pin model files to LF endings.
 *
 * We always write LF. Without this, git on Windows checks the files back out as
 * CRLF, and every file then looks modified on every clone, which would bury real
 * changes in line-ending noise and make the diffs this tool exists to produce
 * useless. An existing `.gitattributes` is left alone.
 */
export const GITATTRIBUTES_CONTENT = `# Everything in a model repo is text, and it is always written with LF endings.
#
# The catch-all matters: without it, git on Windows checks files out as CRLF, and a
# Linux reader of the same checkout, a container, a CI runner, sees every one of
# them as modified. That noise would make the change list useless, which is the one
# thing a git-native tool cannot afford.
* text=auto eol=lf
`;

async function writeGitAttributes(root: string): Promise<void> {
  const path = join(root, ".gitattributes");
  try {
    await readFile(path, "utf8");
    return;
  } catch {
    await writeFile(path, GITATTRIBUTES_CONTENT, "utf8");
  }
}

/** Kinds accepted in a workspace, exported for CLI help text. */
export const SUPPORTED_KINDS = OBJECT_KINDS;
