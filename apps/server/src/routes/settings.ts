/**
 * Workspace settings and the file layout presets.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { ROLES } from "../auth.js";
import { DATA_DIR } from "../env.js";
import { admins, editors, readers } from "../guards.js";
import { handler } from "../respond.js";
import { auth, secrets } from "../services.js";
import { TUNABLE_RULES, applySettings, readSettings } from "../settings.js";
import { getWorkspace, refresh } from "../workspacecache.js";
import { LAYOUT_PRESETS, type LoadedWorkspace, planWrites, saveWorkspace, setLayoutPreset } from "@strata/storage";

export const settingsRoutes = Router();

// ---------------------------------------------------------------- settings

settingsRoutes.get(
  "/api/settings",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    res.json({
      settings: readSettings(workspace.config),
      presets: LAYOUT_PRESETS,
      tunableRules: TUNABLE_RULES,
      auth: { enabled: !auth.disabled, roles: ROLES },
      server: {
        workspace: workspace.root,
        dataDir: DATA_DIR,
        githubTokenConfigured: (await secrets().status()).configured,
      },
    });
  }),
);

settingsRoutes.put(
  "/api/settings",
  admins,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    await applySettings(workspace.root, req.body as Parameters<typeof applySettings>[1]);
    const reloaded = await refresh();
    res.json({ settings: readSettings(reloaded.config) });
  }),
);

// ---------------------------------------------------------------- layout presets

settingsRoutes.post(
  "/api/layout/preview",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const preset = String((req.body as { preset?: unknown }).preset ?? "");
    if (!(LAYOUT_PRESETS as readonly string[]).includes(preset)) {
      res.status(400).json({ error: `unknown preset \`${preset}\`` });
      return;
    }
    const candidate: LoadedWorkspace = {
      ...workspace,
      config: { ...workspace.config, layout: { ...workspace.config.layout, preset: preset as never } },
    };
    const plan = planWrites(candidate);
    res.json({ preset, moves: plan.moves, fileCount: plan.writes.length });
  }),
);

settingsRoutes.post(
  "/api/layout/apply",
  editors,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const preset = String((req.body as { preset?: unknown }).preset ?? "");
    if (!(LAYOUT_PRESETS as readonly string[]).includes(preset)) {
      res.status(400).json({ error: `unknown preset \`${preset}\`` });
      return;
    }
    if (workspace.diagnostics.some((d) => d.severity === "error")) {
      res.status(409).json({ error: "some files failed to load; fix those before reorganising" });
      return;
    }

    await setLayoutPreset(workspace.root, preset);
    const result = await saveWorkspace(await refresh());
    await refresh();
    res.json({ preset, written: result.written.length, deleted: result.deleted.length });
  }),
);

