import { createHash } from "node:crypto";
import {
  migrateDiagram,
  newId,
  parseObject,
  type AnyObject,
  type Diagram,
  type ObjectKind,
} from "@strata/metamodel";
import {
  deleteObject,
  loadWorkspace,
  parseYamlFile,
  serializeObject,
  writeObject,
  type LoadedWorkspace,
} from "@strata/storage";

/**
 * Write operations.
 *
 * Two things here are load-bearing.
 *
 * First, **every write is a file write**, immediately. There is no in-memory
 * document that later gets flushed. That is what makes the git story honest: the
 * moment you change something in the UI, `git status` shows it, and the diff is
 * what a reviewer will see.
 *
 * Second, **writes are guarded by a content hash**. Two people editing the same
 * model through one server would otherwise silently overwrite each other. The
 * branch-per-user model handles collaboration across people; this handles the
 * narrower case of concurrent edits against one working tree.
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Hash of an object's canonical serialization, used for optimistic locking. */
export function revisionOf(object: AnyObject): string {
  return createHash("sha256").update(serializeObject(object)).digest("hex").slice(0, 16);
}

function requireCurrent(workspace: LoadedWorkspace, id: string): AnyObject {
  const entry = workspace.graph.get(id);
  if (!entry) throw new NotFoundError(`no object with id \`${id}\``);
  return entry.object;
}

function assertRevision(current: AnyObject, expected: string | undefined): void {
  if (!expected) return;
  const actual = revisionOf(current);
  if (actual !== expected) {
    throw new ConflictError(
      `\`${current.name}\` changed on disk since you loaded it, reload before saving to avoid losing that change`,
    );
  }
}

function parseOrThrow(input: unknown): AnyObject {
  const result = parseObject(assignMissingMemberIds(input));
  if (!result.object) {
    throw new ValidationError(result.error ?? "object failed validation", result.issues);
  }
  return result.object;
}

/**
 * Mint ids for attributes and columns that arrive without one.
 *
 * Clients deliberately do not generate ids. Ids are the durable identity used to
 * follow a rename through a merge, so letting several concurrent editors invent
 * them would risk collisions in exactly the situation identity exists to
 * disambiguate. A new column therefore arrives id-less and gets one here.
 */
function assignMissingMemberIds(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const object = { ...input };

  if (Array.isArray(object.attributes)) {
    object.attributes = object.attributes.map((attribute) =>
      isRecord(attribute) && !attribute.id ? { ...attribute, id: newId("attribute") } : attribute,
    );
  }

  if (Array.isArray(object.columns)) {
    object.columns = object.columns.map(withColumnIds);
  }

  return object;
}

/** Columns nest, so STRUCT fields need the same treatment all the way down. */
function withColumnIds(column: unknown): unknown {
  if (!isRecord(column)) return column;
  const next = { ...column };
  if (!next.id) next.id = newId("column");
  if (Array.isArray(next.fields)) next.fields = next.fields.map(withColumnIds);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface WriteResult {
  object: AnyObject;
  revision: string;
  path: string;
}

/** Replace an object wholesale. */
export async function updateObject(
  workspace: LoadedWorkspace,
  id: string,
  payload: unknown,
  expectedRevision?: string,
): Promise<WriteResult> {
  const current = requireCurrent(workspace, id);
  assertRevision(current, expectedRevision);

  const next = parseOrThrow(payload);
  if (next.id !== id) {
    throw new ValidationError("an object's id cannot be changed; delete and recreate it instead");
  }

  // Record the old name so references elsewhere keep resolving until they are
  // updated, and so a merge can tell a rename from a delete-plus-add.
  if (next.name !== current.name && !next.previousNames.includes(current.name)) {
    next.previousNames = [...next.previousNames, current.name];
  }

  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path };
}

/** Replace an object from raw YAML, as typed in the editor. */
export async function updateObjectFromYaml(
  workspace: LoadedWorkspace,
  id: string,
  yamlText: string,
  expectedRevision?: string,
): Promise<WriteResult> {
  const parsed = parseYamlFile(yamlText);
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]!;
    throw new ValidationError(`line ${first.line}: ${first.message}`);
  }
  const first = parsed.documents[0];
  if (!first) throw new ValidationError("the editor is empty");
  if (parsed.documents.length > 1) {
    throw new ValidationError("expected a single object, but found several YAML documents");
  }
  return updateObject(workspace, id, first.value, expectedRevision);
}

export async function createObject(
  workspace: LoadedWorkspace,
  payload: Record<string, unknown>,
): Promise<WriteResult> {
  const kind = payload.kind;
  if (typeof kind !== "string") throw new ValidationError("a new object needs a `kind`");

  const withId = { ...payload, id: payload.id ?? newId(kind as Parameters<typeof newId>[0]) };
  const object = parseOrThrow(withId);

  if (workspace.graph.get(object.id)) {
    throw new ConflictError(`id \`${object.id}\` is already in use`);
  }
  const clash = workspace.graph
    .all()
    .find(
      (e) =>
        e.object.kind === object.kind &&
        e.object.name.toLowerCase() === object.name.toLowerCase() &&
        (e.object.model ?? null) === (object.model ?? null),
    );
  if (clash) {
    throw new ConflictError(`a ${object.kind} named \`${object.name}\` already exists here`);
  }

  const { path } = await writeObject(workspace, object);
  return { object, revision: revisionOf(object), path };
}

export async function removeObject(
  workspace: LoadedWorkspace,
  id: string,
): Promise<{ path: string; fileRemoved: boolean }> {
  requireCurrent(workspace, id);
  const result = await deleteObject(workspace, id);
  if (!result) throw new NotFoundError(`no object with id \`${id}\``);
  return result;
}

/** A blank but valid object of the requested kind, ready to be edited. */
export function scaffold(kind: ObjectKind, options: { model?: string; name: string }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind,
    name: options.name,
    ...(options.model && kind !== "model" ? { model: options.model } : {}),
  };

  switch (kind) {
    case "entity":
      return {
        ...base,
        attributes: [
          { id: newId("attribute"), name: "id", logicalType: "string", required: true },
        ],
        primaryKey: ["id"],
      };
    case "table":
      return {
        ...base,
        columns: [{ id: newId("column"), name: "id", dataType: "STRING", mode: "REQUIRED" }],
        primaryKey: ["id"],
      };
    case "concept":
      return { ...base, definition: "" };
    case "domain":
      return { ...base, logicalType: "string" };
    case "glossaryTerm":
      return { ...base, definition: "" };
    case "model":
      return { ...base, tier: "logical" };
    case "relationship":
      return {
        ...base,
        tier: "logical",
        parent: { ref: "", cardinality: "exactly-one" },
        child: { ref: "", cardinality: "zero-or-more" },
      };
    case "mapping":
      return { ...base, target: "", loadStrategy: "full" };
    case "diagram":
      return { ...base, model: options.model ?? "" };
    default:
      return base;
  }
}

/**
 * Rename or retype a single attribute or column, addressed by dotted path.
 *
 * A dedicated operation rather than a whole-object PUT, for two reasons: the canvas
 * renders a *flattened* member list where an index means nothing to the stored object,
 * and touching one field keeps everything the editor does not surface, classification,
 * policy tags, derivation rules, exactly as it was.
 */
export async function updateMember(
  workspace: LoadedWorkspace,
  id: string,
  patch: MemberPatch,
): Promise<WriteResult> {
  const current = requireCurrent(workspace, id);
  const draft = structuredClone(current) as Record<string, unknown>;

  const segments = patch.path.split(".");
  const renamedTo = patch.name?.trim();

  if (current.kind === "entity") {
    if (segments.length > 1) {
      throw new ValidationError("logical attributes do not nest");
    }
    const attributes = draft.attributes as Record<string, unknown>[] | undefined;
    const attribute = attributes?.find(
      (candidate) => String(candidate.name).toLowerCase() === segments[0]!.toLowerCase(),
    );
    if (!attribute) throw new NotFoundError(`no attribute \`${patch.path}\``);

    const previousName = String(attribute.name);
    if (renamedTo) attribute.name = renamedTo;
    if (patch.type?.trim()) {
      // Typing a value directly means the user is overriding the domain, so drop it
      // rather than leaving two conflicting sources of truth on the attribute.
      attribute.logicalType = patch.type.trim();
      delete attribute.domain;
    }
    if (renamedTo && renamedTo !== previousName) {
      renameInKeyList(draft.primaryKey, previousName, renamedTo);
    }

    applyAnnotations(attribute, patch);
    // A logical attribute states requiredness as a boolean; a column states it as a mode.
    if (patch.required !== undefined) attribute.required = patch.required;
  } else if (current.kind === "table") {
    const column = resolveColumnRecord(draft.columns as Record<string, unknown>[] | undefined, segments);
    if (!column) throw new NotFoundError(`no column \`${patch.path}\``);

    const previousName = String(column.name);
    if (renamedTo) column.name = renamedTo;
    if (patch.type?.trim()) column.dataType = patch.type.trim();

    // Only a top-level rename can appear in the key lists.
    if (renamedTo && renamedTo !== previousName && segments.length === 1) {
      renameInKeyList(draft.primaryKey, previousName, renamedTo);
      renameInKeyList(draft.clustering, previousName, renamedTo);
    }

    applyAnnotations(column, patch);
    /*
      REQUIRED and NULLABLE only. `REPEATED` is a different axis, it means "array of", and mapping a requiredness toggle onto it would silently turn an array column into
      a scalar. A repeated column keeps its mode regardless of this flag.
    */
    if (patch.required !== undefined && column.mode !== "REPEATED") {
      column.mode = patch.required ? "REQUIRED" : "NULLABLE";
    }
  } else {
    throw new ValidationError(`${current.kind} objects have no members to edit`);
  }

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path };
}

/** Append a blank member, ready for the user to name in place. */
export async function addMember(workspace: LoadedWorkspace, id: string): Promise<WriteResult & { name: string }> {
  const current = requireCurrent(workspace, id);
  const draft = structuredClone(current) as Record<string, unknown>;

  const isTable = current.kind === "table";
  const key = isTable ? "columns" : "attributes";
  if (current.kind !== "table" && current.kind !== "entity") {
    throw new ValidationError(`${current.kind} objects have no members`);
  }

  const list = (draft[key] as Record<string, unknown>[] | undefined) ?? [];
  const name = uniqueName(
    list.map((member) => String(member.name)),
    isTable ? "new_column" : "New Attribute",
  );

  list.push(
    isTable
      ? { id: newId("column"), name, dataType: "STRING", mode: "NULLABLE" }
      : { id: newId("attribute"), name, logicalType: "string", required: false },
  );
  draft[key] = list;

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path, name };
}

/** Remove a member by dotted path, and drop it from any key list that named it. */
export async function removeMember(
  workspace: LoadedWorkspace,
  id: string,
  memberPath: string,
): Promise<WriteResult> {
  const current = requireCurrent(workspace, id);
  const draft = structuredClone(current) as Record<string, unknown>;
  const segments = memberPath.split(".");
  const leaf = segments[segments.length - 1]!;

  if (current.kind === "entity") {
    const attributes = (draft.attributes as Record<string, unknown>[] | undefined) ?? [];
    draft.attributes = attributes.filter(
      (candidate) => String(candidate.name).toLowerCase() !== leaf.toLowerCase(),
    );
  } else if (current.kind === "table") {
    if (segments.length === 1) {
      const columns = (draft.columns as Record<string, unknown>[] | undefined) ?? [];
      draft.columns = columns.filter(
        (candidate) => String(candidate.name).toLowerCase() !== leaf.toLowerCase(),
      );
    } else {
      const parent = resolveColumnRecord(
        draft.columns as Record<string, unknown>[] | undefined,
        segments.slice(0, -1),
      );
      if (!parent) throw new NotFoundError(`no column \`${memberPath}\``);
      const fields = (parent.fields as Record<string, unknown>[] | undefined) ?? [];
      parent.fields = fields.filter(
        (candidate) => String(candidate.name).toLowerCase() !== leaf.toLowerCase(),
      );
    }
  } else {
    throw new ValidationError(`${current.kind} objects have no members`);
  }

  removeFromKeyList(draft.primaryKey, leaf);
  removeFromKeyList(draft.clustering, leaf);

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path };
}

/** Toggle whether a top-level member is part of the primary key. */
export async function toggleKey(
  workspace: LoadedWorkspace,
  id: string,
  memberName: string,
): Promise<WriteResult> {
  const current = requireCurrent(workspace, id);
  const draft = structuredClone(current) as Record<string, unknown>;
  const key = (draft.primaryKey as string[] | undefined) ?? [];
  const lower = memberName.toLowerCase();
  const present = key.some((entry) => entry.toLowerCase() === lower);

  if (present) {
    draft.primaryKey = key.filter((entry) => entry.toLowerCase() !== lower);
  } else {
    draft.primaryKey = [...key, memberName];
    // A key member cannot be nullable, so promote it rather than emitting a
    // validation error the user then has to go and fix by hand.
    if (current.kind === "table") {
      const column = resolveColumnRecord(draft.columns as Record<string, unknown>[] | undefined, [memberName]);
      if (column) column.mode = "REQUIRED";
    } else if (current.kind === "entity") {
      const attributes = (draft.attributes as Record<string, unknown>[] | undefined) ?? [];
      const attribute = attributes.find((candidate) => String(candidate.name).toLowerCase() === lower);
      if (attribute) attribute.required = true;
    }
  }

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path };
}

/**
 * What one member edit can change.
 *
 * Grew from `{path, name, type}` when the documentation grid arrived. The grid edits a
 * column's *meaning*, what it holds, how sensitive it is, whether it can be null, and
 * doing that through the whole-object PUT would mean the client round-tripping a 40-column
 * table to change one description, with every concurrent edit to a sibling column lost.
 *
 * `null` is meaningfully different from `undefined` on every optional field here:
 * `undefined` means "leave it alone" and `null` means "clear it". A grid cell that has been
 * emptied has to be able to say the second thing.
 */
export interface MemberPatch {
  path: string;
  name?: string;
  type?: string;
  description?: string | null;
  required?: boolean;
  classification?: {
    sensitivity?: string | null;
    categories?: string[];
    policyTagName?: string | null;
    /**
     * Marks the column as identifying a data subject, for erasure mapping.
     *
     * Carried through the patch rather than only settable by hand-editing YAML, because the
     * classification suggester proposes it and a patch that silently dropped it would write a
     * column marked as PII but not as a subject identifier, which is precisely the column a
     * subject-erasure report then fails to find.
     */
    subjectIdentifier?: boolean | null;
  } | null;
}

/**
 * Apply the metadata half of a member patch, in place.
 *
 * Shared between attributes and columns because the annotation fields are identical on
 * both, `ClassificationSchema` is defined once in the metamodel and referenced by each.
 * Only requiredness differs, so only that is left to the caller.
 */
function applyAnnotations(member: Record<string, unknown>, patch: MemberPatch): void {
  if (patch.description !== undefined) {
    const text = patch.description?.trim();
    if (text) member.description = text;
    // Delete rather than write `""`. An empty description is not a description, and
    // persisting the empty string puts a meaningless key in the YAML and in every diff.
    else delete member.description;
  }

  if (patch.classification === null) {
    delete member.classification;
    return;
  }

  if (patch.classification !== undefined) {
    const existing =
      typeof member.classification === "object" && member.classification !== null
        ? { ...(member.classification as Record<string, unknown>) }
        : {};

    if (patch.classification.sensitivity !== undefined) {
      if (patch.classification.sensitivity) existing.sensitivity = patch.classification.sensitivity;
      else delete existing.sensitivity;
    }

    if (patch.classification.categories !== undefined) {
      if (patch.classification.categories.length > 0) existing.categories = patch.classification.categories;
      else delete existing.categories;
    }

    if (patch.classification.policyTagName !== undefined) {
      if (patch.classification.policyTagName) existing.policyTagName = patch.classification.policyTagName;
      else delete existing.policyTagName;
    }

    if (patch.classification.subjectIdentifier !== undefined) {
      // Only `true` is written. `subjectIdentifier: false` is the default said out loud, and it
      // would appear in every diff of every column that is not one.
      if (patch.classification.subjectIdentifier) existing.subjectIdentifier = true;
      else delete existing.subjectIdentifier;
    }

    /*
      An empty classification object is dropped entirely.

      `classification: {categories: []}` parses and means nothing, but it is not nothing to
      the governance coverage report, it counts as "classified" and quietly inflates the
      number that is supposed to tell you what still needs attention.
    */
    if (Object.keys(existing).length === 0) delete member.classification;
    else member.classification = existing;
  }
}

function resolveColumnRecord(
  columns: Record<string, unknown>[] | undefined,
  segments: string[],
): Record<string, unknown> | undefined {
  let pool = columns;
  let found: Record<string, unknown> | undefined;
  for (const segment of segments) {
    if (!pool) return undefined;
    found = pool.find((candidate) => String(candidate.name).toLowerCase() === segment.toLowerCase());
    if (!found) return undefined;
    pool = found.fields as Record<string, unknown>[] | undefined;
  }
  return found;
}

function renameInKeyList(list: unknown, from: string, to: string): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (typeof entry === "string" && entry.toLowerCase() === from.toLowerCase()) {
      (list as string[])[index] = to;
    }
  }
}

function removeFromKeyList(list: unknown, name: string): void {
  if (!Array.isArray(list)) return;
  const lower = name.toLowerCase();
  for (let index = list.length - 1; index >= 0; index--) {
    const entry = list[index];
    if (typeof entry === "string" && entry.toLowerCase() === lower) list.splice(index, 1);
  }
}

function uniqueName(existing: readonly string[], base: string): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface LayoutPatch {
  /** Width and height are optional: a box that has never been resized has neither. */
  positions?: { objectId: string; x: number; y: number; width?: number; height?: number }[];
  /** Replaces the whole shape list when present. */
  shapes?: Diagram["shapes"];
  /** Replaces the whole connector list when present. */
  connectors?: Diagram["connectors"];
  gridSize?: number;
  /**
   * The notation this diagram is drawn in.
   *
   * Carried on the layout patch rather than through a general object update, for the same
   * reason positions are: a read-modify-write of the whole diagram object from the client
   * would clobber a colleague's box moves made between the read and the write. This merges
   * one field into whatever is currently on disk.
   *
   * It belongs to the *diagram*, not the model: the same entities may reasonably be shown
   * in IDEF1X for a data architect's review and crow's foot for an engineering audience,
   * and those are two diagrams over one model.
   */
  notation?: Diagram["notation"];
}

/**
 * Create a relationship by dragging one box onto another.
 *
 * The two tiers behave differently, and conflating them would be wrong:
 *
 *  - **Logical and conceptual** get a `relationship` object, which is the tier's native
 *    way of saying two things are related.
 *  - **Physical** gets a foreign key on the child table, because that is what a
 *    relationship *is* in a warehouse, and it is what generates the DDL constraint and
 *    the referential-integrity assertion.
 *
 * Columns are matched by name where possible, since a foreign key almost always
 * repeats the parent's key name. The caller can override.
 */
export async function createRelationship(
  workspace: LoadedWorkspace,
  input: {
    modelName: string;
    parentId: string;
    childId: string;
    cardinality?: "zero-or-one" | "exactly-one" | "zero-or-more" | "one-or-more";
    identifying?: boolean;
    verbPhrase?: string;
    /** Parent-side member names. Inferred from the parent's key when omitted. */
    parentMembers?: string[];
    /** Child-side member names. Inferred by name match when omitted. */
    childMembers?: string[];
  },
): Promise<{ created: "relationship" | "foreignKey"; object: AnyObject; path: string }> {
  const model = workspace.graph.modelNamed(input.modelName);
  if (!model) throw new NotFoundError(`no model named \`${input.modelName}\``);

  const parent = requireCurrent(workspace, input.parentId);
  const child = requireCurrent(workspace, input.childId);

  if (parent.id === child.id) {
    throw new ValidationError("a self-relationship needs a role name; create it from the object instead");
  }

  const parentKey = input.parentMembers?.length ? input.parentMembers : keyMembersOf(parent);
  if (parentKey.length === 0) {
    throw new ValidationError(
      `\`${parent.name}\` has no primary key, so there is nothing for \`${child.name}\` to reference`,
    );
  }

  // Prefer a same-named member on the child; otherwise assume the key name is reused.
  const childKey = input.childMembers?.length
    ? input.childMembers
    : parentKey.map((name) => findMemberNamed(child, name) ?? name);

  if (model.tier === "physical") {
    return addForeignKey(workspace, child, parent, parentKey, childKey);
  }

  const name = uniqueName(
    workspace.graph.inModel(input.modelName).map((entry) => entry.object.name),
    `${snake(parent.name)}_${snake(child.name)}`,
  );

  const relationship = parseOrThrow({
    id: newId("relationship"),
    kind: "relationship",
    name,
    model: input.modelName,
    tier: model.tier,
    identifying: input.identifying ?? false,
    parent: {
      ref: parent.name,
      cardinality: "exactly-one",
      ...(input.verbPhrase ? { verbPhrase: input.verbPhrase } : {}),
      attributes: model.tier === "conceptual" ? [] : parentKey,
    },
    child: {
      ref: child.name,
      cardinality: input.cardinality ?? "zero-or-more",
      attributes: model.tier === "conceptual" ? [] : childKey,
    },
  });

  // Migrate the parent's key into the child.
  //
  // This *is* what a logical relationship does, the foreign key exists on the child
  // because the relationship put it there. Writing the relationship without migrating
  // the attribute leaves a reference to a member that does not exist, which is both an
  // invalid model and a worse answer than the physical tier gives for the same gesture.
  if (model.tier === "logical" && child.kind === "entity" && parent.kind === "entity") {
    await migrateKeyAttributes(workspace, child, parent, parentKey, childKey, {
      relationship: name,
      identifying: input.identifying ?? false,
    });
  }

  const { path } = await writeObject(workspace, relationship);
  return { created: "relationship", object: relationship, path };
}

/** Copy the parent's key attributes onto the child, preserving their domain and type. */
async function migrateKeyAttributes(
  workspace: LoadedWorkspace,
  child: Extract<AnyObject, { kind: "entity" }>,
  parent: Extract<AnyObject, { kind: "entity" }>,
  parentKey: string[],
  childKey: string[],
  context: { relationship: string; identifying: boolean },
): Promise<void> {
  const draft = structuredClone(child) as Record<string, unknown>;
  const attributes = (draft.attributes as Record<string, unknown>[] | undefined) ?? [];
  let added = false;

  for (const [index, name] of childKey.entries()) {
    if (attributes.some((attribute) => String(attribute.name).toLowerCase() === name.toLowerCase())) {
      continue;
    }
    const source = parent.attributes.find(
      (attribute) => attribute.name.toLowerCase() === (parentKey[index] ?? "").toLowerCase(),
    );

    attributes.push({
      id: newId("attribute"),
      name,
      // An identifying relationship puts the key into the child's identity, so the
      // migrated attribute cannot be optional.
      required: context.identifying,
      inherited: true,
      inheritedFrom: context.relationship,
      ...(source?.domain ? { domain: source.domain } : {}),
      ...(!source?.domain && source?.logicalType ? { logicalType: source.logicalType } : {}),
      ...(!source ? { logicalType: "string" } : {}),
    });
    added = true;
  }

  if (!added && !context.identifying) return;
  draft.attributes = attributes;

  if (context.identifying) {
    const primaryKey = new Set(((draft.primaryKey as string[] | undefined) ?? []).map((k) => k.toLowerCase()));
    draft.primaryKey = [
      ...((draft.primaryKey as string[] | undefined) ?? []),
      ...childKey.filter((name) => !primaryKey.has(name.toLowerCase())),
    ];
  }

  await writeObject(workspace, parseOrThrow(draft));
}

/** Physical tier: a relationship is a foreign key on the child table. */
async function addForeignKey(
  workspace: LoadedWorkspace,
  child: AnyObject,
  parent: AnyObject,
  parentKey: string[],
  childKey: string[],
): Promise<{ created: "foreignKey"; object: AnyObject; path: string }> {
  if (child.kind !== "table" || parent.kind !== "table") {
    throw new ValidationError("foreign keys can only join two tables");
  }

  const draft = structuredClone(child) as Record<string, unknown>;
  const columns = (draft.columns as Record<string, unknown>[] | undefined) ?? [];
  const existingNames = columns.map((column) => String(column.name));

  // Add any referencing column the child does not already have, copying the parent's
  // type so the key actually joins.
  for (const [index, name] of childKey.entries()) {
    if (existingNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) continue;
    const source = parent.columns.find(
      (column) => column.name.toLowerCase() === (parentKey[index] ?? "").toLowerCase(),
    );
    columns.push({
      id: newId("column"),
      name,
      dataType: source?.dataType ?? "STRING",
      mode: "NULLABLE",
    });
  }
  draft.columns = columns;

  const foreignKeys = (draft.foreignKeys as Record<string, unknown>[] | undefined) ?? [];
  foreignKeys.push({
    name: uniqueName(
      foreignKeys.map((fk) => String(fk.name)),
      `fk_${snake(child.name)}_${snake(parent.name)}`,
    ),
    columns: childKey,
    references: { table: parent.name, columns: parentKey },
    assert: true,
  });
  draft.foreignKeys = foreignKeys;

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { created: "foreignKey", object: next, path };
}

/**
 * Delete a foreign key from a table.
 *
 * The physical counterpart to deleting a relationship object. The referencing *column*
 * is deliberately left in place: it may well hold data and be used elsewhere, and
 * quietly dropping a column because someone deleted a line on a diagram would be an
 * unpleasant surprise.
 */
export async function removeForeignKey(
  workspace: LoadedWorkspace,
  tableId: string,
  foreignKeyName: string,
): Promise<WriteResult> {
  const table = requireCurrent(workspace, tableId);
  if (table.kind !== "table") throw new ValidationError("only tables have foreign keys");

  const draft = structuredClone(table) as Record<string, unknown>;
  const foreignKeys = (draft.foreignKeys as Record<string, unknown>[] | undefined) ?? [];
  const remaining = foreignKeys.filter((fk) => String(fk.name) !== foreignKeyName);

  if (remaining.length === foreignKeys.length) {
    throw new NotFoundError(`\`${table.name}\` has no foreign key called \`${foreignKeyName}\``);
  }
  draft.foreignKeys = remaining;

  const next = parseOrThrow(draft);
  const { path } = await writeObject(workspace, next);
  return { object: next, revision: revisionOf(next), path };
}

function keyMembersOf(object: AnyObject): string[] {
  if (object.kind === "table" || object.kind === "entity") {
    return [...object.primaryKey];
  }
  return [];
}

function findMemberNamed(object: AnyObject, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (object.kind === "table") {
    return object.columns.find((column) => column.name.toLowerCase() === lower)?.name;
  }
  if (object.kind === "entity") {
    return object.attributes.find((attribute) => attribute.name.toLowerCase() === lower)?.name;
  }
  return undefined;
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
}

/**
 * Persist canvas state for a model: node positions and text boxes.
 *
 * Finds the model's diagram or creates one. Positions are stored as *references*
 * by name, not ids, so the diagram file stays readable in a pull request, and so a
 * reviewer can see that a change was cosmetic.
 */
export async function saveLayout(
  workspace: LoadedWorkspace,
  modelName: string,
  patch: LayoutPatch,
): Promise<{ diagram: Diagram; created: boolean; path: string }> {
  const model = workspace.graph.modelNamed(modelName);
  if (!model) throw new NotFoundError(`no model named \`${modelName}\``);

  const existing = workspace.graph
    .inModel(modelName)
    .find((entry) => entry.object.kind === "diagram")?.object as Diagram | undefined;

  let diagram: Diagram;
  let created = false;
  if (existing) {
    // Migrate legacy notes into shapes here, so saving a diagram written before shapes
    // existed quietly brings it up to date rather than needing a migration step.
    const migrated = migrateDiagram(existing);
    diagram = { ...migrated, nodes: [...migrated.nodes], shapes: [...migrated.shapes] };
  } else {
    created = true;
    diagram = parseOrThrow({
      id: newId("diagram"),
      kind: "diagram",
      name: `${modelName} diagram`,
      model: modelName,
    }) as Diagram;
  }

  for (const position of patch.positions ?? []) {
    const target = workspace.graph.get(position.objectId);
    if (!target) continue;

    // Store the reference the way a human would write it.
    const ref = target.object.name;
    const index = diagram.nodes.findIndex((node) => {
      const resolved = workspace.graph.resolve(node.ref, { model: modelName });
      return resolved?.target.object.id === position.objectId;
    });

    const rounded = {
      x: Math.round(position.x),
      y: Math.round(position.y),
      // Only record a size once the user has actually resized the box. Writing the
      // measured size of every box would freeze them all at whatever height they
      // happened to have, so adding a column would no longer grow the box.
      ...(position.width !== undefined ? { width: Math.round(position.width) } : {}),
      ...(position.height !== undefined ? { height: Math.round(position.height) } : {}),
    };

    if (index >= 0) {
      diagram.nodes[index] = { ...diagram.nodes[index]!, ...rounded };
    } else {
      diagram.nodes.push({ ref, ...rounded, visibleMembers: [] });
    }
  }

  // Shapes and connectors are sent whole rather than merged: the canvas always knows
  // the complete set, and a merge would make deleting one impossible.
  if (patch.shapes) diagram.shapes = patch.shapes;
  if (patch.connectors) diagram.connectors = patch.connectors;
  if (patch.gridSize !== undefined) diagram.gridSize = patch.gridSize;
  if (patch.notation !== undefined) diagram.notation = patch.notation;

  const validated = parseOrThrow(diagram) as Diagram;
  const { path } = await writeObject(workspace, validated);
  return { diagram: validated, created, path };
}

/** Reload from disk and return the fresh workspace. Files are the truth. */
export async function reload(root: string): Promise<LoadedWorkspace> {
  return loadWorkspace(root);
}
