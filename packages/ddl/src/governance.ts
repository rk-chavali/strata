import {
  walkColumns,
  type Diagnostic,
  type ObjectGraph,
  type Severity,
  type Table,
} from "@strata/metamodel";

/**
 * Governance policies.
 *
 * These are the rules an organisation actually wants enforced, is everything owned, is
 * everything described, is sensitive data classified, expressed as validation so they
 * run in the same CI gate as everything else. A governance dashboard that reports
 * coverage but cannot block a merge is a report, not a control.
 *
 * Every policy is off by default. Switching them all on against an existing estate
 * produces thousands of findings on day one, and a linter that shouts on day one gets
 * turned off on day two.
 */

export interface GovernancePolicy {
  /** Every object of these kinds must name an owner. */
  requireOwner?: string[];
  /** Every object of these kinds must have a description. */
  requireDescription?: string[];
  /**
   * Require a classification on columns that look like personal data.
   *
   * Omit to disable. An empty array enables the built-in heuristic; extra entries add
   * your own name fragments on top of it.
   */
  requireClassificationFor?: string[];
  /** Columns must be described, not just their tables. */
  requireColumnDescriptions?: boolean;
  /** Physical tables above this many columns must declare a partitioning strategy. */
  requirePartitioningOver?: number;
  /** Severity for policy findings. */
  severity?: Severity;
}

/**
 * Name fragments that suggest personal data.
 *
 * A deliberately blunt heuristic. It exists to *prompt a decision*, not to classify
 * anything: the finding says "this looks like personal data and carries no
 * classification", and a human decides. Anything cleverer would be a detector people
 * trust more than it deserves.
 */
const SENSITIVE_HINTS = [
  "email",
  "phone",
  "mobile",
  "address",
  "postcode",
  "zip",
  "dob",
  "birth",
  "ssn",
  "nino",
  "passport",
  "tax_id",
  "national_id",
  "first_name",
  "last_name",
  "full_name",
  "surname",
  "gender",
  "ethnicity",
  "salary",
  "card_number",
  "iban",
  "account_number",
  "latitude",
  "longitude",
  "ip_address",
];

export function looksSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HINTS.some((hint) => lower.includes(hint));
}

/** Run the configured governance policies over the workspace. */
export function checkGovernance(graph: ObjectGraph, policy: GovernancePolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const severity = policy.severity ?? "warning";

  const report = (
    entry: { object: { id: string }; file?: string },
    code: string,
    message: string,
    path?: string,
  ): void => {
    diagnostics.push({
      severity,
      code,
      message,
      objectId: entry.object.id,
      ...(path ? { path } : {}),
      ...(entry.file ? { file: entry.file } : {}),
    });
  };

  for (const entry of graph.all()) {
    const object = entry.object;

    if (policy.requireOwner?.includes(object.kind) && !object.ownership?.owner) {
      report(entry, "governance/noOwner", `${object.kind} \`${object.name}\` has no owner`, "ownership.owner");
    }

    if (policy.requireDescription?.includes(object.kind) && !object.description?.trim()) {
      report(
        entry,
        "governance/noDescription",
        `${object.kind} \`${object.name}\` has no description`,
        "description",
      );
    }

    if (object.kind !== "table") continue;
    const table = object as Table;

    if (
      policy.requirePartitioningOver !== undefined &&
      table.objectType === "table" &&
      table.columns.length >= policy.requirePartitioningOver &&
      !table.partitioning
    ) {
      report(
        entry,
        "governance/noPartitioning",
        `\`${table.name}\` has ${table.columns.length} columns and no partitioning; an unpartitioned table of this size is a standing scan-cost risk`,
        "partitioning",
      );
    }

    for (const { column, path } of walkColumns(table.columns)) {
      if (policy.requireColumnDescriptions && !column.description?.trim()) {
        report(
          entry,
          "governance/noColumnDescription",
          `column \`${path}\` has no description`,
          `columns.${path}`,
        );
      }

      const classified =
        (column.classification?.categories.length ?? 0) > 0 || column.classification?.sensitivity;

      // `undefined` means the policy is off. An empty array means it is on with the
      // built-in heuristic alone, treating that as "off" would silently disable a
      // policy someone deliberately enabled.
      if (policy.requireClassificationFor !== undefined && !classified) {
        const matches = policy.requireClassificationFor.some((hint) =>
          column.name.toLowerCase().includes(hint.toLowerCase()),
        );
        if (matches || looksSensitive(column.name)) {
          report(
            entry,
            "governance/unclassified",
            `column \`${path}\` looks like personal data but carries no classification`,
            `columns.${path}`,
          );
        }
      }
    }
  }

  return diagnostics;
}

export interface CoverageReport {
  objects: number;
  withOwner: number;
  withDescription: number;
  columns: number;
  columnsWithDescription: number;
  sensitiveColumns: number;
  sensitiveClassified: number;
  /** Percentages, rounded, for a dashboard. */
  percentages: {
    owned: number;
    described: number;
    columnsDescribed: number;
    sensitiveClassified: number;
  };
}

/**
 * Coverage metrics.
 *
 * What a data officer actually asks for: how much of the estate is owned, described and
 * classified, and is that number moving. Reported whether or not the policies are
 * switched on, so a team can see where they stand before deciding what to enforce.
 */
export function coverage(graph: ObjectGraph): CoverageReport {
  let objects = 0;
  let withOwner = 0;
  let withDescription = 0;
  let columns = 0;
  let columnsWithDescription = 0;
  let sensitiveColumns = 0;
  let sensitiveClassified = 0;

  for (const entry of graph.all()) {
    const object = entry.object;
    if (object.kind === "diagram" || object.kind === "model") continue;

    objects++;
    if (object.ownership?.owner) withOwner++;
    if (object.description?.trim()) withDescription++;

    if (object.kind !== "table") continue;
    for (const { column } of walkColumns((object as Table).columns)) {
      columns++;
      if (column.description?.trim()) columnsWithDescription++;

      if (looksSensitive(column.name)) {
        sensitiveColumns++;
        if ((column.classification?.categories.length ?? 0) > 0 || column.classification?.sensitivity) {
          sensitiveClassified++;
        }
      }
    }
  }

  const percent = (part: number, whole: number): number =>
    whole === 0 ? 100 : Math.round((part / whole) * 100);

  return {
    objects,
    withOwner,
    withDescription,
    columns,
    columnsWithDescription,
    sensitiveColumns,
    sensitiveClassified,
    percentages: {
      owned: percent(withOwner, objects),
      described: percent(withDescription, objects),
      columnsDescribed: percent(columnsWithDescription, columns),
      sensitiveClassified: percent(sensitiveClassified, sensitiveColumns),
    },
  };
}

/**
 * Generate a CODEOWNERS file from ownership metadata.
 *
 * The point: approvals do not need an engine, because GitHub already is one. Map subject
 * areas onto the paths their objects live at and "Finance changes need the Finance
 * steward" becomes one line that branch protection enforces, reviewed by a security
 * team that has already signed off on GitHub.
 */
export function generateCodeowners(
  graph: ObjectGraph,
  fileOf: (objectId: string) => string | undefined,
): string {
  // Collect owners per directory, since CODEOWNERS matches paths, not objects.
  const byDirectory = new Map<string, Set<string>>();

  for (const entry of graph.all()) {
    const owner = entry.object.ownership?.owner ?? entry.object.ownership?.team;
    if (!owner) continue;

    const file = fileOf(entry.object.id) ?? entry.file;
    if (!file) continue;

    const directory = file.split("/").slice(0, -1).join("/") || ".";
    const handle = owner.startsWith("@") || owner.includes("@") ? owner : `@${owner}`;

    const existing = byDirectory.get(directory);
    if (existing) existing.add(handle);
    else byDirectory.set(directory, new Set([handle]));
  }

  const lines = [
    "# Generated from ownership metadata in the data model.",
    "#",
    "# Approvals are enforced by GitHub branch protection rather than by the modelling",
    "# tool, so a change cannot be merged without the right steward regardless of what",
    "# permissions someone holds inside the tool.",
    "",
  ];

  if (byDirectory.size === 0) {
    lines.push("# No objects declare an owner yet, so there is nothing to enforce.");
    return `${lines.join("\n")}\n`;
  }

  for (const [directory, owners] of [...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`/${directory}/ ${[...owners].sort().join(" ")}`);
  }

  return `${lines.join("\n")}\n`;
}
