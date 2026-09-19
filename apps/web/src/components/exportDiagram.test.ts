import { describe, expect, it } from "vitest";
import { diagramToSvg } from "./exportDiagram";
import type { GraphView, MemberView, NodeView } from "../types";

/**
 * The exported SVG, and the fact that every name in it came from somebody's repository.
 *
 * This is the one place in the web app that builds markup by concatenating strings, and the
 * strings are object and column names read out of model files. Those files arrive by pull
 * request, so "a name is trusted input" is not true here: an entity called
 * `<script>…</script>` is a perfectly valid thing for a contributor to add, and the export is
 * a file the reviewer then opens in a browser, where an unescaped tag runs.
 *
 * The escaping was already right. These tests exist so it stays that way, because the failure
 * is invisible in review: the diagram looks correct either way, and a regression only shows up
 * in a file somebody opens later.
 *
 * One ordering matters as much as the escaping itself. Names are truncated to fit their box,
 * and truncation runs *before* escaping. Reversed, a cut could land in the middle of `&amp;`
 * and produce markup no SVG renderer will open.
 */

function member(name: string, type = "STRING"): MemberView {
  return {
    name,
    path: name,
    type,
    required: false,
    isPrimaryKey: false,
    isForeignKey: false,
    depth: 0,
  };
}

function node(name: string, members: MemberView[] = []): NodeView {
  return {
    id: `tbl_${name}`,
    name,
    kind: "table",
    members,
    x: 0,
    y: 0,
    positioned: true,
    width: 232,
    height: 100,
    userSized: false,
  };
}

function graph(nodes: NodeView[]): GraphView {
  return {
    model: { name: "shop", tier: "physical" } as GraphView["model"],
    nodes,
    edges: [],
    shapes: [],
    connectors: [],
  };
}

describe("diagramToSvg escapes what it draws", () => {
  it("never emits a raw script tag from an object name", () => {
    const svg = diagramToSvg(graph([node("<script>alert(1)</script>")]));

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("escapes a column name too, not just the box title", () => {
    const svg = diagramToSvg(graph([node("orders", [member("<img src=x onerror=1>")])]));

    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;img");
  });

  it("escapes the title the caller passes in", () => {
    const svg = diagramToSvg(graph([node("orders")]), { title: "<b>shop</b>" });

    expect(svg).not.toContain("<b>shop</b>");
    expect(svg).toContain("&lt;b&gt;shop&lt;/b&gt;");
  });

  it("escapes a column type, which is also read from the file", () => {
    const svg = diagramToSvg(graph([node("orders", [member("total", "<evil>")])]), { types: true });

    expect(svg).not.toContain("<evil>");
  });

  it("escapes an ampersand once, not twice", () => {
    /*
      Order inside `esc`: `&` has to be replaced before `<`, or the `&` of an already-written
      `&lt;` gets escaped again and the name renders as literal `&lt;` on the diagram.
    */
    const svg = diagramToSvg(graph([node("a&b")]));

    expect(svg).toContain("a&amp;b");
    expect(svg).not.toContain("a&amp;amp;b");
  });

  it("leaves no stray < or > outside of real tags", () => {
    // A cheap well-formedness proxy: every `<` should open a tag we generated.
    const svg = diagramToSvg(
      graph([node("a<b>c", [member("d>e"), member("f<g")])]),
      { title: "t<u" },
    );
    const outsideTags = svg.replace(/<\/?[a-zA-Z][^>]*>/g, "");

    expect(outsideTags).not.toContain("<");
    expect(outsideTags).not.toContain(">");
  });
});

describe("truncation runs before escaping", () => {
  it("does not cut an entity in half on a long name full of ampersands", () => {
    const svg = diagramToSvg(graph([node("&".repeat(80))]));

    // A severed entity leaves a bare `&` followed by something that is not a valid entity.
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#)/);
  });

  it("still truncates, so a long name cannot run outside its box", () => {
    const svg = diagramToSvg(graph([node("x".repeat(500))]));

    expect(svg).toContain("…");
    expect(svg).not.toContain("x".repeat(200));
  });
});

describe("the document it produces", () => {
  it("is a standalone svg element with dimensions", () => {
    const svg = diagramToSvg(graph([node("orders", [member("id")])]));

    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toMatch(/width="\d+"/);
    expect(svg).toMatch(/height="\d+"/);
  });

  it("draws an empty model without throwing", () => {
    // Reachable: a new model, or every object filtered out of the diagram.
    expect(() => diagramToSvg(graph([]))).not.toThrow();
  });

  it("omits column rows at the names detail level", () => {
    const withFields = diagramToSvg(graph([node("orders", [member("order_id")])]));
    const namesOnly = diagramToSvg(graph([node("orders", [member("order_id")])]), {
      detail: "names",
    });

    expect(withFields).toContain("order_id");
    expect(namesOnly).not.toContain("order_id");
  });
});
