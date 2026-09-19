import type { Diagnostic, Severity } from "./common.js";
import type { NamingRule, NamingStandard } from "./domain.js";
import type { ObjectGraph, LoadedObject } from "./graph.js";
import type { Model } from "./model.js";
import { walkColumns } from "./physical.js";

/**
 * The naming standards engine.
 *
 * This is the feature that decides whether the tool is documentation or
 * governance. Standards that live only inside a desktop application get bypassed
 * the first time someone is in a hurry; standards that run here run identically
 * in `strata lint` in CI, where a pull request cannot merge until they pass.
 */

export type Casing = NonNullable<NamingRule["casing"]>;

const CASE_TESTS: Record<Casing, (value: string) => boolean> = {
  snake_case: (v) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(v),
  SCREAMING_SNAKE: (v) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(v),
  camelCase: (v) => /^[a-z][a-zA-Z0-9]*$/.test(v),
  PascalCase: (v) => /^[A-Z][a-zA-Z0-9]*$/.test(v),
  "Title Case": (v) => /^[A-Z][a-z0-9]*( [A-Z][a-z0-9]*)*$/.test(v),
  any: () => true,
};

export function matchesCasing(value: string, casing: Casing): boolean {
  return CASE_TESTS[casing](value);
}

/** Split a name into words, however it happens to be cased. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word.length > 0);
}

export function toCasing(words: readonly string[], casing: Casing): string {
  const lower = words.map((w) => w.toLowerCase());
  switch (casing) {
    case "snake_case":
      return lower.join("_");
    case "SCREAMING_SNAKE":
      return lower.join("_").toUpperCase();
    case "camelCase":
      return lower.map((w, i) => (i === 0 ? w : capitalize(w))).join("");
    case "PascalCase":
      return lower.map(capitalize).join("");
    case "Title Case":
      return lower.map(capitalize).join(" ");
    case "any":
      return words.join(" ");
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Derive a physical name from a logical one, applying the standard's
 * abbreviation dictionary.
 *
 * `Customer Identifier` with `Identifier -> id` becomes `customer_id`. The
 * dictionary is the mechanism that stops five teams inventing five different
 * abbreviations for "organisation".
 */
export function toPhysicalName(logicalName: string, standard?: NamingStandard): string {
  const words = splitWords(logicalName);
  if (!standard) return toCasing(words, "snake_case");

  const abbreviations = new Map(
    Object.entries(standard.abbreviations).map(([word, abbrev]) => [word.toLowerCase(), abbrev]),
  );
  const abbreviated = words.map((word) => abbreviations.get(word.toLowerCase()) ?? word);
  return toCasing(abbreviated, "snake_case");
}

/** Words in a name that have an approved abbreviation the name is not using. */
export function unabbreviatedWords(name: string, standard: NamingStandard): string[] {
  const abbreviations = new Map(
    Object.entries(standard.abbreviations).map(([word, abbrev]) => [word.toLowerCase(), abbrev]),
  );
  return splitWords(name).filter((word) => abbreviations.has(word.toLowerCase()));
}

/**
 * A name that would satisfy the rule, or nothing when one cannot be derived.
 *
 * The point of returning `undefined` rather than a best effort: a suggestion offered behind
 * a one-click "Fix" button is an instruction the user will not re-read. A wrong suggestion
 * is therefore worse than no suggestion, because it gets applied. So this only speaks when
 * the fix is mechanical.
 *
 * `naming/pattern` is the deliberate gap. An arbitrary regular expression describes a set of
 * acceptable names; it does not tell you which member of that set was meant, and synthesising
 * one would be guessing at intent.
 *
 * Order is load-bearing. Forbidden words go first because dropping a word changes the word
 * list everything else operates on; prefix and suffix attach after casing, because they are
 * literal strings, `dim_` run through PascalCase becomes `Dim`, which satisfies nothing.
 * Truncation is last, and shortens the middle rather than the end so a required suffix
 * survives it.
 */
export function suggestName(
  name: string,
  rule: NamingRule,
  standard?: NamingStandard,
): string | undefined {
  let words = splitWords(name);
  let changed = false;

  if (rule.forbiddenWords.length > 0) {
    const forbidden = new Set(rule.forbiddenWords.map((word) => word.toLowerCase()));
    const abbreviations = new Map(
      Object.entries(standard?.abbreviations ?? {}).map(([word, abbrev]) => [word.toLowerCase(), abbrev]),
    );

    const kept: string[] = [];
    for (const word of words) {
      if (!forbidden.has(word.toLowerCase())) {
        kept.push(word);
        continue;
      }
      changed = true;
      /*
        A forbidden word with an approved abbreviation is replaced, not deleted.

        This is the case that makes the dictionary earn its place: a standard that forbids
        "identifier" and maps it to "id" wants `customer_id`, not `customer`. Deleting the
        word would silently change what the column means.
      */
      const replacement = abbreviations.get(word.toLowerCase());
      if (replacement) kept.push(replacement);
    }

    // Refuse to suggest an empty name. `test` under a rule forbidding "test" has no
    // mechanical fix, and `""` is not one.
    if (kept.length === 0) return undefined;
    words = kept;
  }

  const casing = rule.casing && rule.casing !== "any" ? rule.casing : undefined;
  let candidate = casing ? toCasing(words, casing) : words.join(name.includes("_") ? "_" : " ");
  if (casing && !matchesCasing(name, casing)) changed = true;

  const prefix = rule.requiredPrefix[0];
  if (prefix && !rule.requiredPrefix.some((entry) => candidate.startsWith(entry))) {
    candidate = `${prefix}${candidate}`;
    changed = true;
  }

  const suffix = rule.requiredSuffix[0];
  if (suffix && !rule.requiredSuffix.some((entry) => candidate.endsWith(entry))) {
    candidate = `${candidate}${suffix}`;
    changed = true;
  }

  if (rule.maxLength !== undefined && candidate.length > rule.maxLength) {
    const tail = rule.requiredSuffix.find((entry) => candidate.endsWith(entry)) ?? "";
    const room = rule.maxLength - tail.length;
    // A limit too tight to hold even the mandatory suffix has no mechanical fix.
    if (room <= 0) return undefined;
    candidate = candidate.slice(0, room) + tail;
    changed = true;
  }

  if (!changed || candidate === name) return undefined;
  return candidate;
}

export interface LintOptions {
  /** Per-rule severity overrides from `strata.config.yaml`. `off` disables a rule. */
  severities?: Record<string, Severity | "off">;
  /** Report warnings as errors. */
  strict?: boolean;
}

/**
 * Lint every object's name against the naming standard its model points at.
 *
 * Objects in a model with no `namingStandard` are skipped rather than checked
 * against a built-in default, imposing our conventions on an existing estate
 * would bury the user in findings on day one, which is how linters get disabled.
 */
export function lintNames(graph: ObjectGraph, options: LintOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const standardForModel = new Map<string, NamingStandard | undefined>();
  const standardFor = (modelName: string | undefined): NamingStandard | undefined => {
    if (!modelName) return undefined;
    if (standardForModel.has(modelName)) return standardForModel.get(modelName);

    const model = graph.modelNamed(modelName);
    const ref = model?.namingStandard;
    const resolved = ref ? graph.resolve(ref, { kind: "namingStandard" }) : undefined;
    const standard =
      resolved?.target.object.kind === "namingStandard" ? (resolved.target.object as NamingStandard) : undefined;
    standardForModel.set(modelName, standard);
    return standard;
  };

  const emit = (
    entry: LoadedObject,
    rule: NamingRule,
    code: string,
    message: string,
    path: string,
    suggestion?: string,
  ): void => {
    const override = options.severities?.[code];
    if (override === "off") return;
    let severity: Severity = override ?? rule.severity;
    if (options.strict && severity === "warning") severity = "error";

    diagnostics.push({
      severity,
      code,
      message: rule.message ?? message,
      objectId: entry.object.id,
      path,
      ...(entry.file ? { file: entry.file } : {}),
      // Only attached when the fix is mechanical; see `suggestName`.
      ...(suggestion ? { fix: { path, value: suggestion } } : {}),
    });
  };

  for (const entry of graph.all()) {
    const object = entry.object;
    if (object.kind === "namingStandard") continue;

    const modelName = object.kind === "model" ? object.name : object.model;
    const standard = standardFor(modelName);
    if (!standard) continue;

    const tier = object.kind === "model" ? (object as Model).tier : graph.tierOf(object);

    // The object's own name.
    for (const rule of applicableRules(standard, object.kind, tier)) {
      checkName(entry, object.name, rule, "name", emit, standard);
    }

    // Members: attributes and columns, including nested ones.
    if (object.kind === "entity") {
      const rules = applicableRules(standard, "attribute", tier);
      for (const [i, attribute] of object.attributes.entries()) {
        for (const rule of rules) {
          checkName(entry, attribute.name, rule, `attributes[${i}].name`, emit, standard);
        }
      }
    }
    if (object.kind === "table") {
      const rules = applicableRules(standard, "column", tier);
      for (const { column, path } of walkColumns(object.columns)) {
        for (const rule of rules) {
          checkName(entry, column.name, rule, `columns.${path}`, emit, standard);
        }
      }
    }
  }

  return diagnostics;
}

/** Rules matching a kind and tier. An empty filter list means "applies to all". */
function applicableRules(
  standard: NamingStandard,
  kind: string,
  tier: string | undefined,
): NamingRule[] {
  return standard.rules.filter((rule) => {
    if (rule.appliesTo.length > 0 && !rule.appliesTo.includes(kind)) return false;
    if (rule.tiers.length > 0 && (!tier || !rule.tiers.includes(tier))) return false;
    return true;
  });
}

type Emit = (
  entry: LoadedObject,
  rule: NamingRule,
  code: string,
  message: string,
  path: string,
  /** A mechanically-derived compliant name, when one exists. Becomes the diagnostic's `fix`. */
  suggestion?: string,
) => void;

/**
 * Compile a rule's pattern, ignoring an invalid one.
 *
 * `validate` already reports a malformed pattern against the standard itself, so
 * failing every name in the model here would just be noise on top of the real
 * finding.
 */
function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function checkName(
  entry: LoadedObject,
  name: string,
  rule: NamingRule,
  path: string,
  emit: Emit,
  standard?: NamingStandard,
): void {
  /*
    Computed once per name rather than per finding.

    One badly-named column can trip case, prefix and forbidden-word rules at the same time,
    and all three want the *same* corrected name, the one that satisfies every constraint
    at once. Deriving it separately inside each branch would offer three different fixes and
    let whichever the user clicked last undo the others.
  */
  const suggestion = suggestName(name, rule, standard);
  if (rule.casing && rule.casing !== "any" && !matchesCasing(name, rule.casing)) {
    emit(
      entry,
      rule,
      "naming/case",
      `\`${name}\` is not ${rule.casing} (expected \`${toCasing(splitWords(name), rule.casing)}\`)`,
      path,
      suggestion,
    );
  }

  const regex = compilePattern(rule.pattern);
  if (regex && !regex.test(name)) {
    emit(entry, rule, "naming/pattern", `\`${name}\` does not match required pattern \`${rule.pattern}\``, path);
  }

  if (rule.maxLength !== undefined && name.length > rule.maxLength) {
    emit(
      entry,
      rule,
      "naming/length",
      `\`${name}\` is ${name.length} characters, exceeding the limit of ${rule.maxLength}`,
      path,
      suggestion,
    );
  }

  if (rule.requiredPrefix.length > 0 && !rule.requiredPrefix.some((p) => name.startsWith(p))) {
    emit(
      entry,
      rule,
      "naming/prefix",
      `\`${name}\` must start with one of: ${rule.requiredPrefix.join(", ")}`,
      path,
      suggestion,
    );
  }

  if (rule.requiredSuffix.length > 0 && !rule.requiredSuffix.some((s) => name.endsWith(s))) {
    emit(entry, rule, "naming/suffix", `\`${name}\` must end with one of: ${rule.requiredSuffix.join(", ")}`, path, suggestion);
  }

  if (rule.forbiddenWords.length > 0) {
    const words = new Set(splitWords(name).map((w) => w.toLowerCase()));
    const offending = rule.forbiddenWords.filter((w) => words.has(w.toLowerCase()));
    if (offending.length > 0) {
      emit(entry, rule, "naming/forbiddenWord", `\`${name}\` uses discouraged word(s): ${offending.join(", ")}`, path, suggestion);
    }
  }
}
