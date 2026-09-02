import {
  type Column,
  type Entity,
  type Model,
  type ObjectGraph,
  type Table,
} from "@strata/metamodel";
import { effectiveClassification } from "./taxonomy.js";

/**
 * The data dictionary as a document.
 *
 * The feature every evaluator asks for in the first ten minutes, and the one erwin charges
 * for a separate Report Designer to provide. It exists because the people who need to read a
 * model are mostly not the people who edit it: an auditor, a downstream analyst, a new joiner
 * on their first day. None of them should have to install a modelling tool.
 *
 * Two formats, for two different destinations. **Markdown** commits to the repo, so every
 * pull request shows a readable diff of what the model now says, which is the git-native
 * trick no SaaS competitor can do. **HTML** is self-contained and styled, for pasting into a
 * wiki or handing to someone who wants a document rather than a diff.
 *
 * Deliberately a pure function over the graph: no filesystem, no config, no network. That is
 * what lets the same generator run in the app, in `strata docs`, and in CI.
 */

export interface DocsOptions {
  /** One model, or every model when omitted. */
  model?: string;
  format: "markdown" | "html";
  /** Include the classification columns. Default true. */
  governance?: boolean;
  /** Resolve inherited classification. Supplied so docs agree with generated policy tags. */
  resolveClassification?: boolean;
  /** Shown in the header, so a committed document says where it came from. */
  workspaceName?: string;
  /**
   * Stamped into the header. Passed in rather than read from the clock so the output is
   * reproducible, a generator that embeds `Date.now()` produces a diff on every run, and a
   * document that changes when nothing changed is a document people stop reading.
   */
  generatedAt?: string;
}

export interface DocFile {
  path: string;
  contents: string;
}

/** One row of the dictionary, flattened for rendering. */
interface Field {
  name: string;
  path: string;
  type: string;
  required: boolean;
  key: string;
  description: string;
  sensitivity: string;
  categories: string;
  depth: number;
}

export function generateDocs(graph: ObjectGraph, options: DocsOptions): DocFile[] {
  const models = options.model
    ? [graph.modelNamed(options.model)].filter((model): model is Model => Boolean(model))
    : graph.models().map((loaded) => loaded.object);

  if (models.length === 0) {
    throw new Error(options.model ? `no model named \`${options.model}\`` : "this workspace has no models");
  }

  const extension = options.format === "html" ? "html" : "md";
  const files: DocFile[] = [];

  for (const model of models) {
    const contents =
      options.format === "html" ? renderHtml(graph, model, options) : renderMarkdown(graph, model, options);
    files.push({ path: `${model.name}.${extension}`, contents });
  }

  /*
    An index only when there is more than one model.

    A single-model workspace getting an index that links to one page is noise, and it is the
    shape most workspaces start in.
  */
  if (models.length > 1) {
    files.push({
      path: `index.${extension}`,
      contents:
        options.format === "html"
          ? renderHtmlIndex(models, options)
          : renderMarkdownIndex(models, options),
    });
  }

  return files;
}

/** Everything in one model, as flat field lists per object. */
function collect(
  graph: ObjectGraph,
  model: Model,
  options: DocsOptions,
): { object: Table | Entity; fields: Field[] }[] {
  const result: { object: Table | Entity; fields: Field[] }[] = [];

  const objects = graph
    .inModel(model.name)
    .map((loaded) => loaded.object)
    .filter((object): object is Table | Entity => object.kind === "table" || object.kind === "entity")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const object of objects) {
    const fields: Field[] = [];

    if (object.kind === "table") {
      const keys = new Set((object.primaryKey ?? []).map((name) => name.toLowerCase()));
      const foreign = new Set(
        (object.foreignKeys ?? []).flatMap((fk) => fk.columns.map((name) => name.toLowerCase())),
      );

      for (const { column, path, depth } of walkColumnsWithDepth(object.columns ?? [])) {
        const classification =
          options.resolveClassification === false
            ? column.classification
            : effectiveClassification(column, graph, model.name);

        fields.push({
          name: column.name,
          path,
          type: column.dataType,
          required: column.mode === "REQUIRED",
          key: depth === 0 && keys.has(column.name.toLowerCase())
            ? "PK"
            : depth === 0 && foreign.has(column.name.toLowerCase())
              ? "FK"
              : "",
          description: column.description ?? "",
          sensitivity: classification?.sensitivity ?? "",
          categories: (classification?.categories ?? []).join(", "),
          depth,
        });
      }
    } else {
      const keys = new Set((object.primaryKey ?? []).map((name) => name.toLowerCase()));
      for (const attribute of object.attributes ?? []) {
        fields.push({
          name: attribute.name,
          path: attribute.name,
          type: attribute.logicalType ?? (attribute.domain ? `→ ${attribute.domain}` : ""),
          required: attribute.required ?? false,
          key: keys.has(attribute.name.toLowerCase()) ? "PK" : "",
          description: attribute.description ?? "",
          sensitivity: attribute.classification?.sensitivity ?? "",
          categories: (attribute.classification?.categories ?? []).join(", "),
          depth: 0,
        });
      }
    }

    result.push({ object, fields });
  }

  return result;
}

/**
 * `walkColumns` from the metamodel does not report depth, and the document needs it to indent
 * STRUCT fields. Wrapping rather than changing the shared helper, whose callers do not.
 */
function walkColumnsWithDepth(
  columns: Column[],
  prefix = "",
  depth = 0,
): { column: Column; path: string; depth: number }[] {
  const result: { column: Column; path: string; depth: number }[] = [];
  for (const column of columns) {
    const path = prefix ? `${prefix}.${column.name}` : column.name;
    result.push({ column, path, depth });
    if (column.fields?.length) result.push(...walkColumnsWithDepth(column.fields, path, depth + 1));
  }
  return result;
}

// ---------------------------------------------------------------- markdown

function renderMarkdown(graph: ObjectGraph, model: Model, options: DocsOptions): string {
  const lines: string[] = [];
  const sections = collect(graph, model, options);
  const governance = options.governance !== false;

  lines.push(`# ${model.name}`);
  lines.push("");
  if (model.description) lines.push(model.description, "");

  lines.push(`- **Tier**: ${model.tier}`);
  if (model.namespace) lines.push(`- **Domain**: ${model.namespace}`);
  if (model.derivedFrom) lines.push(`- **Derived from**: ${model.derivedFrom}`);
  if (model.target?.project) lines.push(`- **BigQuery project**: \`${model.target.project}\``);
  if (model.target?.dataset) lines.push(`- **Default dataset**: \`${model.target.dataset}\``);
  lines.push(`- **Objects**: ${sections.length}`);
  if (options.generatedAt) lines.push(`- **Generated**: ${options.generatedAt}`);
  lines.push("");

  const classified = sections
    .flatMap((section) => section.fields)
    .filter((field) => field.sensitivity || field.categories).length;
  const total = sections.reduce((sum, section) => sum + section.fields.length, 0);

  if (governance && total > 0) {
    lines.push(`- **Classified fields**: ${classified} of ${total}`);
    lines.push("");
  }

  lines.push("## Contents", "");
  for (const { object, fields } of sections) {
    lines.push(`- [${object.name}](#${anchor(object.name)}), ${fields.length} field(s)`);
  }
  lines.push("");

  for (const { object, fields } of sections) {
    lines.push(`## ${object.name}`, "");
    if (object.description) lines.push(object.description, "");

    if (object.kind === "table") {
      const bits: string[] = [];
      if (object.dataset) bits.push(`dataset \`${object.dataset}\``);
      if (object.layer) bits.push(`layer \`${object.layer}\``);
      if (object.grain) bits.push(`grain: ${object.grain}`);
      if (bits.length > 0) lines.push(bits.join(" · "), "");
    }

    const header = governance
      ? "| Field | Type | Null | Key | Sensitivity | Categories | Description |"
      : "| Field | Type | Null | Key | Description |";
    const rule = governance
      ? "| --- | --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- |";

    lines.push(header, rule);
    for (const field of fields) {
      // Non-breaking spaces for indentation: a markdown table cell collapses ordinary
      // leading whitespace, so a STRUCT field would render flush with its parent.
      const indent = "&nbsp;".repeat(field.depth * 4);
      const cells = [
        `${indent}\`${field.name}\``,
        `\`${field.type}\``,
        field.required ? "NOT NULL" : "",
        field.key,
        ...(governance ? [field.sensitivity, field.categories] : []),
        escapeCell(field.description),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  const relationships = graph
    .inModel(model.name)
    .map((loaded) => loaded.object)
    .filter((object) => object.kind === "relationship");

  if (relationships.length > 0) {
    lines.push("## Relationships", "");
    lines.push("| Parent | Child | Cardinality | Identifying |");
    lines.push("| --- | --- | --- | --- |");
    for (const relationship of relationships) {
      if (relationship.kind !== "relationship") continue;
      lines.push(
        `| ${relationship.parent.ref} | ${relationship.child.ref} | ${relationship.parent.cardinality} → ${relationship.child.cardinality} | ${relationship.identifying ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderMarkdownIndex(models: Model[], options: DocsOptions): string {
  const lines = [`# ${options.workspaceName ?? "Data models"}`, ""];
  if (options.generatedAt) lines.push(`Generated ${options.generatedAt}`, "");
  for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- [${model.name}](${model.name}.md), ${model.tier}${model.description ? `. ${model.description}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/** A markdown cell cannot hold a raw pipe or newline without breaking the table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ---------------------------------------------------------------- html

/**
 * Self-contained HTML: styles inline, no scripts, no external requests.
 *
 * A document that fetches a stylesheet is a document that renders unstyled inside a wiki,
 * behind a proxy, or from a file:// URL, which is where these actually get opened.
 */
function renderHtml(graph: ObjectGraph, model: Model, options: DocsOptions): string {
  const sections = collect(graph, model, options);
  const governance = options.governance !== false;

  const rows = sections
    .map(({ object, fields }) => {
      const meta =
        object.kind === "table"
          ? [
              object.dataset ? `dataset <code>${esc(object.dataset)}</code>` : "",
              object.layer ? `layer <code>${esc(object.layer)}</code>` : "",
              object.grain ? `grain: ${esc(object.grain)}` : "",
            ].filter(Boolean).join(" · ")
          : "";

      const body = fields
        .map(
          (field) => `<tr>
  <td class="f"${field.depth ? ` style="padding-left:${12 + field.depth * 16}px"` : ""}><code>${esc(field.name)}</code></td>
  <td><code class="t">${esc(field.type)}</code></td>
  <td class="c">${field.required ? "●" : ""}</td>
  <td class="c k">${esc(field.key)}</td>
  ${governance ? `<td>${esc(field.sensitivity)}</td><td>${field.categories ? `<span class="cat">${esc(field.categories)}</span>` : ""}</td>` : ""}
  <td class="d">${esc(field.description)}</td>
</tr>`,
        )
        .join("\n");

      return `<section id="${anchor(object.name)}">
  <h2>${esc(object.name)} <span class="kind">${object.kind}</span></h2>
  ${object.description ? `<p class="desc">${esc(object.description)}</p>` : ""}
  ${meta ? `<p class="meta">${meta}</p>` : ""}
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Null</th><th>Key</th>${governance ? "<th>Sensitivity</th><th>Categories</th>" : ""}<th>Description</th></tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
</section>`;
    })
    .join("\n");

  const total = sections.reduce((sum, section) => sum + section.fields.length, 0);
  const classified = sections
    .flatMap((section) => section.fields)
    .filter((field) => field.sensitivity || field.categories).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.name)}, data dictionary</title>
<style>
:root { color-scheme: light dark; --fg:#1a2029; --mut:#5b6673; --line:#e2e6eb; --bg:#fff; --code:#f4f6f8; --acc:#2f6feb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6eaf0; --mut:#98a4b3; --line:#2a323d; --bg:#14181e; --code:#1c222a; } }
* { box-sizing: border-box; }
body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size:26px; margin:0 0 4px; letter-spacing:-0.02em; }
h2 { font-size:17px; margin:36px 0 6px; letter-spacing:-0.01em; }
.kind { font-size:11px; font-weight:500; color:var(--mut); text-transform:uppercase; letter-spacing:0.06em; }
.sub, .meta, .desc { color:var(--mut); }
.meta, .desc { margin:2px 0 10px; font-size:13px; }
dl { display:grid; grid-template-columns:auto 1fr; gap:2px 12px; margin:14px 0 24px; font-size:13px; }
dt { color:var(--mut); }
dd { margin:0; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--mut);
  border-bottom:1px solid var(--line); padding:6px 8px; font-weight:600; }
td { border-bottom:1px solid var(--line); padding:5px 8px; vertical-align:top; }
td.c { text-align:center; }
td.k { font-size:11px; font-weight:600; color:var(--acc); }
td.d { color:var(--mut); }
code { background:var(--code); padding:1px 4px; border-radius:3px;
  font:12px ui-monospace,"Cascadia Mono",Consolas,monospace; }
code.t { background:none; padding:0; color:var(--mut); }
.cat { background:#fdf0d5; color:#7a4f01; padding:1px 6px; border-radius:99px; font-size:11px; font-weight:600; }
@media (prefers-color-scheme: dark) { .cat { background:#3a2f10; color:#e8c980; } }
nav ul { list-style:none; padding:0; margin:0; columns: 2; }
nav a { color:var(--acc); text-decoration:none; }
nav a:hover { text-decoration:underline; }
</style>
</head>
<body>
<main>
<h1>${esc(model.name)}</h1>
${model.description ? `<p class="sub">${esc(model.description)}</p>` : ""}
<dl>
  <dt>Tier</dt><dd>${esc(model.tier)}</dd>
  ${model.namespace ? `<dt>Domain</dt><dd>${esc(model.namespace)}</dd>` : ""}
  ${model.derivedFrom ? `<dt>Derived from</dt><dd>${esc(model.derivedFrom)}</dd>` : ""}
  ${model.target?.project ? `<dt>Project</dt><dd><code>${esc(model.target.project)}</code></dd>` : ""}
  ${model.target?.dataset ? `<dt>Dataset</dt><dd><code>${esc(model.target.dataset)}</code></dd>` : ""}
  <dt>Objects</dt><dd>${sections.length}</dd>
  ${governance ? `<dt>Classified</dt><dd>${classified} of ${total} field(s)</dd>` : ""}
  ${options.generatedAt ? `<dt>Generated</dt><dd>${esc(options.generatedAt)}</dd>` : ""}
</dl>
<nav><ul>
${sections.map(({ object, fields }) => `<li><a href="#${anchor(object.name)}">${esc(object.name)}</a> <span class="sub">${fields.length}</span></li>`).join("\n")}
</ul></nav>
${rows}
</main>
</body>
</html>
`;
}

function renderHtmlIndex(models: Model[], options: DocsOptions): string {
  const items = [...models]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (model) =>
        `<li><a href="${esc(model.name)}.html">${esc(model.name)}</a> <span class="sub">${esc(model.tier)}</span>${model.description ? `, ${esc(model.description)}` : ""}</li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(options.workspaceName ?? "Data models")}</title>
<style>
:root { color-scheme: light dark; --fg:#1a2029; --mut:#5b6673; --bg:#fff; --acc:#2f6feb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6eaf0; --mut:#98a4b3; --bg:#14181e; } }
body { margin:0; padding:40px 20px; background:var(--bg); color:var(--fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
main { max-width:760px; margin:0 auto; }
ul { list-style:none; padding:0; }
li { padding:8px 0; border-bottom:1px solid #e2e6eb33; }
a { color:var(--acc); text-decoration:none; font-weight:500; }
.sub { color:var(--mut); font-size:12px; }
</style></head>
<body><main>
<h1>${esc(options.workspaceName ?? "Data models")}</h1>
${options.generatedAt ? `<p class="sub">Generated ${esc(options.generatedAt)}</p>` : ""}
<ul>${items}</ul>
</main></body></html>
`;
}

/**
 * Escape for HTML text and attribute contexts.
 *
 * Descriptions are free text written by whoever edits the model, so they can contain
 * anything. An unescaped `<` in a column description would silently swallow the rest of the
 * table, and an unescaped quote would break out of an attribute.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
