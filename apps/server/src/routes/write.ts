/**
 * Every mutation of the model, and the saves behind them.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { type MemberPatch, addMember, createObject, createRelationship, removeForeignKey, removeMember, removeObject, saveLayout, scaffold, toggleKey, updateMember, updateObject, updateObjectFromYaml } from "../edit.js";
import { history } from "../git.js";
import { editors, readers } from "../guards.js";
import { renameNamespace, updateModelSettings } from "../refactor.js";
import { handler } from "../respond.js";
import { allDiagnostics, getWorkspace, refresh, workspaceRoot } from "../workspacecache.js";
import { type ObjectKind } from "@strata/metamodel";
import { diagnosticsView } from "@strata/query";

import { historyPaths } from "../scope.js";
export const writeRoutes = Router();

// ---------------------------------------------------------------- write

writeRoutes.post(
  "/api/objects",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { kind?: string; name?: string; model?: string; object?: unknown };

    const payload =
      body.object ??
      scaffold((body.kind ?? "") as ObjectKind, {
        name: body.name ?? "Untitled",
        ...(body.model ? { model: body.model } : {}),
      });

    const result = await createObject(workspace, payload as Record<string, unknown>);
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.put(
  "/api/objects/:id",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { object: unknown; revision?: string };
    const result = await updateObject(workspace, req.params.id ?? "", body.object, body.revision);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.put(
  "/api/objects/:id/raw",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { yaml: string; revision?: string };
    const result = await updateObjectFromYaml(workspace, req.params.id ?? "", body.yaml, body.revision);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.delete(
  "/api/objects/:id",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const result = await removeObject(workspace, req.params.id ?? "");
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** In-place member edits from the canvas. */
writeRoutes.patch(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Partial<MemberPatch>;
    if (!body.path) {
      res.status(400).json({ error: "a member path is required" });
      return;
    }
    /*
      Each key is forwarded only when present, because `undefined` and `null` mean different
      things downstream: absent leaves the field alone, `null` clears it. Spreading the body
      wholesale would turn every unsent optional into an explicit "leave alone", which is
      right, but also lets an unknown key through into the object, which is not.
    */
    const result = await updateMember(workspace, req.params.id ?? "", {
      path: body.path,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.required !== undefined ? { required: body.required } : {}),
      ...(body.classification !== undefined ? { classification: body.classification } : {}),
    });
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.post(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const result = await addMember(workspace, req.params.id ?? "");
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.delete(
  "/api/objects/:id/members",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!path) {
      res.status(400).json({ error: "a member path is required" });
      return;
    }
    const result = await removeMember(workspace, req.params.id ?? "", path);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

writeRoutes.post(
  "/api/objects/:id/members/key",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { name?: string };
    if (!body.name) {
      res.status(400).json({ error: "a member name is required" });
      return;
    }
    const result = await toggleKey(workspace, req.params.id ?? "", body.name);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** Remove a foreign key, deleting a relationship line on a physical diagram. */
writeRoutes.delete(
  "/api/objects/:id/foreign-keys",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) {
      res.status(400).json({ error: "a foreign key name is required" });
      return;
    }
    const result = await removeForeignKey(workspace, req.params.id ?? "", name);
    const reloaded = await refresh();
    res.json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/** Drag one box onto another to relate them. */
writeRoutes.post(
  "/api/models/:name/relationships",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Omit<Parameters<typeof createRelationship>[1], "modelName">;
    const result = await createRelationship(workspace, { ...body, modelName: req.params.name ?? "" });
    const reloaded = await refresh();
    res.status(201).json({ ...result, diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts });
  }),
);

/**
 * What changed, scoped to a model or a domain.
 *
 * **Why paths and not a directory.** A model's files live wherever the layout put them, and
 * under the `flat` or `by-kind` presets they share directories with other models, so
 * "history for this model" cannot be a folder listing. The paths come from the workspace
 * index, which knows exactly which file each object was loaded from, and that is right under
 * every preset including one a team wrote themselves.
 *
 * Scoping to a domain is the union of its models' paths, for the same reason.
 */
writeRoutes.get(
  "/api/history",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const model = typeof req.query.model === "string" ? req.query.model : undefined;
    const domain = typeof req.query.domain === "string" ? req.query.domain : undefined;
    const limit = Number(req.query.limit ?? 20);

    const paths = historyPaths(workspace, { model, domain });
    const result = await history(workspaceRoot(), {
      ...(paths ? { paths } : {}),
      limit: Number.isFinite(limit) ? limit : 20,
    });

    res.json({ ...result, scope: model ?? domain ?? "workspace", pathCount: paths?.length ?? 0 });
  }),
);

/**
 * One square on a model's row: enough to draw it, colour it and explain it on hover.
 *
 * Deliberately narrower than `HistoryEntry`, the file list is the bulk of that type and no
 * part of it is used here, so sending it would multiply the size of this response by the
 * number of files in every commit for nothing.
 */
interface HistorySummaryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  merge: boolean;
  pullRequest?: number;
  pullRequestUrl?: string;
  commitUrl?: string;
}

/**
 * Recent changes per model, for the models list.
 *
 * **One `git log`, then bucketed in memory.** The obvious implementation is a scoped log per
 * model, which is correct and unusable: a workspace with three hundred models would spawn
 * three hundred `git` processes to draw one page. Instead this walks a single log of the whole
 * repository once and attributes each commit to the models whose files it touched, which is
 * one process regardless of how many models there are.
 *
 * The trade-off, stated plainly: a commit that only touched files which have since been
 * deleted or moved cannot be attributed to a model, because the mapping is built from the
 * workspace as it stands now. Those commits are absent from a model's squares while still
 * appearing in its full History view, which reads the log with rename detection.
 */
writeRoutes.get(
  "/api/history/summary",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();

    /** Which model each file on disk belongs to. */
    const modelOfPath = new Map<string, string>();
    for (const entry of workspace.graph.models()) {
      const own = workspace.pathById.get(entry.object.id);
      if (own) modelOfPath.set(own, entry.object.name);
      for (const member of workspace.graph.inModel(entry.object.name)) {
        const path = workspace.pathById.get(member.object.id);
        if (path) modelOfPath.set(path, entry.object.name);
      }
    }

    /**
     * Deep enough that an active model still fills its row.
     *
     * A model touched in one commit out of every fifty needs a wide window before ten of its
     * own changes appear. Three hundred commits is one cheap log and covers that; going
     * deeper buys little because the squares only show ten.
     */
    const { entries } = await history(workspaceRoot(), { limit: 300 });

    const byModel: Record<string, HistorySummaryEntry[]> = {};
    for (const entry of entries) {
      const touched = new Set<string>();
      for (const file of entry.files) {
        const model = modelOfPath.get(file);
        if (model) touched.add(model);
      }
      for (const model of touched) {
        const bucket = (byModel[model] ??= []);
        // Newest first out of git; ten is what the row draws.
        if (bucket.length < 10) {
          bucket.push({
            sha: entry.sha,
            shortSha: entry.shortSha,
            subject: entry.subject,
            author: entry.author,
            date: entry.date,
            merge: entry.merge,
            ...(entry.pullRequest ? { pullRequest: entry.pullRequest } : {}),
            ...(entry.pullRequestUrl ? { pullRequestUrl: entry.pullRequestUrl } : {}),
            ...(entry.commitUrl ? { commitUrl: entry.commitUrl } : {}),
          });
        }
      }
    }

    res.json({ byModel });
  }),
);

/**
 * Model-level settings: name, domain, tags, description, lifecycle.
 *
 * Its own endpoint rather than `PUT /api/objects/:id` because renaming a model is not a
 * field edit, the name is written into every child object, into other models'
 * `derivedFrom`, into every qualified cross-model reference, into `strata.config.yaml`, and
 * into the path of every file in the model. `updateObject` would write the renamed model
 * object and leave all five of those stale. See `refactor.ts`.
 */
writeRoutes.patch(
  "/api/models/:id/settings",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Parameters<typeof updateModelSettings>[2];
    const result = await updateModelSettings(workspace, req.params.id ?? "", body);
    const reloaded = await refresh();
    res.json({
      model: result.model,
      objectsChanged: result.objectsChanged,
      moved: result.moves.length,
      configChanged: result.configChanged,
      diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts,
    });
  }),
);

/**
 * Rename a business domain.
 *
 * A domain is not a stored object, it exists only as a `namespace` string repeated on
 * each model, so renaming one means editing every member in a single pass, which is also
 * what keeps the file moves to one plan and one reviewable commit.
 */
writeRoutes.post(
  "/api/domains/:name/rename",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { name?: string };
    const result = await renameNamespace(workspace, req.params.name ?? "", body.name ?? "");
    const reloaded = await refresh();
    res.json({
      models: result.models,
      objectsChanged: result.result?.objectsChanged ?? 0,
      diagnostics: diagnosticsView(allDiagnostics(reloaded)).counts,
    });
  }),
);

writeRoutes.put(
  "/api/models/:name/layout",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as Parameters<typeof saveLayout>[2];
    const result = await saveLayout(workspace, req.params.name ?? "", body);
    await refresh();
    res.json({ diagramId: result.diagram.id, created: result.created, path: result.path });
  }),
);

