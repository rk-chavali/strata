import { createInterface } from "node:readline";
import { validate, lintNames, type Diagnostic } from "@strata/metamodel";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { VERSION } from "./version.js";
import {
  advise,
  adviceSummary,
  classificationCoverage,
  dictionaryView,
  impact,
  lineage,
  modelViews,
  objectDetail,
  search,
  suggestClassifications,
} from "@strata/query";

/**
 * An MCP server over the model, so an agent can read it directly.
 *
 * This is the cheapest large capability in the product and the one that most obviously follows
 * from the premise. The model is YAML in git, the queries are pure functions over a graph, and an
 * agent asking "what feeds `dim_customer.email`" wants exactly the answer the lineage panel
 * already computes. Nothing here is new logic, every tool is a thin wrapper over a function the
 * web UI has been calling and the test suite has been covering all along.
 *
 * **Read-only, and structurally so.** There is no write tool, no edit path, and nothing imported
 * that could perform one: the whole server depends on `@strata/query` and the loader, neither of
 * which can mutate a workspace. That is deliberate. An agent that can propose a change should do
 * it the way a person does, a branch and a pull request someone reviews, not by writing YAML
 * behind everyone's back. The moment this could write, every guarantee the git-native design
 * makes about reviewability would have a hole in it.
 *
 * **No SDK.** The stdio transport is newline-delimited JSON-RPC 2.0 and the subset a read-only
 * server needs is four methods. Taking a dependency to save this much code would be a poor trade
 * for a package that ships as a CLI people install.
 */

/** The protocol revision this server implements. */
const PROTOCOL_VERSION = "2024-11-05";

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, workspace: LoadedWorkspace) => unknown;
}

function string(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve what a human would type into the id the graph is keyed by.
 *
 * Agents pass names, `dim_customer`, because that is what appears in a prompt, a ticket and a
 * SQL file. Requiring `tbl_dim_customer` would make every tool a two-step dance where the agent
 * has to search first, and it would get that wrong often enough to matter.
 */
function resolveId(workspace: LoadedWorkspace, ref: string): string | undefined {
  if (workspace.graph.get(ref)) return ref;

  const lower = ref.toLowerCase();
  const matches = workspace.graph.all().filter((entry) => entry.object.name.toLowerCase() === lower);

  // An exact-name match is only useful when it is unambiguous; two tables of the same name in
  // different models would otherwise resolve to whichever happened to load first.
  return matches.length === 1 ? matches[0]!.object.id : undefined;
}

function allDiagnostics(workspace: LoadedWorkspace): Diagnostic[] {
  return [
    ...workspace.diagnostics,
    ...validate(workspace.graph),
    ...lintNames(workspace.graph, {
      severities: workspace.config.lint.rules,
      strict: workspace.config.lint.strict,
    }),
  ];
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "list_models",
    description:
      "List every model in the workspace with its tier (conceptual, logical or physical), " +
      "business domain, object count and validation problems.",
    inputSchema: { type: "object", properties: {} },
    run: (_args, workspace) => modelViews(workspace.graph, allDiagnostics(workspace)),
  },

  {
    name: "search",
    description:
      "Search the whole workspace: model names, object names, field and column names, " +
      "descriptions and glossary definitions. Use this first when you only know a name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        limit: { type: "number", description: "Maximum results. Defaults to 20." },
      },
      required: ["query"],
    },
    run: (args, workspace) =>
      search(workspace.graph, string(args, "query") ?? "", number(args, "limit") ?? 20),
  },

  {
    name: "get_object",
    description:
      "Everything about one object, its full definition, the file it lives in, and what " +
      "references it. Accepts an object id or an unambiguous name.",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Object id or name, e.g. `dim_customer`." },
      },
      required: ["object"],
    },
    run: (args, workspace) => {
      const ref = string(args, "object");
      if (!ref) throw new Error("`object` is required");
      const id = resolveId(workspace, ref);
      if (!id) throw new Error(`no object named \`${ref}\`, or the name is ambiguous`);
      return objectDetail(workspace, id);
    },
  },

  {
    name: "dictionary",
    description:
      "The data dictionary for one model: every field of every table and entity, with its type, " +
      "nullability, description, sensitivity, data categories and resolved policy tag.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Model name." } },
      required: ["model"],
    },
    run: (args, workspace) => {
      const model = string(args, "model");
      if (!model) throw new Error("`model` is required");
      return dictionaryView(workspace.graph, model);
    },
  },

  {
    name: "lineage",
    description:
      "Column-level lineage for an object, upstream or downstream. Built from mapping sources, " +
      "foreign keys, attribute references and model derivation. Mappings that use raw SQL are " +
      "reported as opaque rather than omitted.",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Object id or name." },
        column: { type: "string", description: "Narrow to one column or attribute." },
        direction: { type: "string", enum: ["upstream", "downstream"] },
        depth: { type: "number", description: "Hops to follow. Defaults to the full walk." },
      },
      required: ["object"],
    },
    run: (args, workspace) => {
      const ref = string(args, "object");
      if (!ref) throw new Error("`object` is required");
      const id = resolveId(workspace, ref);
      if (!id) throw new Error(`no object named \`${ref}\`, or the name is ambiguous`);

      const direction = string(args, "direction");
      return lineage(workspace.graph, id, {
        ...(string(args, "column") ? { column: string(args, "column")! } : {}),
        ...(direction === "upstream" || direction === "downstream" ? { direction } : {}),
        ...(number(args, "depth") ? { depth: number(args, "depth")! } : {}),
      });
    },
  },

  {
    name: "impact",
    description:
      "What breaks if this object or column changes. Every dependent is ranked `breaks`, " +
      "`rewrites` or `informational` with the reason. Ask this before proposing a schema change.",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Object id or name." },
        column: { type: "string", description: "Narrow to one column." },
        depth: { type: "number" },
      },
      required: ["object"],
    },
    run: (args, workspace) => {
      const ref = string(args, "object");
      if (!ref) throw new Error("`object` is required");
      const id = resolveId(workspace, ref);
      if (!id) throw new Error(`no object named \`${ref}\`, or the name is ambiguous`);

      return impact(workspace.graph, id, {
        ...(string(args, "column") ? { column: string(args, "column")! } : {}),
        ...(number(args, "depth") ? { depth: number(args, "depth")! } : {}),
      });
    },
  },

  {
    name: "cost_advice",
    description:
      "BigQuery cost findings read off the model: tables that will be scanned in full, missing " +
      "partition filters, and clustering that is invalid or wasted. Ranked worst first, weighted " +
      "by how many pipelines read each table. Ask this before approving a schema change.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Narrow to one model." } },
    },
    run: (args, workspace) => {
      const findings = advise(workspace.graph, string(args, "model"));
      return { summary: adviceSummary(findings), findings };
    },
  },

  {
    name: "classification_suggestions",
    description:
      "Columns that look like personal, payment, health or credential data but carry no " +
      "classification, with the category and sensitivity to apply and the rule that matched. " +
      "Read-only: accepting a suggestion is a person's decision, made in the app.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Narrow to one model." } },
    },
    run: (args, workspace) => {
      const model = string(args, "model");
      return {
        coverage: classificationCoverage(workspace.graph, model),
        suggestions: suggestClassifications(workspace.graph, model),
      };
    },
  },

  {
    name: "diagnostics",
    description:
      "Every validation error, warning and naming-standard violation in the workspace. " +
      "Errors here are what `strata check` fails on, so they block a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["error", "warning", "info"] },
      },
    },
    run: (args, workspace) => {
      const severity = string(args, "severity");
      const items = allDiagnostics(workspace).filter(
        (entry) => !severity || entry.severity === severity,
      );
      return {
        items,
        counts: {
          error: items.filter((d) => d.severity === "error").length,
          warning: items.filter((d) => d.severity === "warning").length,
          info: items.filter((d) => d.severity === "info").length,
        },
      };
    },
  },
];

/**
 * Handle one JSON-RPC message.
 *
 * Exported so the tests can drive the protocol without spawning a process and pumping stdio,
 * which would make them slow and flaky for no extra coverage, the transport is four lines and
 * the behaviour worth testing is all in here.
 *
 * Returns `undefined` for notifications, which by the spec get no response at all. Replying to
 * one is a protocol violation that some clients tolerate and others hang on.
 */
export async function handle(
  request: Request,
  loadWorkspaceAt: () => Promise<LoadedWorkspace>,
): Promise<object | undefined> {
  const reply = (result: unknown): object => ({ jsonrpc: "2.0", id: request.id ?? null, result });
  const fail = (code: number, message: string): object => ({
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code, message },
  });

  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "strata", version: VERSION },
      });

    // Notifications carry no id and must not be answered.
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;

    case "ping":
      return reply({});

    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const tool = TOOLS.find((entry) => entry.name === name);
      if (!tool) return fail(-32602, `no tool named \`${name}\``);

      const args =
        typeof request.params?.arguments === "object" && request.params.arguments !== null
          ? (request.params.arguments as Record<string, unknown>)
          : {};

      try {
        /*
          The workspace is reloaded per call, not cached.

          An agent holds a session open for a long time while a person edits files underneath it,
          and an answer computed from a stale graph is worse than a slow one, it is confidently
          wrong about a model that has since changed. Loading is milliseconds.
        */
        const result = tool.run(args, await loadWorkspaceAt());

        return reply({
          content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
        });
      } catch (error) {
        /*
          A tool failure is reported as tool output with `isError`, not as a JSON-RPC error.

          The distinction matters: a protocol error means the client sent something malformed and
          the model never sees it, whereas "no object named `dim_custmoer`" is information the
          model needs in order to correct itself and try again.
        */
        return reply({
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        });
      }
    }

    default:
      return fail(-32601, `unsupported method \`${request.method}\``);
  }
}

/**
 * Serve MCP over stdio until the client closes the stream.
 *
 * Nothing may be written to stdout that is not a protocol message, stdout *is* the transport,
 * and a stray `console.log` corrupts the stream in a way that presents to the user as the server
 * mysteriously not working. Diagnostics go to stderr.
 */
export async function serveMcp(cwd: string): Promise<number> {
  const loadWorkspaceAt = (): Promise<LoadedWorkspace> => loadWorkspace(cwd);

  // Fail fast with a readable message rather than surfacing as a broken tool call later.
  try {
    await loadWorkspaceAt();
  } catch (error) {
    process.stderr.write(
      `strata mcp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  process.stderr.write(`strata mcp: serving ${cwd}\n`);

  const lines = createInterface({ input: process.stdin });

  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }) + "\n",
      );
      continue;
    }

    const response = await handle(request, loadWorkspaceAt);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }

  return 0;
}
