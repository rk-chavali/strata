/**
 * First run: creating a workspace before there is one.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { initRepo } from "../git.js";
import { admins } from "../guards.js";
import { handler } from "../respond.js";
import { refresh, workspaceRoot } from "../workspacecache.js";
import { diagnoseRoot } from "../workspaceroot.js";
import { LAYOUT_PRESETS, initWorkspace } from "@strata/storage";

import { workspaceExists } from "../workspacecache.js";
export const setupRoutes = Router();

// ---------------------------------------------------------------- setup


/**
 * Create the model repo.
 *
 * This closes a genuine hole rather than adding a convenience. Before it, a self-hosted
 * instance started against an empty volume with no `STRATA_MODEL_REPO` to clone had no route
 * forward at all: startup bootstrap skips, `loadWorkspace` throws, and the UI showed
 * "Cannot read the model repo" with instructions to go and run a CLI command, inside a
 * container the operator may not have a shell on. The first thing the tool asked of a new
 * user was to leave it.
 *
 * `initWorkspace` from `@strata/storage` does the work, so this is the same code path as
 * `strata init` and cannot drift from it. Admin-only: it decides the layout every file in
 * the repo will be written under.
 */
setupRoutes.post(
  "/api/workspace/init",
  admins,
  handler(async (req, res) => {
    if (workspaceExists()) {
      // Not an error the UI should have offered, but refusing is the only safe answer:
      // rewriting the config of a populated repo would relocate every file in it.
      res.status(409).json({ error: `a workspace already exists at ${workspaceRoot()}` });
      return;
    }

    const body = (req.body ?? {}) as {
      name?: unknown;
      description?: unknown;
      preset?: unknown;
      gitInit?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(422).json({ error: "a workspace name is required" });
      return;
    }

    const preset =
      typeof body.preset === "string" && (LAYOUT_PRESETS as readonly string[]).includes(body.preset)
        ? (body.preset as (typeof LAYOUT_PRESETS)[number])
        : undefined;

    const description =
      typeof body.description === "string" && body.description.trim().length > 0
        ? body.description.trim()
        : undefined;

    /*
      A directory this cannot write to is reported, not swallowed into a generic 500.

      The one failure that actually happens here is a workspace path the container cannot
      create, and it happens for a reason nobody guesses from the UI: Git Bash on Windows
      rewrites `-e STRATA_WORKSPACE=/app/...` into a host path, so the server ends up pointed at
      something like `/app/C:/Program Files/...` and `mkdir` fails with EACCES. All the operator
      saw was "Something went wrong on the server", with the only useful detail in a container
      log they had no reason to open.

      The path is echoed back deliberately. It is the whole diagnosis: an operator who sees
      `/app/C:/Program Files/Git/...` knows instantly that their shell mangled the variable,
      and one who sees the path they expected knows it is genuinely a permissions problem.
    */
    try {
      await initWorkspace(workspaceRoot(), {
        name,
        ...(description ? { description } : {}),
        ...(preset ? { preset } : {}),
      });
    } catch (error) {
      /*
        Any filesystem error, not a list of codes.

        EACCES is what the mangled-path case produces, but a parent that is a file gives ENOTDIR,
        a read-only mount gives EROFS, and an over-long path on Windows gives ENAMETOOLONG. They
        are all the same answer to the operator, "this is not a directory I can create", and
        enumerating codes means the one that was not on the list falls through to a blank 500
        again. An error with no `code` is a real bug and still throws.
      */
      const code = (error as { code?: string }).code;
      if (typeof code !== "string") throw error;

      /*
        The same diagnosis the setup screen was given, rather than a second wording of it.

        This path is now mostly unreachable, because `/api/workspace` refuses to offer the button
        when the root is unwritable. It stays because the two calls are seconds apart and the
        filesystem can change between them, and because a client that posts directly still
        deserves the explanation rather than a bare error code.
      */
      const diagnosis = await diagnoseRoot(workspaceRoot());
      res.status(422).json({
        error:
          diagnosis.reason ??
          `Cannot create a repository at ${workspaceRoot()} (${code}).`,
        ...(diagnosis.hint ? { hint: diagnosis.hint } : {}),
        root: workspaceRoot(),
        code,
      });
      return;
    }

    /**
     * `git init`, when asked for.
     *
     * Offered rather than assumed. The whole premise is that the model is files in a git
     * repo, so a workspace that is not one is a half-built install, but the directory
     * may already be inside a parent repo, or the operator may intend to clone over it,
     * and silently creating a nested repository there would be worse than not trying.
     *
     * A failure here is reported without discarding the config that was just written: the
     * workspace is real and usable, it simply is not versioned yet.
     *
     * `POST /api/git/init` finishes the job later, which is what makes skipping it here safe.
     * Before that route existed this was a one-way door: unticking the box left the workspace
     * permanently un-versioned with no in-app recovery.
     */
    let gitInitialised = false;
    let gitError: string | undefined;
    if (body.gitInit === true) {
      try {
        await initRepo(workspaceRoot());
        gitInitialised = true;
      } catch (error) {
        gitError = error instanceof Error ? error.message : String(error);
      }
    }

    const workspace = await refresh();
    res.status(201).json({
      ok: true,
      root: workspace.root,
      name: workspace.config.name,
      gitInitialised,
      ...(gitError ? { gitError } : {}),
    });
  }),
);

