/**
 * Generating DDL and Dataform SQLX from the model.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { hasRole } from "../auth.js";
import { editors, readers } from "../guards.js";
import { handler } from "../respond.js";
import { auth } from "../services.js";
import { readSettings } from "../settings.js";
import { getWorkspace, refresh } from "../workspacecache.js";
import { generateCodeowners, generateDataform, generateModelDdl, taxonomyFor } from "@strata/ddl";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const generationRoutes = Router();

// ---------------------------------------------------------------- generation

/**
 * Preview or write DDL.
 *
 * Preview first, always: this writes files into the user's repo, and seeing exactly what
 * lands before it lands is what makes that safe to run. Everything generated is a *new*
 * file, nothing here edits something a human wrote.
 */
generationRoutes.post(
  "/api/generate/ddl",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as {
      model?: string;
      write?: boolean;
      /** Which deployment target's policy tags to resolve against. Omitted uses the shared map. */
      environment?: string;
    };

    const blocking = workspace.diagnostics.filter((d) => d.severity === "error");
    if (blocking.length > 0) {
      res.status(409).json({
        error: `${blocking.length} file(s) could not be loaded; refusing to generate from a partial model`,
      });
      return;
    }

    const settings = readSettings(workspace.config);
    const all = workspace.graph.models().map((entry) => entry.object);
    const physical = all
      .filter((model) => model.tier === "physical")
      .filter((model) => !body.model || model.name === body.model);

    if (physical.length === 0) {
      // Three different situations reach here, and telling them apart is the whole
      // value of the message. "No physical models" when the user asked for a model
      // that exists but is logical sends them looking for the wrong problem.
      const named = body.model ? all.find((model) => model.name === body.model) : undefined;
      const error = !body.model
        ? "this workspace has no physical models, so there is no DDL to generate"
        : named
          ? `${body.model} is a ${named.tier} model, DDL is only generated from physical models`
          : `no model named ${body.model} in this workspace`;
      res.status(404).json({ error });
      return;
    }

    const files = physical.flatMap((model) =>
      generateModelDdl(workspace.graph, model.name, {
        orReplace: settings.ddl.orReplace,
        pathTemplate: settings.ddl.pathTemplate,
        /*
          The taxonomy comes from the config, not from settings, and is resolved *per
          environment*.

          Two reasons, and both are about blast radius. It has to be reviewable in a pull request
          alongside the classifications it acts on, a change to which policy tag "pii" maps to
          silently re-scopes column-level security across the whole warehouse. And a policy tag is
          a resource path embedding a project and a taxonomy id, so the same logical `pii` is a
          different string in dev and prod: generating production DDL with development's ids does
          not fail here, it fails at apply time against a taxonomy the target project cannot see.
        */
        taxonomy: taxonomyFor(workspace.config.governance, body.environment),
        // Only name the index after its model when several share the folder. A lone
        // model should still produce a plain `README.md`.
        ...(physical.length > 1 ? { indexSuffix: model.name } : {}),
      }),
    );

    // Writing requires the editor role even though previewing does not.
    if (body.write) {
      if (!hasRole(req.user, "editor") && !auth.disabled) {
        res.status(403).json({ error: "writing generated files needs the `editor` role" });
        return;
      }

      let written = 0;
      for (const file of files) {
        const relative = `${settings.ddl.outputFolder}/${file.path}`.replace(/\/{2,}/g, "/");
        const absolute = join(workspace.root, relative);
        let existing: string | undefined;
        try {
          existing = await readFile(absolute, "utf8");
        } catch {
          existing = undefined;
        }
        if (existing === file.contents) continue;
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.contents, "utf8");
        written++;
      }
      await refresh();
      res.json({ written, total: files.length, folder: settings.ddl.outputFolder });
      return;
    }

    /**
     * Say what each file would actually do, rather than just listing everything.
     *
     * A team that already keeps DDL in the repo sees the same fifty files every time
     * they open this panel, with no way to tell the two that changed from the
     * forty-eight that did not, so the panel is noise and the diff is the only real
     * answer. Comparing against what is on disk turns the list into a changeset.
     */
    const withStatus = await Promise.all(
      files.map(async (file) => {
        const path = `${settings.ddl.outputFolder}/${file.path}`.replace(/\/{2,}/g, "/");
        let existing: string | undefined;
        try {
          existing = await readFile(join(workspace.root, path), "utf8");
        } catch {
          existing = undefined;
        }
        return {
          path,
          kind: file.kind,
          contents: file.contents,
          status:
            existing === undefined ? "new" : existing === file.contents ? "unchanged" : "modified",
        };
      }),
    );

    res.json({
      folder: settings.ddl.outputFolder,
      files: withStatus,
      counts: {
        new: withStatus.filter((file) => file.status === "new").length,
        modified: withStatus.filter((file) => file.status === "modified").length,
        unchanged: withStatus.filter((file) => file.status === "unchanged").length,
      },
    });
  }),
);

/**
 * Dataform SQLX from the mappings.
 *
 * Deliberately a sibling of `/generate/ddl` rather than a flag on it: the two describe
 * different things (what the tables *are* versus how they are *filled*), land in different
 * repositories, and are usually owned by different people. Same preview-then-write
 * contract, because writing into someone's Dataform project unannounced is exactly the
 * behaviour that makes generators untrustworthy.
 */
generationRoutes.post(
  "/api/generate/dataform",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { model?: string; write?: boolean };

    const blocking = workspace.diagnostics.filter((d) => d.severity === "error");
    if (blocking.length > 0) {
      res.status(409).json({
        error: `${blocking.length} file(s) could not be loaded; refusing to generate from a partial model`,
      });
      return;
    }

    const all = workspace.graph.models().map((entry) => entry.object);
    const physical = all
      .filter((model) => model.tier === "physical")
      .filter((model) => !body.model || model.name === body.model);

    if (physical.length === 0) {
      const named = body.model ? all.find((model) => model.name === body.model) : undefined;
      res.status(404).json({
        error: !body.model
          ? "this workspace has no physical models, so there are no mappings to generate from"
          : named
            ? `${body.model} is a ${named.tier} model, Dataform is only generated from physical models`
            : `no model named ${body.model} in this workspace`,
      });
      return;
    }

    /**
     * Where the Dataform project lives, and how it is laid out.
     *
     * Both come from the matching `dataform:` connection when the workspace declares one,
     * so a team that has already told the tool where its Dataform repo is does not repeat
     * itself here. `dataform/` is the fallback because that is what `dataform init` makes.
     */
    const connectionFor = (modelName: string) =>
      workspace.config.dataform.find(
        (candidate) => candidate.models.length === 0 || candidate.models.includes(modelName),
      );

    const folder =
      physical.map((model) => connectionFor(model.name)?.path).find(Boolean) ?? "dataform";

    const files = physical.flatMap((model) => {
      const connection = connectionFor(model.name);
      return generateDataform(workspace.graph, model.name, (connection?.paths ? { paths: connection.paths } : {}));
    });

    if (body.write) {
      if (!hasRole(req.user, "editor") && !auth.disabled) {
        res.status(403).json({ error: "writing generated files needs the `editor` role" });
        return;
      }

      let written = 0;
      for (const file of files) {
        const relative = `${folder}/${file.path}`.replace(/\/{2,}/g, "/");
        const absolute = join(workspace.root, relative);
        let existing: string | undefined;
        try {
          existing = await readFile(absolute, "utf8");
        } catch {
          existing = undefined;
        }
        if (existing === file.contents) continue;
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, file.contents, "utf8");
        written++;
      }
      await refresh();
      res.json({ written, total: files.length, folder });
      return;
    }

    const withStatus = await Promise.all(
      files.map(async (file) => {
        const path = `${folder}/${file.path}`.replace(/\/{2,}/g, "/");
        let existing: string | undefined;
        try {
          existing = await readFile(join(workspace.root, path), "utf8");
        } catch {
          existing = undefined;
        }
        return {
          path,
          kind: file.kind,
          contents: file.contents,
          status:
            existing === undefined ? "new" : existing === file.contents ? "unchanged" : "modified",
        };
      }),
    );

    res.json({
      folder,
      files: withStatus,
      counts: {
        new: withStatus.filter((file) => file.status === "new").length,
        modified: withStatus.filter((file) => file.status === "modified").length,
        unchanged: withStatus.filter((file) => file.status === "unchanged").length,
      },
    });
  }),
);

/** CODEOWNERS from ownership metadata, so approvals are enforced by branch protection. */
generationRoutes.post(
  "/api/generate/codeowners",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const contents = generateCodeowners(workspace.graph, (id) => workspace.pathById.get(id));

    if ((req.body as { write?: boolean }).write) {
      await writeFile(join(workspace.root, "CODEOWNERS"), contents, "utf8");
      await refresh();
      res.json({ written: true, path: "CODEOWNERS" });
      return;
    }
    res.json({ path: "CODEOWNERS", contents });
  }),
);

