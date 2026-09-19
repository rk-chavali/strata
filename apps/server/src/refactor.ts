import {
  LIFECYCLE_STATES,
  ObjectGraph,
  type AnyObject,
  type Lifecycle,
  type Model,
} from "@strata/metamodel";
import {
  applyWrites,
  planWrites,
  updateConfig,
  type LoadedWorkspace,
  type WritePlan,
} from "@strata/storage";
import { NotFoundError, ValidationError } from "./edit.js";

/**
 * Repo-wide renames.
 *
 * **Why a model rename cannot be an ordinary field edit.** A model's name is not stored
 * once. It appears in the `model:` field of every object that belongs to it, in the
 * `derivedFrom:` of any model refining it, as the qualifier of every cross-model
 * reference (`retail_logical:Customer.customer_id`), in the `dataform.models` list in
 * `strata.config.yaml`, and, under most layout presets, in the *path of every file in the
 * model*, because the default template is `models/{model}/{kinds}/{name}.yaml`.
 *
 * Writing the renamed model object on its own therefore does three wrong things at once:
 * it leaves the old `models/old_name/model.yaml` on disk, it orphans every child object
 * (whose `model:` still names something that no longer exists), and it strands every
 * qualified reference. The repo would still load, `previousNames` and the bare-name
 * fallback in `ObjectGraph.lookup` are forgiving, but it would be quietly wrong in a way
 * that shows up as a mess in the first pull request.
 *
 * So a rename is a refactor: rewrite every reference, then move every file. This module
 * is that operation, and it is deliberately on the server rather than in the client,
 * because it has to be atomic-ish and because it touches files the browser cannot see.
 */

/** What a rename touched, so the caller can report it honestly. */
export interface RefactorResult {
  /** The object whose name or namespace changed. */
  model: Model;
  /** Objects whose contents were rewritten, including the model itself. */
  objectsChanged: number;
  /** Files written, in repo-relative form. */
  written: string[];
  /** Files removed because everything in them moved elsewhere. */
  deleted: string[];
  /** `{ from, to }` for every file that moved, for the summary line. */
  moves: { from: string; to: string }[];
  /** True when `strata.config.yaml` had to be edited as well. */
  configChanged: boolean;
}

/**
 * Fields that hold references and may therefore carry a `model:` qualifier.
 *
 * An allow-list, not a deny-list, and that asymmetry is the whole safety argument. A
 * blanket "rewrite any string starting with the old name followed by a colon" would also
 * rewrite prose, a description reading `retail_warehouse: the mart layer` would silently
 * become `retail_mart: the mart layer`. Descriptions are written by people and are not
 * ours to edit.
 *
 * The trade is that a new ref-bearing field has to be added here or its qualifier goes
 * stale. That failure is visible (the reference still resolves via the bare-name
 * fallback, and `strata check` reports nothing) but it is recoverable and it never corrupts
 * a human's words, which is the right way round.
 */
const REF_FIELDS = new Set([
  // Every field declared as `RefSchema` in the metamodel, by name.
  "ref",
  "derivedFrom",
  "conceptRef",
  "entityRef",
  "attributeRef",
  "glossaryTerm",
  "glossaryTerms",
  "relatedTerms",
  "domain",
  "extends",
  "inheritedFrom",
  "supertype",
  "namingStandard",
  "subjectArea",
  "autoIncludeSubjectAreas",
  "associativeEntity",
  "dimension",
  "table",
  "target",
  "dependencies",
  "parent",
]);

/**
 * Rewrite `old:Thing` to `new:Thing` inside a reference string.
 *
 * Anchored at the start and requiring the colon, because a qualifier is a prefix and
 * nothing else. `retail_logical:Customer.customer_id` has its first segment replaced and
 * the member path left alone; a bare `Customer` is untouched, which is correct, an
 * unqualified reference resolves in its own model's scope and that scope moves with it.
 */
function requalify(value: string, from: string, to: string): string {
  const colon = value.indexOf(":");
  if (colon <= 0) return value;
  if (value.slice(0, colon).toLowerCase() !== from.toLowerCase()) return value;
  return `${to}${value.slice(colon)}`;
}

/**
 * Walk an object's ref-bearing fields and requalify every string in them.
 *
 * Recurses through arrays and nested records because references sit at every depth: a
 * relationship's `parent.ref`, a mapping's `sources[].ref`, a dimensional config's
 * `dimensions[].dimension`.
 *
 * **Returns the input by reference when nothing changed**, and that is load-bearing rather
 * than an optimisation. The caller decides which files a refactor is allowed to touch by
 * asking which objects changed; a version that always allocated a fresh object would
 * answer "all of them", and the rename would quietly become a whole-repo reorganisation.
 */
function requalifyDeep(value: unknown, from: string, to: string, inRefField: boolean): unknown {
  if (typeof value === "string") {
    return inRefField ? requalify(value, from, to) : value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = requalifyDeep(item, from, to, inRefField);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    let changed = false;

    for (const [key, item] of Object.entries(source)) {
      /**
       * `properties` is the user-defined-property escape hatch and is round-tripped
       * untouched everywhere else in this codebase. Rewriting inside it would break that
       * promise, and a UDP is as likely to hold prose as a reference.
       */
      const mapped =
        key === "properties"
          ? item
          : // Once inside a ref field every nested string is a reference, so the flag latches.
            requalifyDeep(item, from, to, inRefField || REF_FIELDS.has(key));
      if (mapped !== item) changed = true;
      next[key] = mapped;
    }

    return changed ? next : value;
  }

  return value;
}

/**
 * Rename a model, following the name everywhere it is written.
 *
 * The steps are ordered so that the file plan is computed from a fully-consistent graph:
 * rewrite objects first, rebuild the index from the rewritten objects, and only then ask
 * the layout engine where everything belongs. Doing it the other way round would compute
 * `{model}` from the old name for the children and the new one for the model object, and
 * scatter the model across two directories.
 */
export async function renameModel(
  workspace: LoadedWorkspace,
  id: string,
  nextName: string,
): Promise<RefactorResult> {
  const entry = workspace.graph.get(id);
  if (!entry || entry.object.kind !== "model") {
    throw new NotFoundError(`no model with id \`${id}\``);
  }
  const current = entry.object as Model;
  const from = current.name;
  const to = nextName.trim();

  if (!to) throw new ValidationError("a model needs a name");
  if (to === from) {
    return {
      model: current,
      objectsChanged: 0,
      written: [],
      deleted: [],
      moves: [],
      configChanged: false,
    };
  }

  assertNameFree(workspace, id, to);

  return applyRefactor(workspace, id, (object) => rewriteForRename(object, id, from, to));
}

function assertNameFree(workspace: LoadedWorkspace, id: string, name: string): void {
  const clash = workspace.graph
    .models()
    .find((m) => m.object.id !== id && m.object.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new ValidationError(`a model named \`${name}\` already exists`);
}

/**
 * Everything the model settings dialog can change, in one field.
 *
 * `null` clears; `undefined` leaves alone. The distinction matters because "the user
 * emptied the description" and "the client did not send a description" have to produce
 * different files, and a single optional string cannot express both.
 */
export interface ModelSettingsPatch {
  name?: string;
  namespace?: string | null;
  displayName?: string | null;
  description?: string | null;
  tags?: string[];
  lifecycle?: Lifecycle | null;
}

/**
 * Apply every model-level setting in one pass.
 *
 * **Why this is one operation and not three.** Renaming a model, moving it to another
 * domain and editing its tags are, on disk, one rewrite of a set of files, and under a
 * name- or domain-keyed layout, the same set of files. Running them in sequence would
 * reload the workspace between each step, plan the tree three times, and produce three
 * git-visible intermediate states; if the second failed, the repo would be left in a shape
 * the user never asked for. Composing the rewrite and planning once means the dialog's
 * Save is a single event, which is also what makes the change reviewable as one commit.
 */
export async function updateModelSettings(
  workspace: LoadedWorkspace,
  id: string,
  patch: ModelSettingsPatch,
): Promise<RefactorResult> {
  const entry = workspace.graph.get(id);
  if (!entry || entry.object.kind !== "model") {
    throw new NotFoundError(`no model with id \`${id}\``);
  }
  const current = entry.object as Model;

  const from = current.name;
  const to = patch.name === undefined ? from : patch.name.trim();
  if (!to) throw new ValidationError("a model needs a name");
  const renaming = to.toLowerCase() !== from.toLowerCase() || to !== from;
  if (renaming) assertNameFree(workspace, id, to);

  if (patch.lifecycle != null && !LIFECYCLE_STATES.includes(patch.lifecycle)) {
    throw new ValidationError(
      `\`${patch.lifecycle}\` is not a lifecycle state, expected one of ${LIFECYCLE_STATES.join(", ")}`,
    );
  }

  const namespace =
    patch.namespace === undefined
      ? current.namespace
      : (patch.namespace?.trim() || undefined);

  return applyRefactor(workspace, id, (object) => {
    // Other objects only ever see the rename, and only if there is one.
    if (object.id !== id) {
      return renaming ? rewriteForRename(object, id, from, to) : object;
    }

    let next = (renaming ? rewriteForRename(object, id, from, to) : object) as Model;
    if (namespace !== current.namespace) next = withNamespace(next, namespace) as Model;

    if (patch.displayName !== undefined) next = withOptional(next, "displayName", patch.displayName);
    if (patch.description !== undefined) next = withOptional(next, "description", patch.description);
    if (patch.lifecycle !== undefined) next = withOptional(next, "lifecycle", patch.lifecycle);
    if (patch.tags !== undefined) next = { ...next, tags: normaliseTags(patch.tags) };

    return next as AnyObject;
  });
}

/**
 * Set a string-ish field, or remove it when cleared.
 *
 * Empty strings are treated as absence rather than written through. A YAML file carrying
 * `description: ""` is noise in a diff and reads, to anyone opening it, as a description
 * someone meant to write and forgot, which is exactly the wrong signal.
 */
function withOptional<T extends object, K extends string>(
  object: T,
  key: K,
  value: string | null,
): T {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    const next = { ...object } as Record<string, unknown>;
    delete next[key];
    return next as T;
  }
  return { ...object, [key]: trimmed } as T;
}

/**
 * Tags, tidied.
 *
 * Trimmed, blanks dropped, de-duplicated case-insensitively but keeping the first spelling
 * the user typed, and sorted. Sorting is the part worth defending: tags are a set, and an
 * unsorted set means adding one tag reorders the YAML list and the diff shows a change to
 * a line nobody touched.
 */
function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Move a model into a different business domain.
 *
 * Separate from `renameModel` because it changes no references at all, `namespace` is
 * not a name anything points at. What it does change, under the `by-namespace` preset, is
 * the path of every file in the model, so it needs the same file-moving machinery. Under
 * any other preset it is a one-field edit that happens to go through the same code path,
 * which costs a plan nobody uses and keeps one implementation instead of two.
 */
export async function setModelNamespace(
  workspace: LoadedWorkspace,
  id: string,
  namespace: string | undefined,
): Promise<RefactorResult> {
  const entry = workspace.graph.get(id);
  if (!entry || entry.object.kind !== "model") {
    throw new NotFoundError(`no model with id \`${id}\``);
  }

  const next = namespace?.trim() || undefined;
  const model = entry.object as Model;
  if ((model.namespace ?? undefined) === next) {
    return {
      model,
      objectsChanged: 0,
      written: [],
      deleted: [],
      moves: [],
      configChanged: false,
    };
  }

  return applyRefactor(workspace, id, (object) =>
    object.id === id ? withNamespace(object, next) : object,
  );
}

/**
 * Set or clear a model's namespace.
 *
 * Clearing deletes the key rather than setting it to `undefined`, because the serializer
 * writes what it is given and `namespace: null` in a YAML file is not the same thing as an
 * absent namespace, the first is a domain literally called null.
 */
function withNamespace(object: AnyObject, namespace: string | undefined): AnyObject {
  if (namespace) return { ...object, namespace } as AnyObject;
  const next = { ...object } as Record<string, unknown>;
  delete next.namespace;
  return next as AnyObject;
}

/**
 * Move every model in one domain to a new domain name.
 *
 * A domain is not a stored object, it exists only as a string repeated on each model, * so renaming one means editing each member. Done as a single refactor rather than a loop
 * of `setModelNamespace` calls so that the file plan is computed once, from the end state.
 * A loop would reload the workspace between models and produce a plan per step, which for
 * a three-tier domain means three passes over the same directory tree and three chances
 * to stop halfway.
 */
export async function renameNamespace(
  workspace: LoadedWorkspace,
  from: string,
  to: string,
): Promise<{ models: string[]; result: RefactorResult | undefined }> {
  const target = to.trim();
  if (!target) throw new ValidationError("a domain needs a name");

  const members = workspace.graph
    .models()
    .filter((m) => (m.object.namespace ?? "") === from)
    .map((m) => m.object);

  if (members.length === 0) throw new NotFoundError(`no models are in the domain \`${from}\``);

  const ids = new Set(members.map((model) => model.id));
  const result = await applyRefactor(workspace, members[0]!.id, (object) =>
    ids.has(object.id) ? ({ ...object, namespace: target } as AnyObject) : object,
  );

  return { models: members.map((model) => model.name), result };
}

/**
 * The shared body: rewrite every object, then move every file that needs moving.
 *
 * `subject` is only used to report which model the operation was about.
 */
async function applyRefactor(
  workspace: LoadedWorkspace,
  subjectId: string,
  rewrite: (object: AnyObject) => AnyObject,
): Promise<RefactorResult> {
  const entries = workspace.graph.all();

  const rewritten: { object: AnyObject; file?: string; changed: boolean }[] = entries.map(
    (entry) => {
      const next = rewrite(entry.object);
      return {
        object: next,
        ...(entry.file === undefined ? {} : { file: entry.file }),
        changed: next !== entry.object,
      };
    },
  );

  /**
   * A fresh index over the rewritten objects.
   *
   * `ObjectGraph` builds its name indexes in `add`, so mutating an object in place would
   * leave `byScopedName` pointing at the old name and the layout engine would resolve
   * `{model}` and `{namespace}` from a stale entry. Rebuilding is cheap and is the only
   * way to be sure the plan is computed against the end state.
   */
  const graph = ObjectGraph.from(
    rewritten.map((item) => (item.file === undefined ? { object: item.object } : { object: item.object, file: item.file })),
  );

  /**
   * The plan is computed against the *new* graph but the *old* on-disk index.
   *
   * That combination is what produces a move rather than a copy: `writes` come out at the
   * paths the renamed objects now belong at, while `deletions` are derived from
   * `filesByPath`, which still describes what is actually on disk.
   *
   * The baseline plan is the same computation against the graph as it stands, and it is
   * what makes the scoping below possible: comparing the two says which objects moved
   * *because of this refactor*, as opposed to which ones were already sitting outside
   * their canonical position for unrelated reasons.
   */
  const baseline = planWrites(workspace);
  const planned = planWrites({ ...workspace, graph });

  /**
   * Restrict the plan to files this refactor is responsible for.
   *
   * `planWrites` plans the whole repo, so applying it wholesale would relocate every file
   * that happens to be out of position, turning "rename a model" into "reorganise the
   * repository" and burying the rename in an unreviewable diff. `strata reorganize` is the
   * command for that, and it is a separate, deliberate act.
   *
   * **An object is in scope if its contents changed *or* its path changed**, and both
   * halves are needed. Contents alone misses a domain move: changing a model's `namespace`
   * under the `by-namespace` preset relocates every file in the model while altering the
   * text of none of them, so a contents-only test would move the model file and leave its
   * tables behind in the old domain's folder. Path alone misses a pure metadata edit.
   */
  const baselineTarget = targetPaths(baseline);
  const plannedTarget = targetPaths(planned);

  const affected = new Set<string>();
  for (const item of rewritten) {
    const id = item.object.id;
    const moved = baselineTarget.get(id) !== plannedTarget.get(id);
    if (item.changed || moved) affected.add(id);
  }

  const touched = new Set<string>();
  for (const id of affected) {
    // The source is where the file actually is, not where the layout thinks it should be.
    const before = workspace.pathById.get(id);
    if (before) touched.add(before);
    const after = plannedTarget.get(id);
    if (after) touched.add(after);
  }

  const plan: WritePlan = {
    writes: planned.writes.filter((write) => touched.has(write.path)),
    deletions: planned.deletions.filter((path) => touched.has(path)),
    moves: planned.moves.filter((move) => touched.has(move.from) || touched.has(move.to)),
  };

  const applied = await applyWrites({ ...workspace, graph }, plan);

  /**
   * `strata.config.yaml` names models too.
   *
   * `dataform[].models` selects which models generate into a given Dataform repository.
   * Leaving a stale name there means generation silently stops producing output for the
   * renamed model, a failure with no error message, which is the worst kind.
   */
  const configChanged = await syncConfigModelNames(workspace, rewritten);

  const model = graph.get(subjectId)?.object as Model | undefined;
  if (!model) throw new NotFoundError(`no model with id \`${subjectId}\``);

  return {
    model,
    objectsChanged: affected.size,
    written: applied.written,
    deleted: applied.deleted,
    moves: applied.moves.map((move) => ({ from: move.from, to: move.to })),
    configChanged,
  };
}

/** Where a plan puts each object, keyed by object id. */
function targetPaths(plan: WritePlan): Map<string, string> {
  const paths = new Map<string, string>();
  for (const write of plan.writes) {
    for (const object of write.objects) paths.set(object.id, write.path);
  }
  return paths;
}

/**
 * Apply a model rename to one object.
 *
 * Four distinct jobs, and they are not interchangeable:
 *   - the model object itself gets the new `name`, plus `previousNames` so older commits
 *     and any repo we do not control keep resolving;
 *   - every object belonging to it gets a new `model:` field, a bare model name, which is
 *     why the qualifier rewrite below cannot cover it;
 *   - a model whose `derivedFrom` names this one gets that updated, also bare;
 *   - everything, including objects in other models, gets its ref *qualifiers*
 *     requalified, the `retail_logical:` in `retail_logical:Customer.customer_id`.
 */
function rewriteForRename(object: AnyObject, id: string, from: string, to: string): AnyObject {
  let next = requalifyDeep(object, from, to, false) as AnyObject;

  /**
   * The bare-name fields, handled explicitly.
   *
   * `requalify` only fires on a `name:` prefix, by design, it must not touch an
   * unqualified reference, because those resolve in their own model's scope. But `model:`
   * and a model's `derivedFrom:` hold a bare *model* name rather than a qualified object
   * reference, so they need naming outright. Getting this wrong is how a rename leaves
   * every child object orphaned while appearing to have worked.
   */
  if (next.model && next.model.toLowerCase() === from.toLowerCase()) {
    next = { ...next, model: to } as AnyObject;
  }

  if (
    next.kind === "model" &&
    next.derivedFrom &&
    next.derivedFrom.toLowerCase() === from.toLowerCase()
  ) {
    next = { ...next, derivedFrom: to } as AnyObject;
  }

  if (object.id === id) {
    const previousNames = next.previousNames.includes(from)
      ? next.previousNames
      : [...next.previousNames, from];
    return { ...next, name: to, previousNames } as AnyObject;
  }

  return next;
}

/**
 * Rewrite model names inside `strata.config.yaml`.
 *
 * Goes through `updateConfig`, which edits the YAML document in place rather than
 * re-serialising it, so a team's comments survive a rename. Returns whether anything
 * needed changing, so the caller does not claim to have edited a file it left alone.
 */
async function syncConfigModelNames(
  workspace: LoadedWorkspace,
  rewritten: { object: AnyObject; changed: boolean }[],
): Promise<boolean> {
  const renames = new Map<string, string>();
  for (const item of rewritten) {
    if (!item.changed || item.object.kind !== "model") continue;
    const before = workspace.graph.get(item.object.id)?.object;
    if (before && before.name !== item.object.name) renames.set(before.name, item.object.name);
  }
  if (renames.size === 0) return false;

  const connections = workspace.config.dataform ?? [];
  const affected = connections.some((connection) =>
    (connection.models ?? []).some((name) => renames.has(name)),
  );
  if (!affected) return false;

  await updateConfig(workspace.root, (doc) => {
    const dataform = doc.get("dataform");
    if (!dataform || typeof dataform !== "object" || !("items" in dataform)) return;
    for (const [index, connection] of connections.entries()) {
      const models = connection.models ?? [];
      for (const [position, name] of models.entries()) {
        const next = renames.get(name);
        if (next) doc.setIn(["dataform", index, "models", position], next);
      }
    }
  });

  return true;
}
