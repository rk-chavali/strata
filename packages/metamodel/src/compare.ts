import type { ObjectGraph } from "./graph.js";
import type { AnyObject } from "./object.js";

/**
 * Compare two models and report what differs.
 *
 * This is the feature people actually renew erwin for, and it answers a question the
 * tool could not previously answer at all: *has the physical model drifted from the
 * logical one?* Two models that were designed together diverge quietly, a column added
 * straight to the warehouse, an entity nobody ever implemented, and without a compare
 * the first anyone hears of it is a broken load or a failed audit.
 *
 * The hard part is not the diff, it is the **matching**. `Customer` and `dim_customer`
 * are the same thing named by two different conventions, and a comparison that cannot
 * see that reports every single object as missing on both sides, which is worse than
 * useless. So matching runs in three passes, most trustworthy first.
 */

export type DifferenceKind =
  | "onlyInLeft"
  | "onlyInRight"
  | "memberOnlyInLeft"
  | "memberOnlyInRight"
  | "typeChanged"
  | "requiredChanged"
  | "keyChanged";

export interface Difference {
  kind: DifferenceKind;
  /**
   * The left-hand object's name, always, even for a difference that only exists on the
   * right.
   *
   * Keying on "whichever side has it" split one matched pair across two groups in the
   * UI: `Customer` for the missing attributes and `dim_customer` for the extra columns,
   * as if they were unrelated objects. They are one pairing and belong in one group.
   */
  object: string;
  /** The right-hand object's name, when the two were matched. */
  counterpart?: string;
  /** Attribute or column, when the difference is below object level. */
  member?: string;
  left?: string;
  right?: string;
  /** How the two objects were matched, so a wrong pairing can be spotted. */
  matchedBy?: MatchReason;
  message: string;
}

export type MatchReason = "reference" | "name" | "normalisedName";

export interface Pairing {
  left?: AnyObject;
  right?: AnyObject;
  matchedBy?: MatchReason;
}

export interface CompareResult {
  left: string;
  right: string;
  pairs: Pairing[];
  differences: Difference[];
  summary: {
    matched: number;
    onlyInLeft: number;
    onlyInRight: number;
    memberDifferences: number;
  };
}

/** Objects worth comparing, the ones that carry structure. */
const COMPARABLE = new Set(["entity", "table", "concept"]);

/**
 * Abbreviations every warehouse uses, expanded to their long form.
 *
 * A logical model says `Customer Identifier`; the table says `customer_id`. They are the
 * same attribute, and a compare that cannot see that reports it as *both* missing from
 * the physical model *and* extra in it, two false rows for one non-difference. On a real
 * model that is most of the output, and a compare full of false positives is one nobody
 * reads.
 *
 * Expanding rather than contracting, so `id` and `identifier` both land on the long form
 * whichever side each appears on.
 */
const ABBREVIATIONS: Record<string, string> = {
  id: "identifier",
  num: "number",
  no: "number",
  nbr: "number",
  desc: "description",
  amt: "amount",
  qty: "quantity",
  cd: "code",
  dt: "date",
  ts: "timestamp",
  nm: "name",
  addr: "address",
  pct: "percent",
  ind: "flag",
  flg: "flag",
};

/**
 * Reduce a name to a comparison key, ignoring convention.
 *
 * `Customer Order Line`, `customer_order_line` and `dim_customer_order_line` all reduce
 * to the same key. The prefixes stripped are the dimensional-modelling ones that carry
 * nothing about *what* the thing is, `dim_customer` and `Customer` are one entity,
 * whereas `customer_archive` is genuinely another, so only known prefixes go rather than
 * anything up to the first separator.
 */
export function normaliseName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word);

  return words
    .join("")
    .replace(/^(dim|fct|fact|stg|staging|raw|src|tmp|wrk|hist)/, "")
    .replace(/(dim|fact|table|entity)$/, "");
}

function membersOf(object: AnyObject): { name: string; type?: string; required: boolean; key: boolean }[] {
  const record = object as unknown as Record<string, unknown>;
  const columns = record.columns as
    | { name: string; dataType?: string; mode?: string }[]
    | undefined;
  const attributes = record.attributes as
    | { name: string; logicalType?: string; domain?: string; required?: boolean }[]
    | undefined;
  const primaryKey = (record.primaryKey as string[] | undefined) ?? [];
  const keys = new Set(primaryKey.map((key) => key.toLowerCase()));

  if (columns) {
    return columns.map((column) => ({
      name: column.name,
      ...(column.dataType ? { type: column.dataType } : {}),
      required: column.mode === "REQUIRED",
      key: keys.has(column.name.toLowerCase()),
    }));
  }

  return (attributes ?? []).map((attribute) => ({
    name: attribute.name,
    // A domain reference is the type for comparison purposes, two attributes on the
    // same domain have the same type whatever each one spells inline.
    ...(attribute.domain ?? attribute.logicalType
      ? { type: attribute.domain ?? attribute.logicalType }
      : {}),
    required: attribute.required ?? false,
    key: keys.has(attribute.name.toLowerCase()),
  }));
}

/** Trace references that say outright which object this one derives from. */
function traceRefs(object: AnyObject): string[] {
  const record = object as unknown as Record<string, unknown>;
  return [record.entityRef, record.conceptRef, record.derivedFrom]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.split("/").pop() ?? value);
}

export function compareModels(graph: ObjectGraph, leftName: string, rightName: string): CompareResult {
  const left = graph.inModel(leftName).map((entry) => entry.object).filter((o) => COMPARABLE.has(o.kind));
  const right = graph.inModel(rightName).map((entry) => entry.object).filter((o) => COMPARABLE.has(o.kind));

  const pairs: Pairing[] = [];
  const differences: Difference[] = [];
  const takenRight = new Set<string>();

  /**
   * Three passes, most trustworthy first.
   *
   * A trace reference is the model author stating the correspondence outright, so it
   * wins. An exact name match is next. Normalised names are last because they are a
   * guess, `dim_customer` ↔ `Customer` is almost always right, but it is inference, and
   * the pass order means it only ever fills gaps the explicit passes left.
   */
  const findMatch = (object: AnyObject): { match?: AnyObject; reason?: MatchReason } => {
    const refs = traceRefs(object).map((ref) => ref.toLowerCase());
    const byRef = right.find(
      (candidate) =>
        !takenRight.has(candidate.id) &&
        (refs.includes(candidate.name.toLowerCase()) ||
          refs.includes(candidate.id.toLowerCase()) ||
          traceRefs(candidate).some((ref) => ref.toLowerCase() === object.name.toLowerCase())),
    );
    if (byRef) return { match: byRef, reason: "reference" };

    const byName = right.find(
      (candidate) =>
        !takenRight.has(candidate.id) && candidate.name.toLowerCase() === object.name.toLowerCase(),
    );
    if (byName) return { match: byName, reason: "name" };

    const key = normaliseName(object.name);
    const byNormalised = right.find(
      (candidate) => !takenRight.has(candidate.id) && normaliseName(candidate.name) === key,
    );
    if (byNormalised) return { match: byNormalised, reason: "normalisedName" };

    return {};
  };

  for (const object of left) {
    const { match, reason } = findMatch(object);

    if (!match) {
      pairs.push({ left: object });
      differences.push({
        kind: "onlyInLeft",
        object: object.name,
        message: `\`${object.name}\` has no counterpart in ${rightName}`,
      });
      continue;
    }

    takenRight.add(match.id);
    pairs.push({ left: object, right: match, ...(reason ? { matchedBy: reason } : {}) });
    differences.push(...compareMembers(object, match, reason));
  }

  for (const object of right) {
    if (takenRight.has(object.id)) continue;
    pairs.push({ right: object });
    differences.push({
      kind: "onlyInRight",
      object: object.name,
      message: `\`${object.name}\` exists only in ${rightName}`,
    });
  }

  return {
    left: leftName,
    right: rightName,
    pairs,
    differences,
    summary: {
      matched: pairs.filter((pair) => pair.left && pair.right).length,
      onlyInLeft: differences.filter((d) => d.kind === "onlyInLeft").length,
      onlyInRight: differences.filter((d) => d.kind === "onlyInRight").length,
      memberDifferences: differences.filter((d) => d.kind.startsWith("member") || d.kind.endsWith("Changed"))
        .length,
    },
  };
}

function compareMembers(left: AnyObject, right: AnyObject, matchedBy?: MatchReason): Difference[] {
  const differences: Difference[] = [];
  const leftMembers = membersOf(left);
  const rightMembers = membersOf(right);
  const rightByKey = new Map(rightMembers.map((member) => [normaliseName(member.name), member]));
  const seen = new Set<string>();

  for (const member of leftMembers) {
    const key = normaliseName(member.name);
    const counterpart = rightByKey.get(key);

    if (!counterpart) {
      differences.push({
        kind: "memberOnlyInLeft",
        object: left.name,
        counterpart: right.name,
        member: member.name,
        ...(matchedBy ? { matchedBy } : {}),
        message: `\`${member.name}\` is missing from \`${right.name}\``,
      });
      continue;
    }
    seen.add(key);

    /**
     * Types are only compared when both sides state one.
     *
     * A logical attribute types as `decimal` and its column as `NUMERIC(18, 2)`; those
     * are the same decision expressed in two vocabularies, and reporting them as a
     * difference would bury the real ones. So this reports a change only when the two
     * are both present and normalise differently, deliberately conservative, because a
     * compare full of false positives is one nobody reads.
     */
    if (member.type && counterpart.type && normaliseName(member.type) !== normaliseName(counterpart.type)) {
      differences.push({
        kind: "typeChanged",
        object: left.name,
        counterpart: right.name,
        member: member.name,
        left: member.type,
        right: counterpart.type,
        ...(matchedBy ? { matchedBy } : {}),
        message: `\`${left.name}.${member.name}\` is ${member.type} but ${counterpart.type} in \`${right.name}\``,
      });
    }

    if (member.required !== counterpart.required) {
      differences.push({
        kind: "requiredChanged",
        object: left.name,
        counterpart: right.name,
        member: member.name,
        left: member.required ? "required" : "optional",
        right: counterpart.required ? "required" : "optional",
        ...(matchedBy ? { matchedBy } : {}),
        message: `\`${left.name}.${member.name}\` is ${member.required ? "required" : "optional"} but ${counterpart.required ? "required" : "optional"} in \`${right.name}\``,
      });
    }

    if (member.key !== counterpart.key) {
      differences.push({
        kind: "keyChanged",
        object: left.name,
        counterpart: right.name,
        member: member.name,
        left: member.key ? "key" : "not a key",
        right: counterpart.key ? "key" : "not a key",
        ...(matchedBy ? { matchedBy } : {}),
        message: `\`${left.name}.${member.name}\` ${member.key ? "is" : "is not"} part of the primary key, ${counterpart.key ? "but is" : "but is not"} in \`${right.name}\``,
      });
    }
  }

  for (const member of rightMembers) {
    if (seen.has(normaliseName(member.name))) continue;
    differences.push({
      kind: "memberOnlyInRight",
      object: left.name,
      counterpart: right.name,
      member: member.name,
      ...(matchedBy ? { matchedBy } : {}),
      message: `\`${member.name}\` exists only in \`${right.name}\``,
    });
  }

  return differences;
}
