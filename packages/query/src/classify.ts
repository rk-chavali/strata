import {
  DATA_CATEGORIES,
  SENSITIVITY_LEVELS,
  isKind,
  walkColumns,
  type Classification,
  type ObjectGraph,
  type Table,
} from "@strata/metamodel";

/* Derived from the const arrays rather than imported, so the vocabulary has one home. */
type DataCategory = (typeof DATA_CATEGORIES)[number];
type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/**
 * Suggesting a classification for a column that has none.
 *
 * The single most tedious part of adopting this tool against an existing estate is classifying a
 * few thousand columns by hand, and it is tedious precisely because most of it is obvious:
 * `email_address` is contact PII in every warehouse ever built. Automating the obvious cases is
 * what makes the interesting ones, the ones a person genuinely has to decide, visible.
 *
 * **Deterministic, not a language model.** An LLM would catch more, and it would cost a key, a
 * network call and a per-run bill for something that has to run over every column in the
 * workspace. These patterns are free, instant, identical on every run, and, the part that
 * matters for governance, *explainable*: every suggestion says which pattern matched, so a
 * reviewer can disagree with the rule rather than with an oracle. The agent-skill layer is where
 * judgement belongs; this is where the obvious belongs.
 *
 * **Suggestions are never applied automatically.** Classification drives policy tags, which
 * drive real column-level security. A wrong guess applied silently either exposes a column that
 * should be locked or locks one that should not be, and both are discovered late. Everything
 * here is a proposal for a person to accept.
 */

export interface Suggestion {
  objectId: string;
  objectName: string;
  model?: string;
  /** Dotted path within the object, so an edit can address this exact field. */
  path: string;
  column: string;
  dataType: string;
  suggested: Classification;
  /** Which rule fired, so a reviewer can argue with the rule rather than the result. */
  reason: string;
  /**
   * How far to trust it.
   *
   * `high` means the name is unambiguous in any warehouse, `email`, `ssn`, `card_number`.
   * `medium` means the pattern is common but context could change it. Nothing here is certain
   * enough to apply without review, which is why there is no `certain`.
   */
  confidence: "high" | "medium";
}

interface Pattern {
  /** Matched against the column name, lowercased. */
  test: RegExp;
  categories: DataCategory[];
  sensitivity?: Sensitivity;
  /** Marks the column as identifying a data subject, for erasure mapping. */
  subjectIdentifier?: boolean;
  confidence: Suggestion["confidence"];
  reason: string;
}

/**
 * The patterns, most specific first.
 *
 * Order matters: `email_address` must match the contact rule before the generic `address` one, or
 * it would be classified as a postal address. The first match wins, so a new pattern goes above
 * anything more general than it.
 *
 * Word-bounded throughout. An unanchored `ssn` matches `lesson_id`, and a false positive here
 * proposes locking down a column nobody needs locked, which is how a reviewer learns to click
 * "accept all" without reading, and that is worse than no suggestions at all.
 */
const PATTERNS: Pattern[] = [
  {
    test: /\b(ssn|social_security|national_insurance|nino|tax_id|tin)\b/,
    categories: ["pii"],
    sensitivity: "restricted",
    subjectIdentifier: true,
    confidence: "high",
    reason: "a government identifier",
  },
  {
    test: /\b(card_number|pan|cardholder|cvv|cvc|card_last_?4|iban|swift|bic|routing_number|account_number)\b/,
    categories: ["pci", "financial"],
    sensitivity: "restricted",
    confidence: "high",
    reason: "a payment instrument",
  },
  {
    test: /\b(password|passwd|secret|api_?key|token|credential|private_key|salt|password_hash)\b/,
    categories: ["credential"],
    sensitivity: "restricted",
    confidence: "high",
    reason: "a credential",
  },
  {
    test: /\b(fingerprint|biometric|face_?id|iris|retina|voice_?print|dna)\b/,
    categories: ["biometric"],
    sensitivity: "restricted",
    confidence: "high",
    reason: "a biometric identifier",
  },
  {
    test: /\b(diagnosis|icd_?\d*|medical|patient|prescription|treatment|nhs_number)\b/,
    categories: ["phi"],
    sensitivity: "restricted",
    confidence: "high",
    reason: "health information",
  },
  {
    test: /\b(e?mail|email_address|phone|mobile|msisdn|telephone|fax)\b/,
    categories: ["contact", "pii"],
    sensitivity: "confidential",
    subjectIdentifier: true,
    confidence: "high",
    reason: "a contact detail",
  },
  {
    test: /\b(first_?name|last_?name|surname|given_?name|full_?name|middle_?name|maiden_?name)\b/,
    categories: ["pii"],
    sensitivity: "confidential",
    subjectIdentifier: true,
    confidence: "high",
    reason: "a person's name",
  },
  {
    test: /\b(date_?of_?birth|dob|birth_?date|birthday)\b/,
    categories: ["pii", "demographic"],
    sensitivity: "confidential",
    confidence: "high",
    reason: "a date of birth",
  },
  {
    test: /\b(street|address_?line|postcode|post_?code|zip_?code|city|county|state_?province)\b/,
    categories: ["location", "pii"],
    sensitivity: "confidential",
    confidence: "medium",
    reason: "a postal address component",
  },
  {
    test: /\b(latitude|longitude|lat|lon|lng|geo_?point|geohash|coordinates)\b/,
    categories: ["location"],
    sensitivity: "confidential",
    confidence: "medium",
    reason: "a geographic coordinate",
  },
  {
    test: /\b(gender|ethnicity|race|religion|nationality|marital_?status|age_?band)\b/,
    categories: ["demographic", "pii"],
    sensitivity: "confidential",
    confidence: "medium",
    reason: "a demographic attribute",
  },
  {
    test: /\b(salary|income|compensation|revenue|balance|credit_?score|net_?worth)\b/,
    categories: ["financial"],
    sensitivity: "confidential",
    confidence: "medium",
    reason: "a financial amount",
  },
  {
    test: /\b(ip_?address|device_?id|mac_?address|user_?agent|cookie_?id|session_?id)\b/,
    categories: ["pii"],
    sensitivity: "confidential",
    confidence: "medium",
    reason: "an online identifier, which most privacy regimes treat as personal data",
  },
];

/** Every suggestion the patterns produce for columns that carry no classification. */
export function suggestClassifications(graph: ObjectGraph, model?: string): Suggestion[] {
  const suggestions: Suggestion[] = [];

  const tables = (model ? graph.inModel(model) : graph.all()).filter((entry) =>
    isKind(entry.object, "table"),
  );

  for (const entry of tables) {
    const table = entry.object as Table;

    for (const { column, path } of walkColumns(table.columns)) {
      /*
        A column that already says something is left entirely alone.

        Not "improved", not merged with. Someone made that call, possibly after an argument, and
        a suggestion engine that second-guesses recorded decisions is one people turn off.
      */
      if (column.classification?.sensitivity || column.classification?.categories?.length) continue;
      // A column inheriting from a domain is classified, even though it states nothing itself.
      if (column.domain) continue;

      const name = column.name.toLowerCase();
      const pattern = PATTERNS.find((candidate) => candidate.test.test(name));
      if (!pattern) continue;

      suggestions.push({
        objectId: table.id,
        objectName: table.name,
        ...(table.model ? { model: table.model } : {}),
        path,
        column: column.name,
        dataType: column.dataType ?? "",
        suggested: {
          categories: pattern.categories,
          ...(pattern.sensitivity ? { sensitivity: pattern.sensitivity } : {}),
          ...(pattern.subjectIdentifier ? { subjectIdentifier: true } : {}),
        },
        reason: `\`${column.name}\` looks like ${pattern.reason}.`,
        confidence: pattern.confidence,
      });
    }
  }

  /* Highest confidence first: the ones a reviewer can accept quickly, so the queue shortens fast. */
  return suggestions.sort((a, b) =>
    a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1,
  );
}

export interface CoverageReport {
  /** Columns carrying a classification, directly or by inheriting from a domain. */
  classified: number;
  total: number;
  /** Columns with nothing, that no pattern recognises either. Genuinely a human decision. */
  unrecognised: number;
  suggestions: number;
}

/**
 * How much of the model is classified, and how much of the rest this can offer an opinion on.
 *
 * The useful number is `unrecognised`: it is the work that is actually left after every obvious
 * case has been proposed, and it is the one a governance lead needs in order to plan.
 */
export function classificationCoverage(graph: ObjectGraph, model?: string): CoverageReport {
  const tables = (model ? graph.inModel(model) : graph.all()).filter((entry) =>
    isKind(entry.object, "table"),
  );

  let classified = 0;
  let total = 0;

  for (const entry of tables) {
    for (const { column } of walkColumns((entry.object as Table).columns)) {
      total += 1;
      const has =
        Boolean(column.classification?.sensitivity) ||
        Boolean(column.classification?.categories?.length) ||
        Boolean(column.domain);
      if (has) classified += 1;
    }
  }

  const suggestions = suggestClassifications(graph, model).length;

  return {
    classified,
    total,
    suggestions,
    unrecognised: Math.max(0, total - classified - suggestions),
  };
}

/** The categories a suggestion may use, so a UI never offers one the schema will reject. */
export const SUGGESTABLE_CATEGORIES: readonly string[] = DATA_CATEGORIES;
