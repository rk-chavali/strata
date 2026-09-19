import type { EdgeView, NodeView } from "../types";

/**
 * How a relationship is drawn, per notation.
 *
 * **Why this is a module and not a few conditionals in the canvas.** `diagram.ts` has
 * declared `NOTATIONS = ["crowsFoot", "idef1x", "uml", "barker"]` since the metamodel was
 * written, and every diagram carries a `notation` field, but the canvas only ever drew
 * crow's foot, and the string `idef1x` appeared nowhere in the UI. The model was already
 * right; only the rendering was missing.
 *
 * That matters more than it sounds. IDEF1X is the notation US enterprise and federal data
 * architects are trained on, and a tool that cannot draw it reads as a diagramming toy no
 * matter how good its metamodel is. The notations differ in
 * what they put at the *ends* of a line, whether the *line itself* is broken, and where
 * cardinality goes, so the whole difference collapses into one function returning a
 * style, which is what this is.
 *
 * The facts each notation reads from are the same three: is the relationship identifying,
 * and what is the cardinality at each end. Everything else is presentation.
 */

export const NOTATIONS = ["crowsFoot", "idef1x", "uml", "barker"] as const;
export type Notation = (typeof NOTATIONS)[number];

export const NOTATION_LABEL: Record<Notation, string> = {
  crowsFoot: "Crow's foot",
  idef1x: "IDEF1X",
  uml: "UML",
  barker: "Barker",
};

/**
 * Shown in the switcher, so the choice is informed rather than a guess at four names.
 *
 * Kept to a few words each. They render in a menu row's trailing slot beside the label,
 * and a full sentence there truncates to uselessness at any sane menu width, "IDEF1X" and
 * "Barker" mean nothing to someone who has only ever seen crow's foot, so the hint has to
 * survive in the space available rather than being clipped.
 */
export const NOTATION_HINT: Record<Notation, string> = {
  crowsFoot: "Information Engineering",
  idef1x: "Federal and enterprise standard",
  uml: "1, 0..1, 1..*",
  barker: "Oracle style",
};

export function asNotation(value: string | undefined): Notation {
  return (NOTATIONS as readonly string[]).includes(value ?? "")
    ? (value as Notation)
    : "crowsFoot";
}

export type Cardinality = "zero-or-one" | "exactly-one" | "zero-or-more" | "one-or-more";

function isMany(cardinality: string): boolean {
  return cardinality === "zero-or-more" || cardinality === "one-or-more";
}

function isOptional(cardinality: string): boolean {
  return cardinality === "zero-or-one" || cardinality === "zero-or-more";
}

export interface EdgeStyle {
  /** Marker id at the parent end, without the `url(#…)` wrapper. */
  markerStart?: string;
  /** Marker id at the child end. */
  markerEnd?: string;
  /** SVG dash pattern for the whole line, or undefined for solid. */
  dash?: string;
  /**
   * Barker only: the line is solid on the mandatory half and dashed on the optional half,
   * so a single dash pattern cannot express it and the edge is drawn as two paths.
   */
  splitLine?: { startHalfDashed: boolean; endHalfDashed: boolean };
  /** Short text drawn near an end. UML multiplicity, IDEF1X cardinality codes. */
  startLabel?: string;
  endLabel?: string;
}

/**
 * IDEF1X cardinality codes, written beside the child end.
 *
 * IDEF1X does not vary the glyph by cardinality the way crow's foot does, the child end
 * is always a filled circle. The *count* is a letter next to it, and its absence means
 * "zero, one or many", which is the common case and therefore unmarked. Marking it anyway
 * would put a symbol on every line in the diagram to say nothing.
 */
const IDEF1X_CODE: Record<string, string | undefined> = {
  "zero-or-more": undefined,
  "one-or-more": "P",
  "zero-or-one": "Z",
  "exactly-one": "1",
};

/** UML multiplicity, in the notation a class diagram uses. */
const UML_MULTIPLICITY: Record<string, string> = {
  "zero-or-one": "0..1",
  "exactly-one": "1",
  "zero-or-more": "*",
  "one-or-more": "1..*",
};

const CROWS_FOOT_MARKER: Record<string, string> = {
  "zero-or-one": "cf-zero-one",
  "exactly-one": "cf-one",
  "zero-or-more": "cf-zero-many",
  "one-or-more": "cf-one-many",
};

/**
 * The style for one edge, in one notation.
 *
 * `source` is the parent (the "one" side) and `target` the child, the direction
 * `relationship.ts` migrates keys in.
 */
export function edgeStyleFor(
  notation: Notation,
  edge: Pick<EdgeView, "identifying" | "sourceCardinality" | "targetCardinality">,
): EdgeStyle {
  switch (notation) {
    /**
     * IDEF1X.
     *
     * Solid line for identifying, dashed for non-identifying, the single most important
     * distinction in the notation, because an identifying relationship is what makes the
     * child's identity depend on the parent. A filled circle marks the child end always.
     * The parent end carries a diamond only when the relationship is non-identifying and
     * the parent is optional, which is IDEF1X's way of saying the foreign key is nullable.
     */
    case "idef1x": {
      const code = IDEF1X_CODE[edge.targetCardinality];
      return {
        markerEnd: "idef-child",
        ...(!edge.identifying && isOptional(edge.sourceCardinality)
          ? { markerStart: "idef-optional-parent" }
          : {}),
        ...(edge.identifying ? {} : { dash: "5 4" }),
        ...(code ? { endLabel: code } : {}),
      };
    }

    /**
     * UML class diagram.
     *
     * No end glyphs for a plain association, multiplicity as text at both ends. An
     * identifying relationship becomes composition, a filled diamond at the parent, * because "the child cannot exist without the parent" is exactly what composition
     * means, and it is the closest honest mapping between the two vocabularies.
     *
     * Never dashed: in UML a dashed line means a dependency or a realisation, so reusing
     * it for non-identifying would say something false to anyone who reads UML.
     */
    case "uml":
      return {
        ...(edge.identifying ? { markerStart: "uml-composition" } : {}),
        startLabel: UML_MULTIPLICITY[edge.sourceCardinality] ?? "1",
        endLabel: UML_MULTIPLICITY[edge.targetCardinality] ?? "*",
      };

    /**
     * Barker (Oracle) notation.
     *
     * Its defining feature is that optionality is carried by *half* the line rather than
     * by a glyph: the half touching an optional end is dashed, the half touching a
     * mandatory end is solid. So a line can be dashed at one end and solid at the other,
     * which no single `stroke-dasharray` can express, hence `splitLine`, which the edge
     * component renders as two paths.
     *
     * Many is a crow's foot, as in IE. One is bare, Barker has no bar.
     */
    case "barker":
      return {
        ...(isMany(edge.targetCardinality) ? { markerEnd: "cf-many-plain" } : {}),
        ...(isMany(edge.sourceCardinality) ? { markerStart: "cf-many-plain" } : {}),
        splitLine: {
          startHalfDashed: isOptional(edge.sourceCardinality),
          endHalfDashed: isOptional(edge.targetCardinality),
        },
      };

    /**
     * Information Engineering, the crow's foot everyone recognises.
     *
     * Cardinality is entirely in the glyphs at both ends, and identifying relationships
     * are solid while non-identifying are dashed.
     */
    case "crowsFoot":
    default:
      return {
        markerStart: CROWS_FOOT_MARKER[edge.sourceCardinality] ?? "cf-one",
        markerEnd: CROWS_FOOT_MARKER[edge.targetCardinality] ?? "cf-zero-many",
        ...(edge.identifying ? {} : { dash: "5 4" }),
      };
  }
}

/**
 * Whether a box is drawn with rounded corners.
 *
 * IDEF1X only, and it is not styling: rounded corners mean the entity is
 * **identifier-dependent**, its primary key contains a key migrated from a parent, so it
 * cannot be identified without that parent. Square corners mean independent. A reader
 * scanning an IDEF1X diagram uses corner shape to find the dependent entities before
 * reading a single attribute name, so getting it wrong misinforms rather than merely
 * looking off.
 *
 * `weak` and `associative` are exactly the dependent cases: a weak entity depends on its
 * parent for identity, and an associative entity exists only to resolve a many-to-many
 * between two others.
 */
export function isDependentEntity(node: Pick<NodeView, "kind" | "entityType">): boolean {
  if (node.kind !== "entity") return false;
  return node.entityType === "weak" || node.entityType === "associative";
}

/**
 * The suffix IDEF1X writes after a migrated attribute's name.
 *
 * `(FK)` on a foreign key is required by the notation, it is how a reader knows which
 * attributes arrived through a relationship rather than being native to the entity, and
 * it is the visible trace of key migration. Primary keys already sit in their own
 * compartment above the line, so a key that is both gets `(FK)` and nothing more.
 */
export function memberSuffixFor(
  notation: Notation,
  member: { isForeignKey: boolean },
): string | undefined {
  if (notation !== "idef1x") return undefined;
  return member.isForeignKey ? "(FK)" : undefined;
}
