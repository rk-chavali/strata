import { describe, expect, it } from "vitest";
import {
  asNotation,
  edgeStyleFor,
  isDependentEntity,
  memberSuffixFor,
  NOTATIONS,
  NOTATION_HINT,
  NOTATION_LABEL,
} from "./notation";

/**
 * The notation rules, tested as pure logic.
 *
 * This is the first test file in `apps/web`, and this module is the right place to start:
 * every notation difference is a pure function of three facts (identifying, and the
 * cardinality at each end), and getting those rules wrong produces a diagram that is
 * confidently, legibly *wrong*, which is worse than one that fails to render, because a
 * reader trusts it. A solid line in IDEF1X asserts that the child's identity depends on the
 * parent. If we draw that for a non-identifying relationship, we have lied in a notation the
 * reader is trained to believe.
 *
 * No DOM here on purpose. The SVG markers are declarative and best checked by eye; the
 * decisions about *which* marker, and whether the line breaks, are what benefit from being
 * pinned down.
 */

const identifying = {
  identifying: true,
  sourceCardinality: "exactly-one",
  targetCardinality: "zero-or-more",
};

const nonIdentifying = {
  identifying: false,
  sourceCardinality: "exactly-one",
  targetCardinality: "zero-or-more",
};

describe("asNotation", () => {
  it("passes through every declared notation", () => {
    for (const notation of NOTATIONS) {
      expect(asNotation(notation)).toBe(notation);
    }
  });

  it("falls back to crow's foot for unknown or missing values", () => {
    // A diagram written by a future version, or hand-edited YAML, must still render.
    expect(asNotation(undefined)).toBe("crowsFoot");
    expect(asNotation("")).toBe("crowsFoot");
    expect(asNotation("chen")).toBe("crowsFoot");
  });

  it("has a label and a hint for every notation", () => {
    // The switcher shows both; a missing one would render an empty menu row.
    for (const notation of NOTATIONS) {
      expect(NOTATION_LABEL[notation]).toBeTruthy();
      expect(NOTATION_HINT[notation]).toBeTruthy();
    }
  });
});

describe("edgeStyleFor, IDEF1X", () => {
  it("draws a solid line for an identifying relationship", () => {
    // The core assertion of the notation: solid means identity flows from the parent.
    expect(edgeStyleFor("idef1x", identifying).dash).toBeUndefined();
  });

  it("draws a dashed line for a non-identifying relationship", () => {
    expect(edgeStyleFor("idef1x", nonIdentifying).dash).toBe("5 4");
  });

  it("always puts a filled circle at the child end, whatever the cardinality", () => {
    // IDEF1X does not vary this glyph by cardinality, that is what the letter codes are for.
    for (const targetCardinality of ["zero-or-one", "exactly-one", "zero-or-more", "one-or-more"]) {
      const style = edgeStyleFor("idef1x", { ...identifying, targetCardinality });
      expect(style.markerEnd).toBe("idef-child");
    }
  });

  it("writes P for one-or-more and Z for zero-or-one", () => {
    expect(edgeStyleFor("idef1x", { ...identifying, targetCardinality: "one-or-more" }).endLabel).toBe("P");
    expect(edgeStyleFor("idef1x", { ...identifying, targetCardinality: "zero-or-one" }).endLabel).toBe("Z");
    expect(edgeStyleFor("idef1x", { ...identifying, targetCardinality: "exactly-one" }).endLabel).toBe("1");
  });

  it("leaves the common zero-or-more case unmarked", () => {
    // Marking it would put a symbol on nearly every line in the diagram to say nothing.
    expect(edgeStyleFor("idef1x", { ...identifying, targetCardinality: "zero-or-more" }).endLabel)
      .toBeUndefined();
  });

  it("marks a nullable foreign key with a diamond at the parent", () => {
    // Non-identifying *and* an optional parent is what makes the migrated key nullable.
    const style = edgeStyleFor("idef1x", {
      identifying: false,
      sourceCardinality: "zero-or-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.markerStart).toBe("idef-optional-parent");
  });

  it("does not mark the parent when the relationship is identifying", () => {
    // An identifying relationship's key is part of the child's own primary key, so it
    // cannot be null, a diamond there would contradict the solid line.
    const style = edgeStyleFor("idef1x", {
      identifying: true,
      sourceCardinality: "zero-or-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.markerStart).toBeUndefined();
  });

  it("does not mark the parent when it is mandatory", () => {
    expect(edgeStyleFor("idef1x", nonIdentifying).markerStart).toBeUndefined();
  });
});

describe("edgeStyleFor, crow's foot", () => {
  it("picks a glyph per cardinality at both ends", () => {
    const style = edgeStyleFor("crowsFoot", {
      identifying: true,
      sourceCardinality: "exactly-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.markerStart).toBe("cf-one");
    expect(style.markerEnd).toBe("cf-zero-many");
  });

  it("maps every cardinality to a marker", () => {
    const expected = {
      "zero-or-one": "cf-zero-one",
      "exactly-one": "cf-one",
      "zero-or-more": "cf-zero-many",
      "one-or-more": "cf-one-many",
    };
    for (const [cardinality, marker] of Object.entries(expected)) {
      expect(edgeStyleFor("crowsFoot", { ...identifying, targetCardinality: cardinality }).markerEnd)
        .toBe(marker);
    }
  });

  it("dashes non-identifying relationships in IE", () => {
    expect(edgeStyleFor("crowsFoot", identifying).dash).toBeUndefined();
    expect(edgeStyleFor("crowsFoot", nonIdentifying).dash).toBe("5 4");
  });

  it("writes no end labels, the glyphs carry the cardinality", () => {
    const style = edgeStyleFor("crowsFoot", identifying);
    expect(style.startLabel).toBeUndefined();
    expect(style.endLabel).toBeUndefined();
  });
});

describe("edgeStyleFor, UML", () => {
  it("writes multiplicity at both ends", () => {
    const style = edgeStyleFor("uml", {
      identifying: false,
      sourceCardinality: "zero-or-one",
      targetCardinality: "one-or-more",
    });
    expect(style.startLabel).toBe("0..1");
    expect(style.endLabel).toBe("1..*");
  });

  it("uses * for zero-or-more and 1 for exactly-one", () => {
    const style = edgeStyleFor("uml", {
      identifying: false,
      sourceCardinality: "exactly-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.startLabel).toBe("1");
    expect(style.endLabel).toBe("*");
  });

  it("never dashes the line", () => {
    // In UML a dashed line means dependency or realisation. Reusing it for non-identifying
    // would assert something false to anyone who actually reads UML.
    expect(edgeStyleFor("uml", nonIdentifying).dash).toBeUndefined();
    expect(edgeStyleFor("uml", identifying).dash).toBeUndefined();
  });

  it("renders an identifying relationship as composition", () => {
    expect(edgeStyleFor("uml", identifying).markerStart).toBe("uml-composition");
    expect(edgeStyleFor("uml", nonIdentifying).markerStart).toBeUndefined();
  });

  it("puts no crow's foot at the child end", () => {
    expect(edgeStyleFor("uml", identifying).markerEnd).toBeUndefined();
  });
});

describe("edgeStyleFor, Barker", () => {
  it("dashes the half touching an optional end", () => {
    const style = edgeStyleFor("barker", {
      identifying: false,
      sourceCardinality: "exactly-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.splitLine).toEqual({ startHalfDashed: false, endHalfDashed: true });
  });

  it("dashes both halves when both ends are optional", () => {
    const style = edgeStyleFor("barker", {
      identifying: false,
      sourceCardinality: "zero-or-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.splitLine).toEqual({ startHalfDashed: true, endHalfDashed: true });
  });

  it("leaves both halves solid when both ends are mandatory", () => {
    const style = edgeStyleFor("barker", {
      identifying: false,
      sourceCardinality: "exactly-one",
      targetCardinality: "one-or-more",
    });
    expect(style.splitLine).toEqual({ startHalfDashed: false, endHalfDashed: false });
  });

  it("uses a bare crow's foot for many and nothing for one", () => {
    // Barker has no bar for "one", optionality is in the line, not in a glyph.
    const style = edgeStyleFor("barker", {
      identifying: false,
      sourceCardinality: "exactly-one",
      targetCardinality: "zero-or-more",
    });
    expect(style.markerEnd).toBe("cf-many-plain");
    expect(style.markerStart).toBeUndefined();
  });

  it("never sets a whole-line dash, which would fight the halves", () => {
    expect(edgeStyleFor("barker", nonIdentifying).dash).toBeUndefined();
  });
});

describe("isDependentEntity", () => {
  it("treats weak and associative entities as dependent", () => {
    // Both cannot be identified without a parent, which is what rounded corners assert.
    expect(isDependentEntity({ kind: "entity", entityType: "weak" })).toBe(true);
    expect(isDependentEntity({ kind: "entity", entityType: "associative" })).toBe(true);
  });

  it("treats a plain entity, a supertype and a subtype as independent", () => {
    expect(isDependentEntity({ kind: "entity", entityType: "entity" })).toBe(false);
    expect(isDependentEntity({ kind: "entity", entityType: "supertype" })).toBe(false);
    expect(isDependentEntity({ kind: "entity", entityType: "subtype" })).toBe(false);
  });

  it("never applies to tables or concepts", () => {
    // Neither has a notion of identifier dependence, and a physical diagram in IDEF1X must
    // not sprout rounded boxes because a column happens to be a foreign key.
    expect(isDependentEntity({ kind: "table", entityType: "weak" })).toBe(false);
    expect(isDependentEntity({ kind: "concept" })).toBe(false);
  });

  it("is false when the entity type is absent", () => {
    expect(isDependentEntity({ kind: "entity" })).toBe(false);
  });
});

describe("memberSuffixFor", () => {
  it("marks foreign keys with (FK) in IDEF1X", () => {
    expect(memberSuffixFor("idef1x", { isForeignKey: true })).toBe("(FK)");
  });

  it("marks nothing else in IDEF1X", () => {
    expect(memberSuffixFor("idef1x", { isForeignKey: false })).toBeUndefined();
  });

  it("marks nothing in the other notations", () => {
    // `(FK)` is specifically an IDEF1X convention; in crow's foot the key icon carries it.
    for (const notation of ["crowsFoot", "uml", "barker"] as const) {
      expect(memberSuffixFor(notation, { isForeignKey: true })).toBeUndefined();
    }
  });
});
