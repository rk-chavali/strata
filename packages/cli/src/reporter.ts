import type { Diagnostic, Severity } from "@strata/metamodel";

/**
 * Diagnostic output.
 *
 * Three formats, because the CLI has three audiences: a human at a terminal, a
 * CI runner that should surface findings as annotations on the pull request, and
 * another program consuming JSON.
 */
export const OUTPUT_FORMATS = ["pretty", "json", "github"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const useColor =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  grey: "\u001b[90m",
} as const;

function paint(text: string, ...codes: (keyof typeof ANSI)[]): string {
  if (!useColor) return text;
  return `${codes.map((c) => ANSI[c]).join("")}${text}${ANSI.reset}`;
}

const SEVERITY_STYLE: Record<Severity, { label: string; codes: (keyof typeof ANSI)[] }> = {
  error: { label: "error", codes: ["red", "bold"] },
  warning: { label: "warning", codes: ["yellow"] },
  info: { label: "info", codes: ["blue"] },
};

export function formatDiagnostics(diagnostics: readonly Diagnostic[], format: OutputFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify({ diagnostics, summary: summarize(diagnostics) }, null, 2);
    case "github":
      return formatGithub(diagnostics);
    case "pretty":
      return formatPretty(diagnostics);
  }
}

export interface Summary {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export function summarize(diagnostics: readonly Diagnostic[]): Summary {
  const summary: Summary = { error: 0, warning: 0, info: 0, total: diagnostics.length };
  for (const d of diagnostics) summary[d.severity]++;
  return summary;
}

/** Group by file so a reader fixes one file at a time rather than jumping around. */
function formatPretty(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return paint("No problems found.", "green");

  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const key = d.file ?? "<unknown file>";
    const bucket = byFile.get(key);
    if (bucket) bucket.push(d);
    else byFile.set(key, [d]);
  }

  const lines: string[] = [];
  for (const [file, group] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(paint(file, "bold", "blue"));
    for (const d of sortBySeverity(group)) {
      const style = SEVERITY_STYLE[d.severity];
      const location = d.path ? paint(`  ${d.path}`, "grey") : "";
      lines.push(`  ${paint(style.label.padEnd(7), ...style.codes)} ${d.message}${location}`);
      lines.push(`          ${paint(d.code, "dim")}`);
    }
    lines.push("");
  }

  lines.push(formatSummaryLine(summarize(diagnostics)));
  return lines.join("\n");
}

export function formatSummaryLine(summary: Summary): string {
  if (summary.total === 0) return paint("No problems found.", "green");
  const parts: string[] = [];
  if (summary.error) parts.push(paint(`${summary.error} error${plural(summary.error)}`, "red", "bold"));
  if (summary.warning) parts.push(paint(`${summary.warning} warning${plural(summary.warning)}`, "yellow"));
  if (summary.info) parts.push(paint(`${summary.info} info`, "blue"));
  return parts.join(", ");
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function sortBySeverity(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return [...diagnostics].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return (a.path ?? "").localeCompare(b.path ?? "");
  });
}

/**
 * GitHub Actions workflow commands, which render as inline annotations on the
 * pull request diff, the point of running this in CI at all.
 */
function formatGithub(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const level = d.severity === "warning" ? "warning" : d.severity === "info" ? "notice" : "error";
      const properties = [
        d.file ? `file=${d.file}` : undefined,
        `title=${d.code}`,
      ]
        .filter((p): p is string => Boolean(p))
        .join(",");
      const suffix = d.path ? ` (${d.path})` : "";
      // Newlines terminate a workflow command, so they have to be escaped.
      const message = `${d.message}${suffix}`.replace(/\r?\n/g, "%0A");
      return `::${level} ${properties}::${message}`;
    })
    .join("\n");
}

/** Whether findings should fail the command. */
export function shouldFail(diagnostics: readonly Diagnostic[], strict: boolean): boolean {
  return diagnostics.some((d) => d.severity === "error" || (strict && d.severity === "warning"));
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function heading(message: string): void {
  process.stdout.write(`${paint(message, "bold")}\n`);
}

export function detail(message: string): void {
  process.stdout.write(`${paint(message, "grey")}\n`);
}

export function failure(message: string): void {
  process.stderr.write(`${paint("error", "red", "bold")} ${message}\n`);
}

export function success(message: string): void {
  process.stdout.write(`${paint("✓", "green")} ${message}\n`);
}
