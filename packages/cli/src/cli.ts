import { parseArgs, type ParseArgsConfig } from "node:util";
import { LAYOUT_PRESETS, WorkspaceNotFoundError, type LayoutPreset } from "@strata/storage";
import {
  EXIT,
  commandCheck,
  commandFormat,
  commandInfo,
  commandInit,
  commandReorganize,
  type ExitCode,
} from "./commands.js";
import { commandGenerate } from "./generate.js";
import { OUTPUT_FORMATS, failure, info, type OutputFormat } from "./reporter.js";
import { VERSION } from "./version.js";

export { VERSION };

const HELP = `strata, data modelling CLI

USAGE
  strata <command> [options]

COMMANDS
  init [dir]        Create a model repo (writes strata.config.yaml)
  check             Validate structure and lint names, the recommended CI gate
  validate          Structural and referential integrity only
  lint              Naming standards only
  fmt               Rewrite every file in canonical form
  reorganize        Move files to the configured layout
  generate ddl      Emit CREATE TABLE and policy-tag DDL
  generate dataform Emit Dataform SQLX from the mappings
  generate all      Both
  info              Summarise the workspace
  mcp               Serve the model to an AI agent over MCP (read-only, stdio)

COMMON OPTIONS
  --cwd <path>      Run as if in this directory (default: current)
  --format <fmt>    Output format: ${OUTPUT_FORMATS.join(" | ")} (default: pretty)
  --strict          Treat warnings as errors
  -h, --help        Show help
  -v, --version     Show version

COMMAND OPTIONS
  init   --name <name>       Workspace name (default: directory name)
         --preset <preset>   Initial file layout (default: by-model-and-kind)
  fmt    --check             Report non-canonical files without rewriting them
  reorganize
         --preset <preset>   Switch layout and move files (saved to config)
         --dry-run           Show the moves without writing
  generate ddl
         --out <folder>      Where to write (default: DDL)
         --model <name>      One model only (default: every physical model)
         --template <path>   Path template, e.g. "{dataset}/{name}.sql"
         --or-replace        CREATE OR REPLACE instead of CREATE IF NOT EXISTS
         --codeowners        Also write CODEOWNERS from ownership metadata
         --dry-run           Show what would be written

LAYOUT PRESETS
  ${LAYOUT_PRESETS.join(", ")}

EXIT CODES
  0  clean    1  findings    2  usage or internal error

EXAMPLES
  strata init my-models --preset by-layer
  strata check --format github --strict
  strata reorganize --preset single-file-per-model --dry-run
  strata mcp                       # register in an MCP client; speaks JSON-RPC on stdio
`;

interface GlobalOptions {
  cwd: string;
  format: OutputFormat;
  strict: boolean;
}

export async function run(argv: readonly string[]): Promise<ExitCode> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    info(HELP);
    return EXIT.ok;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    info(VERSION);
    return EXIT.ok;
  }

  try {
    return await dispatch(command, rest);
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) {
      failure(error.message);
      info("");
      info("Run `strata init` to create one.");
      return EXIT.failure;
    }
    // Argument parsing and schema errors are user errors, not crashes; report the
    // message rather than a stack trace, which is noise in a terminal or CI log.
    failure(error instanceof Error ? error.message : String(error));
    if (process.env.STRATA_DEBUG && error instanceof Error && error.stack) {
      info(error.stack);
    }
    return EXIT.failure;
  }
}

async function dispatch(command: string, args: readonly string[]): Promise<ExitCode> {
  switch (command) {
    case "init": {
      const { values, positionals } = parse(args, {
        name: { type: "string" },
        preset: { type: "string" },
      });
      return commandInit({
        directory: positionals[0] ?? ".",
        ...(values.name ? { name: String(values.name) } : {}),
        ...(values.preset ? { preset: parsePreset(values.preset) } : {}),
      });
    }

    case "check": {
      const options = globals(args);
      return commandCheck({ ...options, structural: true, naming: true });
    }

    case "validate": {
      const options = globals(args);
      return commandCheck({ ...options, structural: true, naming: false });
    }

    case "lint": {
      const options = globals(args);
      return commandCheck({ ...options, structural: false, naming: true });
    }

    case "fmt":
    case "format": {
      const { values } = parse(args, { cwd: { type: "string" }, check: { type: "boolean" } });
      return commandFormat({
        cwd: values.cwd ? String(values.cwd) : process.cwd(),
        checkOnly: values.check === true,
      });
    }

    case "reorganize":
    case "reorganise": {
      const { values } = parse(args, {
        cwd: { type: "string" },
        preset: { type: "string" },
        "dry-run": { type: "boolean" },
      });
      return commandReorganize({
        cwd: values.cwd ? String(values.cwd) : process.cwd(),
        ...(values.preset ? { preset: parsePreset(values.preset) } : {}),
        dryRun: values["dry-run"] === true,
      });
    }

    case "mcp": {
      /*
        Long-running and stdio-bound, so it deliberately sidesteps the reporter every other
        command uses: stdout *is* the protocol transport here, and a formatted heading written to
        it would corrupt the stream.
      */
      const { values } = parse(args, { cwd: { type: "string" } });
      const { serveMcp } = await import("./mcp.js");
      const code = await serveMcp(values.cwd ? String(values.cwd) : process.cwd());
      return code === 0 ? EXIT.ok : EXIT.failure;
    }

    case "info": {
      const options = globals(args);
      return commandInfo({ cwd: options.cwd, format: options.format });
    }

    case "generate": {
      const { values, positionals } = parse(args, {
        cwd: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
        template: { type: "string" },
        "dry-run": { type: "boolean" },
        "or-replace": { type: "boolean" },
        codeowners: { type: "boolean" },
        "dataform-out": { type: "string" },
      });

      /**
       * `ddl`, `dataform`, or `all`.
       *
       * They are separate targets because they land in different repositories and are
       * owned by different people: DDL describes the tables, SQLX describes how they are
       * filled, and a team may well run one in CI and not the other.
       */
      const what = positionals[0] ?? "ddl";
      if (what !== "ddl" && what !== "dataform" && what !== "all") {
        failure(`unknown generate target \`${what}\` (expected \`ddl\`, \`dataform\` or \`all\`)`);
        return EXIT.failure;
      }

      return commandGenerate({
        cwd: values.cwd ? String(values.cwd) : process.cwd(),
        ...(values.model ? { model: String(values.model) } : {}),
        out: values.out ? String(values.out) : "DDL",
        ...(values.template ? { template: String(values.template) } : {}),
        dryRun: values["dry-run"] === true,
        orReplace: values["or-replace"] === true,
        codeowners: values.codeowners === true,
        ddl: what === "ddl" || what === "all",
        dataform: what === "dataform" || what === "all",
        ...(values["dataform-out"] ? { dataformOut: String(values["dataform-out"]) } : {}),
      });
    }

    default:
      failure(`unknown command \`${command}\``);
      info("");
      info("Run `strata --help` to see the available commands.");
      return EXIT.failure;
  }
}

type OptionSpec = NonNullable<ParseArgsConfig["options"]>;

function parse(
  args: readonly string[],
  options: OptionSpec,
): { values: Record<string, unknown>; positionals: string[] } {
  const result = parseArgs({
    args: [...args],
    options: { ...options, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true,
  });
  return { values: result.values as Record<string, unknown>, positionals: result.positionals };
}

function globals(args: readonly string[]): GlobalOptions {
  const { values } = parse(args, {
    cwd: { type: "string" },
    format: { type: "string" },
    strict: { type: "boolean" },
  });

  return {
    cwd: values.cwd ? String(values.cwd) : process.cwd(),
    format: parseFormat(values.format),
    strict: values.strict === true,
  };
}

function parseFormat(value: unknown): OutputFormat {
  if (value === undefined) return "pretty";
  const candidate = String(value);
  if ((OUTPUT_FORMATS as readonly string[]).includes(candidate)) return candidate as OutputFormat;
  throw new Error(`unknown format \`${candidate}\` (expected: ${OUTPUT_FORMATS.join(", ")})`);
}

function parsePreset(value: unknown): LayoutPreset {
  const candidate = String(value);
  if ((LAYOUT_PRESETS as readonly string[]).includes(candidate)) return candidate as LayoutPreset;
  throw new Error(`unknown layout preset \`${candidate}\` (expected: ${LAYOUT_PRESETS.join(", ")})`);
}
