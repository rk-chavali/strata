import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lintNames, type ObjectGraph, type AnyObject } from "@strata/metamodel";
import { parseYamlFile, type LoadedWorkspace } from "@strata/storage";
import { dictionaryView } from "@strata/query";

/**
 * Skills, the rules a team writes for itself, enforced before a proposal.
 *
 * **The gate is the point, not the button.** A rule that runs when somebody remembers to click
 * it enforces nothing; it is a linter you have to ask permission from. So skills run
 * automatically on the propose path, and a `blocking` one refuses the proposal the same way a
 * validation error already does. The Run action on the skills page exists so a skill can be
 * authored and tested without opening a pull request, that is its whole job.
 *
 * **Skills live in the repo, at `.strata/skills/*.md`.** Same reasoning as the model itself: a rule
 * that governs what may merge is a decision worth reviewing, versioning and blaming. Storing them
 * in a database would put the rules outside the process that governs everything else.
 *
 * Two kinds, and the split is deliberate:
 *
 *   - **`check`** is deterministic, instant and free. It parameterises one of the built-in rules
 *     below, all of which reuse machinery that already exists and is already tested.
 *   - **`agent`** is a prompt run over model context by a language model, for the judgements a
 *     rule cannot express, "does this table's grain match its name". It needs a provider key the
 *     *operator* supplies, and **nothing calls an external API without one**: an unconfigured
 *     agent skill reports itself skipped rather than silently passing, because a governance
 *     control that quietly does nothing is worse than one that is visibly off.
 */

export type SkillKind = "check" | "agent";

/**
 * What a finding does to a proposal.
 *
 * `blocking` refuses it. `advisory` attaches the finding and lets it through. Per skill rather
 * than global, because a team adopting this against an existing estate needs to turn rules on
 * one at a time, an all-or-nothing gate gets switched off wholesale on the first false positive.
 */
export type SkillSeverity = "blocking" | "advisory";

export interface Skill {
  /** Stable id, from the filename when the frontmatter omits it. */
  name: string;
  description: string;
  kind: SkillKind;
  severity: SkillSeverity;
  enabled: boolean;
  /** Which built-in rule a `check` skill parameterises. */
  rule?: string;
  config: Record<string, unknown>;
  /** The markdown body: the reasoning, and for an agent skill the prompt. */
  body: string;
  /** Repo-relative path, so the UI can say where the rule came from. */
  file: string;
  /** Set when the file could not be understood, so the page can show it as broken. */
  error?: string;
}

export interface Finding {
  skill: string;
  severity: SkillSeverity;
  message: string;
  objectId?: string;
  objectName?: string;
  file?: string;
  path?: string;
}

export type RunStatus = "passed" | "failed" | "skipped" | "errored";

export interface SkillRun {
  skill: string;
  kind: SkillKind;
  severity: SkillSeverity;
  status: RunStatus;
  /** Why it was skipped or errored. Absent when it ran. */
  reason?: string;
  findings: Finding[];
  durationMs: number;
  at: string;
}

export interface GateResult {
  runs: SkillRun[];
  /** Findings from `blocking` skills. Non-empty means the proposal is refused. */
  blocking: Finding[];
  /** Findings from `advisory` skills. Attached to the proposal, never refuses it. */
  advisory: Finding[];
}

/** Where skills live, relative to the workspace root. */
export const SKILLS_DIR = ".strata/skills";

// ---------------------------------------------------------------- loading

/**
 * Read every skill in the workspace.
 *
 * A malformed skill is returned *with* an `error` rather than thrown away. Dropping it would
 * mean a typo in frontmatter silently disables a governance rule, the failure mode where
 * someone believes a control is running and it is not.
 */
export async function loadSkills(root: string): Promise<Skill[]> {
  const dir = join(root, SKILLS_DIR);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No skills directory. An ordinary state for a workspace that has not adopted them.
    return [];
  }

  const skills: Skill[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const file = `${SKILLS_DIR}/${name}`;
    try {
      skills.push(parseSkill(await readFile(join(dir, name), "utf8"), file));
    } catch (error) {
      skills.push(broken(file, error instanceof Error ? error.message : String(error)));
    }
  }
  return skills;
}

function broken(file: string, message: string): Skill {
  return {
    name: file.split("/").pop()?.replace(/\.md$/, "") ?? file,
    description: "",
    kind: "check",
    severity: "advisory",
    /*
      A broken skill is disabled, not enabled-and-failing.

      Enabling it would block every proposal in the workspace until someone fixed the file,
      which turns a typo into an outage. Reported on the page as broken instead.
    */
    enabled: false,
    config: {},
    body: "",
    file,
    error: message,
  };
}

/**
 * Split frontmatter from body and parse it.
 *
 * The delimiter search is deliberately line-exact rather than a regex over the whole file: YAML's
 * own document separator is also `---`, so a frontmatter block containing one would otherwise
 * terminate early and take half the metadata with it.
 */
export function parseSkill(text: string, file: string): Skill {
  const normalised = text.replace(/\r\n/g, "\n");
  const fallbackName = file.split("/").pop()?.replace(/\.md$/, "") ?? file;

  if (!normalised.startsWith("---\n")) {
    throw new Error("a skill must start with a `---` frontmatter block");
  }

  const lines = normalised.split("\n");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("the frontmatter block is never closed with `---`");

  const parsed = parseYamlFile(lines.slice(1, end).join("\n"));
  if (parsed.errors.length > 0) {
    throw new Error(`frontmatter is not valid YAML: ${parsed.errors[0]!.message}`);
  }

  const meta = (parsed.documents[0]?.value ?? {}) as Record<string, unknown>;
  const kind = meta.kind === "agent" ? "agent" : "check";
  const rule = typeof meta.rule === "string" ? meta.rule : undefined;

  if (kind === "check" && !rule) {
    throw new Error("a `check` skill must name a `rule`; see the built-in list");
  }
  if (kind === "check" && rule && !(rule in RULES)) {
    throw new Error(`unknown rule \`${rule}\`. Available: ${Object.keys(RULES).join(", ")}`);
  }

  return {
    name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName,
    description: typeof meta.description === "string" ? meta.description : "",
    kind,
    severity: meta.severity === "blocking" ? "blocking" : "advisory",
    // Absent means on. A skill someone committed is one they intended to run.
    enabled: meta.enabled !== false,
    ...(rule ? { rule } : {}),
    config: isRecord(meta.config) ? meta.config : {},
    body: lines.slice(end + 1).join("\n").trim(),
    file,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- built-in checks

interface RuleContext {
  workspace: LoadedWorkspace;
  graph: ObjectGraph;
  skill: Skill;
}

type Rule = (context: RuleContext) => Finding[];

/** Kinds a rule applies to, from `config.kinds`. Empty means every kind. */
function kindsOf(config: Record<string, unknown>): Set<string> {
  const raw = config.kinds;
  return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : []);
}

function applies(object: AnyObject, kinds: Set<string>): boolean {
  return kinds.size === 0 || kinds.has(object.kind);
}

function finding(skill: Skill, message: string, object?: AnyObject, file?: string): Finding {
  return {
    skill: skill.name,
    severity: skill.severity,
    message,
    ...(object ? { objectId: object.id, objectName: object.name } : {}),
    ...(file ? { file } : {}),
  };
}

/**
 * The built-in rules.
 *
 * Every one of these reuses something already written and tested rather than reimplementing it.
 * That is the reason `check` skills are worth having at all: they are free, exact and instant,
 * and they cover most of what a team actually wants to enforce.
 */
export const RULES: Record<string, Rule> = {
  /**
   * Names must not contain particular words.
   *
   * The commonest real rule: no `tmp_`, no `test_`, no `_old` reaching the warehouse.
   */
  "forbidden-words": ({ graph, skill, workspace }) => {
    const words = (Array.isArray(skill.config.words) ? skill.config.words : [])
      .filter((w): w is string => typeof w === "string")
      .map((w) => w.toLowerCase());
    const kinds = kindsOf(skill.config);
    if (words.length === 0) return [];

    const findings: Finding[] = [];
    for (const entry of graph.all()) {
      if (!applies(entry.object, kinds)) continue;
      const name = entry.object.name.toLowerCase();
      const hit = words.find((word) => name.includes(word));
      if (hit) {
        findings.push(
          finding(
            skill,
            `\`${entry.object.name}\` contains the discouraged word \`${hit}\`.`,
            entry.object,
            workspace.pathById.get(entry.object.id),
          ),
        );
      }
    }
    return findings;
  },

  /** Objects of the given kinds must carry a description. */
  "required-description": ({ graph, skill, workspace }) => {
    const kinds = kindsOf(skill.config);
    const findings: Finding[] = [];

    for (const entry of graph.all()) {
      if (!applies(entry.object, kinds)) continue;
      const description = (entry.object as { description?: string }).description;
      if (!description?.trim()) {
        findings.push(
          finding(
            skill,
            `\`${entry.object.name}\` has no description.`,
            entry.object,
            workspace.pathById.get(entry.object.id),
          ),
        );
      }
    }
    return findings;
  },

  /**
   * A named field must be present on the given kinds.
   *
   * Exists mainly for "every table states its grain", which is the single most valuable piece of
   * documentation on a warehouse table and the one most often missing.
   */
  "required-field": ({ graph, skill, workspace }) => {
    const field = typeof skill.config.field === "string" ? skill.config.field : undefined;
    if (!field) return [];
    const kinds = kindsOf(skill.config);

    const findings: Finding[] = [];
    for (const entry of graph.all()) {
      if (!applies(entry.object, kinds)) continue;
      const value = (entry.object as Record<string, unknown>)[field];
      const missing =
        value === undefined || value === null || (typeof value === "string" && !value.trim());
      if (missing) {
        findings.push(
          finding(
            skill,
            `\`${entry.object.name}\` does not state \`${field}\`.`,
            entry.object,
            workspace.pathById.get(entry.object.id),
          ),
        );
      }
    }
    return findings;
  },

  /**
   * Naming standards, surfaced through the skills gate.
   *
   * `lintNames` already runs in ordinary validation, where its severity is tunable per rule and
   * a warning does not block. Routing it through a skill is how a team promotes naming from
   * "advice in the dock" to "this cannot merge" without changing what the rule means.
   */
  naming: ({ graph, skill, workspace }) => {
    const only = new Set(
      (Array.isArray(skill.config.codes) ? skill.config.codes : []).filter(
        (c): c is string => typeof c === "string",
      ),
    );

    return lintNames(graph, {
      severities: workspace.config.lint.rules,
      strict: workspace.config.lint.strict,
    })
      .filter((diagnostic) => only.size === 0 || only.has(diagnostic.code))
      .map((diagnostic) => ({
        skill: skill.name,
        severity: skill.severity,
        message: diagnostic.message,
        ...(diagnostic.objectId ? { objectId: diagnostic.objectId } : {}),
        ...(diagnostic.file ? { file: diagnostic.file } : {}),
        ...(diagnostic.path ? { path: diagnostic.path } : {}),
      }));
  },

  /**
   * A minimum share of columns must carry a classification.
   *
   * Reuses `dictionaryView`, which already resolves inheritance column → domain → attribute, so
   * a column classified through its domain counts, as it should. Reimplementing the coverage
   * count here would drift from what the dictionary page shows, and two different numbers for
   * "how much is classified" is worse than not measuring it.
   */
  "classification-coverage": ({ graph, skill }) => {
    const minimum =
      typeof skill.config.minimum === "number" ? Math.min(Math.max(skill.config.minimum, 0), 1) : 0.8;

    const findings: Finding[] = [];
    for (const loaded of graph.models()) {
      const view = dictionaryView(graph, loaded.object.name);
      if (view.total === 0) continue;

      const share = view.classified / view.total;
      if (share < minimum) {
        findings.push({
          skill: skill.name,
          severity: skill.severity,
          message:
            `\`${loaded.object.name}\` classifies ${view.classified} of ${view.total} fields ` +
            `(${Math.round(share * 100)}%), below the required ${Math.round(minimum * 100)}%.`,
          objectId: loaded.object.id,
          objectName: loaded.object.name,
        });
      }
    }
    return findings;
  },
};

// ---------------------------------------------------------------- agent skills

/**
 * How an agent skill reaches a language model.
 *
 * Injected rather than imported so the gate can be tested end to end without a network call or a
 * key, the interesting behaviour is what the gate does with findings, not how the HTTP request
 * is shaped. The real implementation is supplied by the server from operator configuration.
 */
export type Completion = (input: { prompt: string; context: string }) => Promise<string>;

/**
 * Everything an agent skill is allowed to see.
 *
 * Deliberately a compact summary rather than the whole workspace: a prompt carrying every column
 * of a large model would be expensive, slow, and mostly noise. Names, kinds, descriptions and
 * grain are what the judgement calls actually turn on.
 */
export function modelContext(graph: ObjectGraph, limit = 200): string {
  const lines: string[] = [];

  for (const entry of graph.all().slice(0, limit)) {
    const object = entry.object as Record<string, unknown> & AnyObject;
    const parts = [`${object.kind} ${object.name}`];
    if (typeof object.model === "string") parts.push(`model=${object.model}`);
    if (typeof object.grain === "string") parts.push(`grain=${object.grain}`);
    if (typeof object.description === "string" && object.description.trim()) {
      parts.push(`description=${object.description.trim()}`);
    }

    const columns = object.columns;
    if (Array.isArray(columns)) {
      const named = columns
        .map((column) => (isRecord(column) && typeof column.name === "string" ? column.name : undefined))
        .filter((name): name is string => Boolean(name));
      if (named.length > 0) parts.push(`columns=[${named.join(", ")}]`);
    }

    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}

/**
 * Parse what the model said back into findings.
 *
 * The contract asked of the model is one finding per line, `OBJECT: message`, and the literal
 * word `OK` when it has nothing to report. Deliberately not JSON: a model that produces slightly
 * malformed JSON yields *nothing*, whereas a model that produces slightly malformed lines still
 * yields most of its findings. For an advisory control that is the better failure.
 */
export function parseAgentFindings(reply: string, skill: Skill): Finding[] {
  const findings: Finding[] = [];

  for (const raw of reply.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    if (/^ok\b/i.test(line) || /^no (issues|findings|problems)\b/i.test(line)) continue;

    const split = line.indexOf(":");
    const objectName = split > 0 ? line.slice(0, split).trim() : undefined;
    const message = split > 0 ? line.slice(split + 1).trim() : line;
    if (!message) continue;

    findings.push({
      skill: skill.name,
      severity: skill.severity,
      message,
      ...(objectName ? { objectName } : {}),
    });
  }

  return findings;
}

// ---------------------------------------------------------------- running

export interface RunOptions {
  /** Supplied only when the operator has configured a provider. Absent means agents are skipped. */
  complete?: Completion;
  /** Run just this one, for the authoring loop on the skills page. */
  only?: string;
  /** Include skills the frontmatter disabled. Used by the Run button, never by the gate. */
  includeDisabled?: boolean;
}

/** Run one skill. Never throws: an exception becomes an `errored` run. */
export async function runSkill(
  workspace: LoadedWorkspace,
  skill: Skill,
  options: RunOptions = {},
): Promise<SkillRun> {
  const started = Date.now();
  const done = (status: RunStatus, findings: Finding[], reason?: string): SkillRun => ({
    skill: skill.name,
    kind: skill.kind,
    severity: skill.severity,
    status,
    ...(reason ? { reason } : {}),
    findings,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  });

  if (skill.error) return done("errored", [], skill.error);

  try {
    if (skill.kind === "agent") {
      if (!options.complete) {
        /*
          Reported as skipped, never as passed.

          A governance control that silently reports success because it was not configured is
          worse than one that is visibly off, it produces a green tick nobody has earned.
        */
        return done("skipped", [], "No language model provider is configured for agent skills.");
      }
      if (!skill.body.trim()) {
        return done("errored", [], "An agent skill needs a prompt in its markdown body.");
      }

      const reply = await options.complete({
        prompt: skill.body,
        context: modelContext(workspace.graph),
      });
      const findings = parseAgentFindings(reply, skill);
      return done(findings.length === 0 ? "passed" : "failed", findings);
    }

    const rule = skill.rule ? RULES[skill.rule] : undefined;
    if (!rule) return done("errored", [], `unknown rule \`${skill.rule}\``);

    const findings = rule({ workspace, graph: workspace.graph, skill });
    return done(findings.length === 0 ? "passed" : "failed", findings);
  } catch (error) {
    return done("errored", [], error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run the skills and decide whether a proposal may go ahead.
 *
 * Used by both the propose route and the skills page, so what an author sees when they press Run
 * is exactly what the gate will do, a preview that ran a different code path would be worse than
 * no preview.
 */
export async function runGate(
  workspace: LoadedWorkspace,
  options: RunOptions = {},
): Promise<GateResult> {
  const all = await loadSkills(workspace.root);

  const selected = all.filter((skill) => {
    if (options.only) return skill.name === options.only;
    return options.includeDisabled || skill.enabled;
  });

  const runs: SkillRun[] = [];
  for (const skill of selected) runs.push(await runSkill(workspace, skill, options));

  const findings = runs.flatMap((run) => run.findings);
  return {
    runs,
    blocking: findings.filter((entry) => entry.severity === "blocking"),
    advisory: findings.filter((entry) => entry.severity === "advisory"),
  };
}

// ---------------------------------------------------------------- editing

/**
 * Turn a skill on or off by rewriting its `enabled:` line.
 *
 * A targeted line edit rather than a parse-and-reserialise, for the same reason `updateConfig`
 * edits the YAML document in place: the file belongs to the customer, their reviewers read it,
 * and a toggle that reformatted the frontmatter or dropped the comment explaining why a rule
 * exists would be doing real damage in exchange for our convenience.
 *
 * The write lands in the repo, so it shows up in Changes and merges as a reviewable commit, * which is the point. Disabling a governance rule should be as visible as writing one.
 */
export function setEnabledInSource(text: string, enabled: boolean): string {
  const usesCrlf = text.includes("\r\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  if (lines[0] !== "---") throw new Error("a skill must start with a `---` frontmatter block");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("the frontmatter block is never closed with `---`");

  // Only inside the frontmatter: an `enabled:` in the prose body is documentation, not config.
  const index = lines.findIndex((line, at) => at > 0 && at < end && /^enabled\s*:/.test(line));

  if (index === -1) lines.splice(end, 0, `enabled: ${enabled}`);
  else lines[index] = `enabled: ${enabled}`;

  const result = lines.join("\n");
  // Preserve the file's existing line endings, so a toggle is a one-line diff on Windows too.
  return usesCrlf ? result.replace(/\n/g, "\r\n") : result;
}

/** Apply the toggle to a skill on disk. Returns the file that changed. */
export async function setSkillEnabled(
  root: string,
  name: string,
  enabled: boolean,
): Promise<string> {
  const skills = await loadSkills(root);
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) throw new Error(`no skill named \`${name}\``);

  const absolute = join(root, skill.file);
  const text = await readFile(absolute, "utf8");
  await writeFile(absolute, setEnabledInSource(text, enabled), "utf8");
  return skill.file;
}
