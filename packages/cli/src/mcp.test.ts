import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { TOOLS, handle } from "./mcp.js";

/**
 * The MCP server, driven through its own protocol.
 *
 * Tested at the JSON-RPC boundary rather than by calling the tool functions directly, because the
 * boundary is where the interesting behaviour lives: notifications must not be answered, an
 * unknown tool must be a protocol error, and a *tool* failure must not be, it has to come back
 * as tool output the model can read and correct itself from.
 *
 * The one property worth stating outright is that this server cannot write. That is asserted
 * here as a test rather than left as a comment, because it is the guarantee the git-native design
 * depends on: an agent that could edit YAML directly would bypass every review control the tool
 * exists to provide.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

const load = (): Promise<LoadedWorkspace> => loadWorkspace(root);

/** Send one request and return the parsed `result`, failing loudly on a protocol error. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const response = (await handle(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    load,
  )) as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };

  expect(response.error).toBeUndefined();
  const text = response.result!.content[0]!.text;
  return response.result!.isError ? { isError: true, text } : JSON.parse(text);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-mcp-"));

  await write(
    "strata.config.yaml",
    `version: 1
name: mcp-fixture
roots:
  - "."
`,
  );
  await write(
    "models/model.yaml",
    `id: mdl
kind: model
name: warehouse
tier: physical
namespace: retail
`,
  );
  await write(
    "models/raw_customer.yaml",
    `id: tbl_raw
kind: table
name: raw_customer
model: warehouse
columns:
  - id: c_raw_email
    name: email_address
    dataType: STRING
`,
  );
  await write(
    "models/dim_customer.yaml",
    `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
description: One row per customer.
columns:
  - id: c_dim_key
    name: customer_key
    dataType: INT64
  - id: c_dim_email
    name: email_address
    dataType: STRING
    classification:
      sensitivity: confidential
      categories: [pii]
primaryKey:
  - customer_key
`,
  );
  await write(
    "models/load_dim.yaml",
    `id: map_dim
kind: mapping
name: load_dim_customer
model: warehouse
target: dim_customer
sources:
  - alias: r
    ref: raw_customer
columnMappings:
  - target: email_address
    sources:
      - r.email_address
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("the protocol", () => {
  it("announces itself on initialize", async () => {
    const response = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, load)) as {
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
    };

    expect(response.result.serverInfo.name).toBe("strata");
    expect(response.result.capabilities.tools).toBeDefined();
  });

  it("does not answer a notification", async () => {
    /*
      By the spec a notification carries no id and gets no response. Replying to one is a
      violation that some clients tolerate and others hang on, which presents to the user as
      the server simply not working.
    */
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, load)).toBeUndefined();
  });

  it("lists every tool with a schema", async () => {
    const response = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, load)) as {
      result: { tools: { name: string; description: string; inputSchema: object }[] };
    };

    expect(response.result.tools.map((tool) => tool.name).sort()).toEqual([
      "classification_suggestions",
      "cost_advice",
      "diagnostics",
      "dictionary",
      "get_object",
      "impact",
      "lineage",
      "list_models",
      "search",
    ]);
    for (const tool of response.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("rejects an unknown method as a protocol error", async () => {
    const response = (await handle({ jsonrpc: "2.0", id: 1, method: "nope" }, load)) as {
      error: { code: number };
    };
    expect(response.error.code).toBe(-32601);
  });

  it("rejects an unknown tool as a protocol error", async () => {
    const response = (await handle(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_everything" } },
      load,
    )) as { error: { code: number } };
    expect(response.error.code).toBe(-32602);
  });

  it("returns a tool failure as readable output, not a protocol error", async () => {
    /*
      The distinction the model depends on. A protocol error never reaches it; "no object named
      `dim_custmoer`" is exactly the information it needs to correct the typo and try again.
    */
    const result = (await call("get_object", { object: "dim_custmoer" })) as {
      isError: boolean;
      text: string;
    };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("dim_custmoer");
  });
});

describe("read-only", () => {
  it("exposes no tool that can write", () => {
    /*
      Asserted rather than assumed. An agent that could edit YAML directly would bypass the
      branch-and-pull-request path that every review control in this product is built on.
    */
    const suspicious = /create|update|delete|write|set_|edit|propose|commit|apply|rename/i;
    expect(TOOLS.filter((tool) => suspicious.test(tool.name))).toEqual([]);
  });

  it("leaves the workspace untouched after every tool runs", async () => {
    const before = JSON.stringify((await load()).graph.all().map((entry) => entry.object));

    await call("list_models");
    await call("search", { query: "customer" });
    await call("get_object", { object: "dim_customer" });
    await call("dictionary", { model: "warehouse" });
    await call("lineage", { object: "dim_customer" });
    await call("impact", { object: "raw_customer" });
    await call("diagnostics");
    await call("cost_advice");
    await call("classification_suggestions");

    expect(JSON.stringify((await load()).graph.all().map((entry) => entry.object))).toBe(before);
  });
});

describe("the tools", () => {
  it("list_models reports tier and domain", async () => {
    const models = (await call("list_models")) as { name: string; tier: string; namespace: string }[];
    expect(models).toHaveLength(1);
    expect(models[0]!.tier).toBe("physical");
    expect(models[0]!.namespace).toBe("retail");
  });

  it("search finds an object by name", async () => {
    const result = (await call("search", { query: "dim_customer" })) as {
      groups: { items: { name: string }[] }[];
    };
    expect(JSON.stringify(result)).toContain("dim_customer");
  });

  it("get_object resolves a plain name, not just an id", async () => {
    // Agents pass the name that appears in a prompt or a SQL file, never the internal id.
    const detail = (await call("get_object", { object: "dim_customer" })) as {
      object: { id: string; name: string };
    };
    expect(detail.object.id).toBe("tbl_dim");
  });

  it("get_object also accepts the id directly", async () => {
    const detail = (await call("get_object", { object: "tbl_dim" })) as { object: { name: string } };
    expect(detail.object.name).toBe("dim_customer");
  });

  it("dictionary carries the classification", async () => {
    const view = (await call("dictionary", { model: "warehouse" })) as {
      rows: { name: string; sensitivity?: string; categories: string[] }[];
    };

    const email = view.rows.find((row) => row.name === "email_address" && row.sensitivity);
    expect(email!.sensitivity).toBe("confidential");
    expect(email!.categories).toContain("pii");
  });

  it("lineage follows a mapping between two tables", async () => {
    const result = (await call("lineage", { object: "dim_customer", direction: "upstream" })) as {
      edges: { from: { objectName: string }; to: { objectName: string } }[];
    };
    expect(result.edges.some((edge) => edge.from.objectName === "raw_customer")).toBe(true);
  });

  it("impact names what a change would reach, with a reason", async () => {
    const result = (await call("impact", { object: "raw_customer" })) as {
      entries: { objectName: string; severity: string; reason: string }[];
    };

    const hit = result.entries.find((entry) => entry.objectName === "dim_customer");
    expect(hit).toBeDefined();
    expect(hit!.reason.length).toBeGreaterThan(0);
  });

  it("diagnostics filters by severity", async () => {
    const all = (await call("diagnostics")) as { counts: { error: number; warning: number } };
    const errors = (await call("diagnostics", { severity: "error" })) as {
      items: { severity: string }[];
    };

    expect(errors.items.every((item) => item.severity === "error")).toBe(true);
    expect(errors.items).toHaveLength(all.counts.error);
  });

  it("refuses an ambiguous name rather than guessing", async () => {
    await write(
      "models/other.yaml",
      `id: mdl2
kind: model
name: staging
tier: physical
---
id: tbl_dupe
kind: table
name: dim_customer
model: staging
columns:
  - id: cx
    name: k
    dataType: INT64
`,
    );

    /*
      Two tables of the same name in different models. Resolving to whichever loaded first would
      give a confident answer about the wrong object, which is worse than refusing.
    */
    const result = (await call("get_object", { object: "dim_customer" })) as {
      isError: boolean;
      text: string;
    };
    expect(result.isError).toBe(true);
    expect(result.text).toContain("ambiguous");
  });
});
