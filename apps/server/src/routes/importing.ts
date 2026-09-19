/**
 * Reverse engineering an existing dataset, and drift against it.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { type GcpAuth, runQuery } from "../bigquery.js";
import { ValidationError, createObject, updateObject } from "../edit.js";
import { bigqueryOn, editors, readers, recordAudit } from "../guards.js";
import { handler } from "../respond.js";
import { getWorkspace, refresh } from "../workspacecache.js";
import { generateAlter, renderAlterScript } from "@strata/ddl";
import { type BigQueryColumnRow, type BigQueryConstraintRow, type BigQueryKeyRow, type MappedObject, type SourceFormat, assertDatasetId, columnsQuery, constraintsQuery, keysQuery, mapToObjects, read, readBigQuery } from "@strata/import";
import { type Table, isKind, parseObject, qualifiedTableName } from "@strata/metamodel";
import { type LoadedWorkspace } from "@strata/storage";

import { gcpAuth } from "../credentials.js";
export const importRoutes = Router();

// ---------------------------------------------------------------- import

/**
 * What an incoming object would collide with.
 *
 * Comparing ids alone is not enough, and getting this wrong is destructive. The file a
 * object lands in is derived from its **kind, model and name**, not from its id, so an
 * imported domain called `Money` overwrites an existing `money.yaml` even though the two
 * have completely different ids. The preview then reports "no clashes" and the import
 * silently replaces a file other objects reference, breaking them.
 *
 * So the index is keyed both ways: by id, and by the tuple the layout engine actually
 * uses to pick a path.
 */
function collisionIndex(workspace: LoadedWorkspace): {
  byId: Set<string>;
  clashesWith: (object: { id: string; kind: string; name: string; model?: string }) => string | undefined;
} {
  const byId = new Set<string>();
  const byPath = new Map<string, string>();

  /*
    `\u0000` as the separator, written as an escape rather than the literal byte it used to
    be: a raw NUL makes every tool that reads this file treat it as binary, including grep.
    The character itself is deliberate, though. It is the one thing that cannot appear in a
    kind, a model name or an object name, so no two distinct tuples can collide into the
    same key the way they could under a `:` or a `/` that a name is allowed to contain.
  */
  const pathKey = (kind: string, model: string | undefined, name: string): string =>
    `${kind}\u0000${model ?? ""}\u0000${name.trim().toLowerCase()}`;

  for (const entry of workspace.graph.all()) {
    const object = entry.object as { id: string; kind: string; name: string; model?: string };
    byId.add(object.id);
    byPath.set(pathKey(object.kind, object.model, object.name), object.id);
  }

  return {
    byId,
    clashesWith: (object) => {
      if (byId.has(object.id)) return object.id;
      return byPath.get(pathKey(object.kind, object.model, object.name));
    },
  };
}

/**
 * Read a source file and report what it would create. Writes nothing.
 *
 * Separate from apply, and always run first, because a migration is the least
 * reversible thing this tool does: hundreds of objects arriving at once, from a file
 * nobody has read, into a repo other people work in. Seeing the count, the names, and
 *, most importantly, everything the reader *could not* map, is what makes it safe to
 * press the button.
 */
importRoutes.post(
  "/api/import/analyze",
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      text?: string;
      format?: SourceFormat;
      model?: string;
      tier?: "conceptual" | "logical" | "physical";
      dataset?: string;
    };

    const text = body.text ?? "";
    if (!text.trim()) {
      res.status(400).json({ error: "nothing to import" });
      return;
    }

    const source = read(text, body.format);
    const workspace = await getWorkspace();

    // The tier decides the shape of everything produced, so it has to be settled before
    // mapping. The user's choice wins; the reader's guess is only a default.
    const target = body.model
      ? workspace.graph.models().find((entry) => entry.object.name === body.model)?.object
      : undefined;
    const tier = body.tier ?? target?.tier ?? source.tier ?? "logical";

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model ?? "",
      tier,
      ...(body.dataset ? { dataset: body.dataset } : {}),
    });

    const { byId, clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object)).map((object) => object.id);
    void byId;

    res.json({
      format: source.format,
      tier,
      counts: {
        entities: source.entities.length,
        relationships: source.relationships.length,
        domains: source.domains.length,
        objects: objects.length,
      },
      objects: objects.map((object) => ({
        id: object.id,
        kind: object.kind,
        name: object.name,
        members:
          (object.columns as unknown[] | undefined)?.length ??
          (object.attributes as unknown[] | undefined)?.length ??
          0,
        clashes: Boolean(clashesWith(object)),
      })),
      clashes,
      diagnostics,
    });
  }),
);

/** Write the mapped objects. Editors only, this creates files in the repo. */
importRoutes.post(
  "/api/import/apply",
  editors,
  handler(async (req, res) => {
    const body = req.body as {
      text?: string;
      format?: SourceFormat;
      model?: string;
      tier?: "conceptual" | "logical" | "physical";
      dataset?: string;
      overwrite?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to import into" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const source = read(body.text ?? "", body.format);
    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the source could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model,
      tier: body.tier ?? target.tier,
      ...(body.dataset ? { dataset: body.dataset } : {}),
    });

    const { clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object));
    if (clashes.length > 0 && !body.overwrite) {
      res.status(409).json({
        error: `${clashes.length} object(s) already exist; re-run with overwrite to replace them`,
        clashes: clashes.map((object) => object.id),
      });
      return;
    }

    const { written, failed } = await writeImported(workspace, objects, clashesWith);

    await refresh();
    res.json({ written: written.length, files: written, failed, diagnostics });
  }),
);

/**
 * Write mapped objects into the workspace.
 *
 * Lifted out of the apply route when the BigQuery importer arrived and needed the identical
 * behaviour. Duplicating it would have been the shorter diff and the worse one: the two rules
 * below are the only reason a large import is survivable, and a second copy is a second place for
 * them to drift.
 */
async function writeImported(
  workspace: LoadedWorkspace,
  objects: MappedObject[],
  clashesWith: (object: MappedObject) => string | undefined,
): Promise<{ written: string[]; failed: { id: string; error: string }[] }> {
  const written: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const object of objects) {
    try {
      const collides = clashesWith(object);
      const result = collides
        ? // Replace under the *existing* id, not the imported one. Everything already
          // in the repo references that id, and swapping it for the import's would
          // break every one of those references to save a cosmetic rename.
          await updateObject(workspace, collides, {
            ...(object as Record<string, unknown>),
            id: collides,
          })
        : await createObject(workspace, object as Record<string, unknown>);
      written.push(result.path);
    } catch (error) {
      // One bad object must not abandon the other four hundred. An import of a real
      // erwin model will hit something odd; reporting which and carrying on is far
      // more useful than stopping at the first and rolling back the rest.
      failed.push({ id: object.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { written, failed };
}

// ---------------------------------------------------------------- reverse engineering

/**
 * Read a live dataset into the same shape a file import produces.
 *
 * **The whole feature, and it is this small.** `packages/import` already turns a `SourceModel`
 * into objects, and everything after that, preview, collision detection, the write loop above,
 * and proposing the result as a pull request, already existed and was already tested. What was
 * missing was never a reverse-engineering subsystem, only something to produce a `SourceModel`
 * from a warehouse rather than from a file.
 *
 * **Three queries, and only the first must succeed.** Columns are the point. The two constraint
 * reads are a bonus that some projects cannot serve at all, older ones have no constraint views,
 * and losing the whole import because an optional half 404'd would be the wrong trade. A missing
 * key becomes a table with no primary key and a missing constraint read becomes a model with no
 * relationships, both visible in the preview, in validation, and in an import diagnostic.
 *
 * The foreign keys matter more than "a bonus" suggests. Without them the model has primary keys
 * and no joins, which looks complete and is not: a downstream engine derives joins from the
 * relationships, so it cannot tell that joining a line-item table repeats its parent's rows.
 */
async function readDataset(options: {
  dataset: string;
  auth: GcpAuth;
  project: string;
  location?: string;
}): Promise<{ source: ReturnType<typeof readBigQuery>; truncated: boolean }> {
  const columns = await runQuery({
    project: options.project,
    sql: columnsQuery(options.dataset),
    auth: options.auth,
    ...(options.location ? { location: options.location } : {}),
  });

  // Both constraint reads are optional by design. See above.
  const optional = async (sql: string) => {
    try {
      const result = await runQuery({
        project: options.project,
        sql,
        auth: options.auth,
        ...(options.location ? { location: options.location } : {}),
      });
      return result.rows;
    } catch {
      return [];
    }
  };

  const [keys, constraints] = await Promise.all([
    optional(keysQuery(options.dataset)),
    optional(constraintsQuery(options.dataset)),
  ]);

  const source = readBigQuery(
    columns.rows as unknown as BigQueryColumnRow[],
    keys as unknown as BigQueryKeyRow[],
    constraints as unknown as BigQueryConstraintRow[],
    { dataset: options.dataset },
  );

  if (columns.truncated) {
    source.diagnostics.push({
      severity: "warning",
      code: "import/truncated",
      message:
        "the dataset returned more columns than one import will read, so this is a partial " +
        "model. Import the largest tables separately, or raise MAX_ROWS.",
    });
  }

  return { source, truncated: columns.truncated };
}

/**
 * Resolve the dataset and the project to bill the query to.
 *
 * The dataset is validated before it is interpolated into SQL, which is the trust boundary here:
 * `assertDatasetId` allows only what Google allows in an identifier, so nothing can close the
 * backtick quoting the query builds. The project may be written into the dataset itself, given
 * explicitly, or inherited from the model's own BigQuery target, which is the case that means a
 * team who has already said where their warehouse lives does not have to say it twice.
 */
function resolveDatasetTarget(
  raw: string | undefined,
  explicitProject: string | undefined,
  target: { project?: string } | undefined,
): { dataset: string; project: string } {
  if (!raw?.trim()) throw new ValidationError("a dataset is required");

  /*
    Rethrown as a `ValidationError` so the caller gets 422 and the reason.

    `assertDatasetId` throws a plain `Error` because it lives in a package that knows nothing
    about HTTP, which is right. Left unwrapped it reaches the catch-all and becomes a bare 500,
    so the one message that says exactly what is wrong with the input is replaced by the one
    status that says nothing at all.
  */
  let dataset: string;
  try {
    dataset = assertDatasetId(raw);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "invalid dataset");
  }
  const qualified = dataset.includes(".") ? dataset.split(".")[0] : undefined;
  const project = explicitProject?.trim() || qualified || target?.project;

  if (!project) {
    throw new ValidationError(
      "no project to run the query in. Give the dataset as `project.dataset`, or set a " +
        "BigQuery target on the model.",
    );
  }

  return { dataset, project };
}

/** What a live dataset would bring in. Writes nothing, the same contract as `/api/import/analyze`. */
importRoutes.post(
  "/api/import/bigquery/analyze",
  bigqueryOn,
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
    };

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({
        error: "no Google credentials are configured",
        hint: "add a service account under `gcp.serviceAccount`, or set STRATA_GCP_ACCESS_TOKEN",
      });
      return;
    }

    const workspace = await getWorkspace();
    const target = body.model
      ? workspace.graph.models().find((entry) => entry.object.name === body.model)?.object
      : undefined;

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target?.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    /*
      Physical, always. A warehouse read back is real tables with real warehouse types, and
      importing it as logical would classify `NUMERIC(18, 2)` down to `decimal` and lose the
      scale on the way in.
    */
    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model ?? "",
      tier: "physical",
      dataset,
    });

    const { clashesWith } = collisionIndex(workspace);

    res.json({
      format: source.format,
      tier: "physical",
      dataset,
      project,
      counts: {
        entities: source.entities.length,
        relationships: source.relationships.length,
        domains: source.domains.length,
        objects: objects.length,
      },
      objects: objects.map((object) => ({
        id: object.id,
        kind: object.kind,
        name: object.name,
        members: (object.columns as unknown[] | undefined)?.length ?? 0,
        clashes: Boolean(clashesWith(object)),
      })),
      clashes: objects.filter((object) => clashesWith(object)).map((object) => object.id),
      diagnostics,
    });
  }),
);

/**
 * Where the warehouse and the model disagree, and the DDL that closes the gap.
 *
 * **This is the feature the notes list as blocked on selective apply, and it is not.** Every part
 * already existed: reading a dataset is the importer above, and `generateAlter` has encoded
 * BigQuery's real `ALTER` limits since long before this route. Drift is the two of them pointed at
 * each other, and it costs a loop rather than a subsystem.
 *
 * **The direction is deliberate.** `from` is the live table and `to` is the modelled one, so the
 * statements migrate the *warehouse* to match the *model*. That is the direction the model being
 * authoritative implies: the repository is reviewed and the warehouse is what drifted. The
 * opposite direction is the importer, which is why it is a separate route rather than a flag.
 *
 * **Nothing is executed, ever.** This returns SQL for a person to read and run. A route that
 * applied its own migration would be a tool that rewrites a production warehouse on a button, and
 * the `recreate` class means some of what it produces must never be run unattended at all.
 */
importRoutes.post(
  "/api/import/bigquery/drift",
  bigqueryOn,
  readers,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
      dropColumns?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to compare against" });
      return;
    }

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({ error: "no Google credentials are configured" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the dataset could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    /*
      Parsed through the real schema rather than cast.

      `mapToObjects` returns plain objects, and `generateAlter` reads `columns[].mode`, nested
      `fields` and the partitioning shape. Casting would work right up to the first table where a
      default mattered, and then compare a column against a field that was never populated.
    */
    const live = new Map<string, Table>();
    for (const object of mapToObjects(source, { model: body.model, tier: "physical", dataset }).objects) {
      const parsed = parseObject(object);
      if (parsed.object && isKind(parsed.object, "table")) {
        live.set(parsed.object.name.toLowerCase(), parsed.object);
      }
    }

    const modelled = workspace.graph
      .inModel(body.model)
      .map((entry) => entry.object)
      .filter((object): object is Table => object.kind === "table");

    const drifted: {
      table: string;
      changes: ReturnType<typeof generateAlter>["changes"];
      statements: string[];
      requiresRecreate: boolean;
      sql: string;
    }[] = [];
    const notDeployed: string[] = [];
    const seen = new Set<string>();

    for (const table of modelled) {
      const current = live.get(table.name.toLowerCase());
      if (!current) {
        // In the model, absent from the warehouse. Not drift: it has never been built.
        notDeployed.push(table.name);
        continue;
      }
      seen.add(table.name.toLowerCase());

      const script = generateAlter(current, table, {
        qualifiedName: qualifiedTableName(table, {
          ...(project ? { project } : {}),
          dataset: dataset.includes(".") ? dataset.split(".")[1]! : dataset,
        }),
        ...(body.dropColumns ? { dropColumns: true } : {}),
      });

      if (script.changes.length > 0) {
        drifted.push({
          table: table.name,
          changes: script.changes,
          statements: script.statements,
          requiresRecreate: script.requiresRecreate,
          sql: renderAlterScript(script),
        });
      }
    }

    /*
      In the warehouse and not in the model.

      Reported rather than ignored, because this is the direction that produces the surprise: a
      column somebody added by hand at 3am is invisible to every other view in this tool, and it
      is exactly what the model claiming to be authoritative is wrong about.
    */
    const notModelled = [...live.values()]
      .filter((table) => !seen.has(table.name.toLowerCase()))
      .map((table) => table.name);

    res.json({
      dataset,
      project,
      model: body.model,
      inSync: drifted.length === 0 && notDeployed.length === 0 && notModelled.length === 0,
      drifted,
      notDeployed,
      notModelled,
      diagnostics: source.diagnostics,
    });
  }),
);

/** Write what the analyze route previewed. Editors only, this creates files in the repo. */
importRoutes.post(
  "/api/import/bigquery/apply",
  bigqueryOn,
  editors,
  handler(async (req, res) => {
    const body = req.body as {
      dataset?: string;
      project?: string;
      location?: string;
      model?: string;
      overwrite?: boolean;
    };

    if (!body.model) {
      res.status(400).json({ error: "choose which model to import into" });
      return;
    }

    const auth = await gcpAuth();
    if (!auth) {
      res.status(400).json({ error: "no Google credentials are configured" });
      return;
    }

    const workspace = await getWorkspace();
    const target = workspace.graph.models().find((entry) => entry.object.name === body.model)?.object;
    if (!target) {
      res.status(404).json({ error: `no model named ${body.model}` });
      return;
    }

    const { dataset, project } = resolveDatasetTarget(
      body.dataset,
      body.project,
      target.kind === "model" ? target.target : undefined,
    );

    const { source } = await readDataset({
      dataset,
      project,
      auth,
      ...(body.location ? { location: body.location } : {}),
    });

    if (source.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      res.status(422).json({
        error: "the dataset could not be read",
        diagnostics: source.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      });
      return;
    }

    const { objects, diagnostics } = mapToObjects(source, {
      model: body.model,
      tier: "physical",
      dataset,
    });

    const { clashesWith } = collisionIndex(workspace);
    const clashes = objects.filter((object) => clashesWith(object));

    /*
      Re-importing a dataset that is already modelled is the *normal* case here, not the exception
      it is for a file import: this is how drift gets noticed. So a clash still refuses by default,
      because overwriting somebody's descriptions and classifications with a bare warehouse read is
      destructive, but it is the expected answer rather than a failure.
    */
    if (clashes.length > 0 && !body.overwrite) {
      res.status(409).json({
        error: `${clashes.length} object(s) already exist; re-run with overwrite to replace them`,
        clashes: clashes.map((object) => object.id),
        hint: "compare the model against the dataset first if you want to see what changed",
      });
      return;
    }

    const { written, failed } = await writeImported(workspace, objects, clashesWith);

    await refresh();
    await recordAudit(req, "import.bigquery", { target: `${project}.${dataset}` });

    res.json({ written: written.length, files: written, failed, diagnostics, dataset, project });
  }),
);

