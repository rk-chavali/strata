import { describe, expect, it } from "vitest";
import { initialPairs } from "./RelateDialog";
import type { MemberView } from "../types";

/**
 * The default column pairing for a new relationship.
 *
 * This is the logic that used to live on the server as a silent inference: take the
 * parent's key, look for a child column with the same name, and create one if there is no
 * match. The inference itself is reasonable, it is right most of the time, but doing it
 * invisibly meant a warehouse whose child column was called `customer_key` while the
 * parent's key was `customer_id` quietly grew a *second* column, and the resulting foreign
 * key joined on something nobody populated.
 *
 * Same defaults, then. The difference is that they are now a starting point shown on
 * screen rather than a decision made on the user's behalf, so these tests pin down what
 * the user is shown before they confirm it.
 */

function member(name: string, extra: Partial<MemberView> = {}): MemberView {
  return {
    name,
    path: name,
    type: "STRING",
    required: false,
    isPrimaryKey: false,
    isForeignKey: false,
    depth: 0,
    ...extra,
  };
}

describe("initialPairs", () => {
  it("pairs a key with the child column of the same name", () => {
    const pairs = initialPairs(
      [member("customer_key", { isPrimaryKey: true, type: "INT64" })],
      [member("order_id"), member("customer_key", { type: "INT64" })],
    );

    expect(pairs).toEqual([{ parent: "customer_key", child: "customer_key", creating: false }]);
  });

  it("matches case-insensitively", () => {
    // Warehouses are inconsistent about case and a missed match silently creates a
    // duplicate column, which is the exact failure this mapper exists to prevent.
    const pairs = initialPairs(
      [member("CustomerKey", { isPrimaryKey: true })],
      [member("customerkey")],
    );

    expect(pairs[0]?.creating).toBe(false);
    // The child's own spelling is kept, it is the column that actually exists.
    expect(pairs[0]?.child).toBe("customerkey");
  });

  it("offers to create a column when the child has no match", () => {
    const pairs = initialPairs(
      [member("customer_key", { isPrimaryKey: true })],
      [member("order_id"), member("line_num")],
    );

    expect(pairs).toEqual([{ parent: "customer_key", child: "customer_key", creating: true }]);
  });

  it("produces one row per part of a composite key, in key order", () => {
    // A two-part key is two join conditions and therefore two decisions. Collapsing them
    // into one control is how a composite key silently loses half of itself.
    const pairs = initialPairs(
      [
        member("order_id", { isPrimaryKey: true }),
        member("line_num", { isPrimaryKey: true, type: "INT64" }),
      ],
      [member("order_id"), member("quantity")],
    );

    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ parent: "order_id", child: "order_id", creating: false });
    // Second part has no match, so it defaults to being created rather than being dropped.
    expect(pairs[1]).toEqual({ parent: "line_num", child: "line_num", creating: true });
  });

  it("returns nothing when the parent has no key", () => {
    // The dialog blocks on this separately; the pairing simply has nothing to work from.
    expect(initialPairs([], [member("anything")])).toEqual([]);
  });

  it("does not reuse one child column for two key parts", () => {
    // Both parts match different columns; if the matcher ever returned the same column
    // twice the resulting foreign key would be nonsense, and the dialog's duplicate check
    // depends on distinct defaults to stay quiet on the happy path.
    const pairs = initialPairs(
      [member("a", { isPrimaryKey: true }), member("b", { isPrimaryKey: true })],
      [member("a"), member("b")],
    );

    expect(pairs.map((pair) => pair.child)).toEqual(["a", "b"]);
    expect(new Set(pairs.map((pair) => pair.child)).size).toBe(2);
  });
});
