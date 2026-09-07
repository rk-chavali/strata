import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  generateCodeowners,
  generateDataform,
  generateModelDdl,
  type GeneratedFile,
} from "@strata/ddl";
import { loadWorkspace } from "@strata/storage";
import { EXIT, type ExitCode } from "./commands.js";
import { detail, failure, heading, info, success } from "./reporter.js";

/**
 * `strata generate`, emit DDL and governance artifacts.
 *
 * Everything written is a **new file in a folder you nominate**. Nothing here edits a
 * file a human wrote, which is what makes it safe to run unattended in CI and what
 * makes the diff trivially reviewable: it is all additions, or replacements of files
 * this command produced last time.
 */

export interface GenerateArgs {
  cwd: string;
  /** Restrict to one model. Default: every physical model. */
  model?: string;
  /** Output folder, relative to the repo root. */
  out: string;
  /** Path template within the output folder. */
  template?: string;
  /** Report what would be written without writing it. */
  dryRun: boolean;
  /** Emit `CREATE OR REPLACE` rather than `CREATE ... IF NOT EXISTS`. */
  orReplace: boolean;
  /** Also write a CODEOWNERS file from ownership metadata. */
  codeowners: boolean;
  /** Emit CREATE TABLE and policy-tag DDL. */
  ddl: boolean;
  /**
   * Emit Dataform SQLX from the mappings.
   *
   * Separate from DDL because the two go to different places and are owned by different
   * people: DDL describes the tables, SQLX describes how they are filled. A team may well
   * want one and not the other.
   */
  dataform: boolean;
  /** Where the Dataform project lives, relative to the repo root. */
  dataformOut?: string;
}

export async function commandGenerate(args: GenerateArgs): Promise<ExitCode> {
  const workspace = await loadWorkspace(args.cwd);

  const blocking = workspace.diagnostics.filter((d) => d.severity === "error");
  if (blocking.length > 0) {
    failure(`${blocking.length} file(s) could not be loaded; refusing to generate from a partial model`);
    for (const diagnostic of blocking.slice(0, 10)) {
      info(`  ${diagnostic.file ?? "<unknown>"}  ${diagnostic.message}`);
    }
    return EXIT.failure;
  }

  const physical = workspace.graph
    .models()
    .map((entry) => entry.object)
    .filter((model) => model.tier === "physical")
    .filter((model) => !args.model || model.name === args.model);

  if (physical.length === 0) {
    failure(
      args.model
        ? `no physical model named \`${args.model}\``
        : "this workspace has no physical models, so there is no DDL to generate",
    );
    return EXIT.failure;
  }

  const generated: GeneratedFile[] = [];
  if (args.ddl) {
    for (const model of physical) {
      generated.push(
        ...generateModelDdl(workspace.graph, model.name, {
          orReplace: args.orReplace,
          ...(args.template ? { pathTemplate: args.template } : {}),
        }),
      );
    }
  }

  /**
   * Dataform SQLX, written into the Dataform project rather than the DDL folder.
   *
   * Path templates come from the matching `dataform:` connection in `strata.config.yaml`
   * when there is one, so a team that has told the tool where its Dataform repo is
   * laid out does not have to repeat it on the command line.
   */
  const dataformFiles: { path: string; contents: string }[] = [];
  if (args.dataform) {
    for (const model of physical) {
      const connection = workspace.config.dataform.find(
        (candidate) => candidate.models.length === 0 || candidate.models.includes(model.name),
      );

      dataformFiles.push(
        ...generateDataform(workspace.graph, model.name, (connection?.paths ? { paths: connection.paths } : {})),
      );
    }
  }

  if (args.codeowners) {
    generated.push({
      path: "CODEOWNERS",
      contents: generateCodeowners(workspace.graph, (id) => workspace.pathById.get(id)),
      objectId: "codeowners",
      kind: "index",
    });
  }

  let written = 0;
  let unchanged = 0;

  const all: { path: string; contents: string; dataform?: boolean }[] = [
    ...generated,
    ...dataformFiles.map((file) => ({ ...file, dataform: true })),
  ];

  for (const file of all) {
    // CODEOWNERS belongs at the repo root, not inside the generated folder, GitHub
    // only reads it from `/`, `/.github` or `/docs`. Dataform files carry paths that
    // are already relative to the Dataform project, so they get their own root.
    const relative =
      file.path === "CODEOWNERS"
        ? file.path
        : join(file.dataform ? (args.dataformOut ?? "dataform") : args.out, file.path);
    const absolute = join(workspace.root, relative);

    let existing: string | undefined;
    try {
      existing = await readFile(absolute, "utf8");
    } catch {
      existing = undefined;
    }

    if (existing === file.contents) {
      unchanged++;
      continue;
    }

    if (!args.dryRun) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.contents, "utf8");
    }
    written++;
    info(`  ${args.dryRun ? "would write" : "wrote"}  ${relative.split("\\").join("/")}`);
  }

  info("");
  if (args.dryRun) {
    heading(`${written} file(s) would change, ${unchanged} already current`);
    detail("run without --dry-run to write them");
  } else {
    success(`${written} written, ${unchanged} unchanged`);
    detail("commit these separately from model changes so the diff stays readable");
  }

  return EXIT.ok;
}
