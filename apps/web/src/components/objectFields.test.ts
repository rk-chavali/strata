import { describe, expect, it } from "vitest";
import { FIELDS, LOAD_STRATEGIES, readPath, writePath } from "./objectFields";
import type { ModelObject } from "../types";

/**
 * Reading and writing a field in the properties panel, which is how objects are edited.
 *
 * Everything here ends up in a YAML file in somebody's git repository, so the failure mode is
 * not a broken screen, it is a wrong commit. Two behaviours carry that risk and neither was
 * pinned: whether blanking a box removes the key or writes an empty string, and whether an edit
 * copies the object or mutates the one React is still holding.
 *
 * The first has already had consequences. `dataset: ""` is not the same as "inherit the model's
 * dataset": persisting the empty string generates `project..table` in the DDL, which is not
 * valid and not obviously wrong to read.
 */

const table = {
  id: "tbl_fct_order",
  kind: "table",
  name: "fct_order",
  model: "shop_warehouse",
  target: { project: "acme", dataset: "mart", table: "fct_order" },
} as unknown as ModelObject;

describe("readPath", () => {
  it("reads a top-level field", () => {
    expect(readPath(table, "name")).toBe("fct_order");
  });

  it("reads through a dotted path", () => {
    expect(readPath(table, "target.dataset")).toBe("mart");
  });

  it("reads a missing branch as empty rather than crashing", () => {
    // The panel renders every field for a kind, including ones this object has never set.
    expect(readPath(table, "classification.sensitivity")).toBe("");
    expect(readPath(table, "nothing")).toBe("");
    expect(readPath(table, "name.deeper.still")).toBe("");
  });

  it("renders a non-string value as text rather than [object Object]", () => {
    const withNumber = { ...table, precision: 18 } as unknown as ModelObject;

    expect(readPath(withNumber, "precision")).toBe("18");
  });
});

describe("writePath", () => {
  it("sets a top-level field", () => {
    expect(writePath(table, "name", "fct_order_line")).toMatchObject({ name: "fct_order_line" });
  });

  it("sets a nested field without disturbing its siblings", () => {
    const next = writePath(table, "target.dataset", "staging") as unknown as {
      target: Record<string, string>;
    };

    expect(next.target).toEqual({ project: "acme", dataset: "staging", table: "fct_order" });
  });

  it("creates the branches on the way down", () => {
    const next = writePath(table, "classification.sensitivity", "pii") as unknown as {
      classification: Record<string, string>;
    };

    expect(next.classification).toEqual({ sensitivity: "pii" });
  });

  it("deletes the key when a field is blanked, rather than writing an empty string", () => {
    /*
      The behaviour the DDL depends on. An empty `dataset` must mean "inherit", and it can only
      mean that if the key is absent: the generator reads a present-but-empty string literally
      and emits `acme..fct_order`.
    */
    const next = writePath(table, "target.dataset", "") as unknown as {
      target: Record<string, string>;
    };

    expect("dataset" in next.target).toBe(false);
    expect(next.target).toEqual({ project: "acme", table: "fct_order" });
  });

  it("treats whitespace as blank, so a stray space does not become a value", () => {
    const next = writePath(table, "target.dataset", "   ") as unknown as {
      target: Record<string, string>;
    };

    expect("dataset" in next.target).toBe(false);
  });

  it("does not mutate the object it was given, at any depth", () => {
    /*
      React state, so a mutation here is the classic bug where the value changes but nothing
      re-renders, or worse, an undo step holds the same object it was meant to snapshot.
    */
    const before = JSON.parse(JSON.stringify(table)) as unknown;

    const next = writePath(table, "target.dataset", "staging");

    expect(table).toEqual(before);
    expect(next).not.toBe(table);
    expect((next as unknown as { target: unknown }).target).not.toBe(
      (table as unknown as { target: unknown }).target,
    );
  });
});

describe("the field tables the panel renders from", () => {
  it("gives every field a key and a label", () => {
    // A field with no label renders as an unlabelled box, which is unusable and easy to miss.
    for (const [kind, fields] of Object.entries(FIELDS)) {
      for (const field of fields) {
        expect(field.key, `${kind} has a field with no key`).toBeTruthy();
        expect(field.label, `${kind}.${field.key} has no label`).toBeTruthy();
      }
    }
  });

  it("gives every select its options, so it is not an empty dropdown", () => {
    for (const [kind, fields] of Object.entries(FIELDS)) {
      for (const field of fields.filter((candidate) => candidate.type === "select")) {
        expect(field.options?.length, `${kind}.${field.key} is a select with no options`)
          .toBeGreaterThan(0);
      }
    }
  });

  it("explains every load strategy, because the choice is a business decision", () => {
    // The difference between scd1 and scd2 is whether history exists at all.
    for (const strategy of LOAD_STRATEGIES) {
      expect(strategy.hint, `${strategy.value} has no hint`).toBeTruthy();
    }
  });
});
