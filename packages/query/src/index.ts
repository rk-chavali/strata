/**
 * Read-only queries over a loaded model.
 *
 * These four modules were in `apps/server` and never belonged there. Every one of them is a pure
 * function over an `ObjectGraph`, no Express, no request, no filesystem, and being inside the
 * server app meant the only way to ask the model a question was to start an HTTP server and make
 * a request to yourself.
 *
 * Moving them out is what lets `strata mcp` exist: an MCP server is a stdio process, not a web
 * client, and it needs exactly these answers. The CLI now reuses the same implementations the web
 * UI calls, which matters more than the tidiness, two code paths answering "what does this
 * column feed" would eventually disagree, and the one nobody is looking at would be the wrong one.
 */

export * from "./search.js";
export * from "./lineage.js";
export * from "./dictionary.js";
export * from "./view.js";
export * from "./advisor.js";
export * from "./classify.js";
