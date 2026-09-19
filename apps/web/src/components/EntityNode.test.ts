import { describe, expect, it } from "vitest";
import { visibleMemberPaths } from "./EntityNode";
import type { MemberView } from "../types";

/**
 * Which member rows a box draws, per detail level.
 *
 * This is the rule an edge consults before anchoring to a column. It matters more than it
 * looks: React Flow cannot resolve a handle that is not mounted, and its response to an
 * edge naming one is to drop the edge without drawing anything. Get this wrong and
 * switching the detail level makes every relationship on the diagram vanish, which is
 * exactly what happened while this was being built, twice, for two different reasons.
 *
 * So the rule is pinned here rather than left as a shape the canvas and the node each
 * infer separately.
 */

function member(name: string, isPrimaryKey = false): MemberView {
  return {
    name,
    path: name,
    type: "STRING",
    required: false,
    isPrimaryKey,
    isForeignKey: false,
    depth: 0,
  };
}

const members = [
  member("id", true),
  member("tenant_id", true),
  member("name"),
  member("email"),
];

describe("visibleMemberPaths", () => {
  it("draws nothing at the Names level", () => {
    // Every edge must fall back to the box edge here.
    expect(visibleMemberPaths(members, "entityOnly").size).toBe(0);
  });

  it("draws only primary keys at the Keys level", () => {
    const visible = visibleMemberPaths(members, "keysOnly");

    expect([...visible].sort()).toEqual(["id", "tenant_id"]);
    // A foreign key that is not part of the primary key is not drawn, so an edge landing
    // on it has to fall back even though the level is called "Keys".
    expect(visible.has("email")).toBe(false);
  });

  it("draws every member at the Fields and Types levels", () => {
    for (const level of ["attributes", "attributesWithTypes"] as const) {
      const visible = visibleMemberPaths(members, level);
      expect([...visible].sort()).toEqual(["email", "id", "name", "tenant_id"]);
    }
  });

  it("caps the non-key rows, matching what the box actually renders", () => {
    // The box renders at most 16 non-key rows and collapses the rest into "+N more".
    // Those collapsed rows have no handle, so they must not appear here either.
    const wide = [
      member("id", true),
      ...Array.from({ length: 40 }, (_, i) => member(`col_${i}`)),
    ];

    const visible = visibleMemberPaths(wide, "attributes");

    expect(visible.size).toBe(17); // 1 key + 16 non-keys
    expect(visible.has("col_0")).toBe(true);
    expect(visible.has("col_15")).toBe(true);
    expect(visible.has("col_16")).toBe(false);
  });

  it("never caps keys, however many there are", () => {
    // A composite key wider than the cap still needs every part drawn, because each part
    // can carry its own relationship.
    const manyKeys = Array.from({ length: 20 }, (_, i) => member(`k_${i}`, true));

    const visible = visibleMemberPaths(manyKeys, "keysOnly");

    expect(visible.size).toBe(20);
  });

  it("handles a box with no members at all", () => {
    for (const level of ["entityOnly", "keysOnly", "attributes", "attributesWithTypes"] as const) {
      expect(visibleMemberPaths([], level).size).toBe(0);
    }
  });
});
