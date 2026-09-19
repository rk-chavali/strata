import { describe, expect, it } from "vitest";
import { HOME, SETTINGS_SECTIONS, href, isCanvasRoute, modelOf, parseRoute, type Route } from "./routes";

/**
 * The URL is the app's only durable state, so these are the rules everything else rests on.
 *
 * `href` and `parseRoute` are two halves of one mapping written in two switch statements, which
 * is the arrangement most likely to drift: adding a route means editing both, and forgetting one
 * produces a link that navigates somewhere else entirely rather than an error anybody notices.
 * The round trip below is the check that keeps them honest.
 *
 * The other property worth pinning is that no URL can crash the app. A bookmark outlives the
 * model it points at, people hand-edit addresses, and crawlers invent them; `parseRoute` says in
 * its own comments that anything unrecognised lands on the overview, and that promise is only
 * worth having if it holds for hostile input too.
 */

const routes: Route[] = [
  { name: "overview" },
  { name: "models" },
  { name: "model", model: "shop_warehouse", tab: "diagram" },
  { name: "model", model: "shop_warehouse", tab: "objects" },
  { name: "model", model: "shop_warehouse", tab: "dictionary" },
  { name: "model", model: "shop_warehouse", tab: "output" },
  { name: "model", model: "shop_warehouse", tab: "history" },
  { name: "model", model: "shop_warehouse", tab: "diagram", diagram: "dgm_shop_mart" },
  { name: "domain", domain: "Sales", tab: "overview" },
  { name: "domain", domain: "Sales", tab: "pulls" },
  { name: "problems" },
  { name: "changes" },
  { name: "compare" },
  { name: "output" },
  { name: "integrations" },
  { name: "skills" },
  { name: "governance" },
  { name: "setup" },
  ...SETTINGS_SECTIONS.map((section) => ({ name: "settings", section }) as Route),
];

describe("href and parseRoute round trip", () => {
  it.each(routes.map((route) => [href(route), route] as const))(
    "%s parses back to the route that built it",
    (_path, route) => {
      expect(parseRoute(href(route))).toEqual(route);
    },
  );

  it("covers every route name, so a new one cannot be added untested", () => {
    /*
      Without this, adding a route to the union and forgetting to list it above leaves the
      round trip passing while saying nothing about the new route.
    */
    const names = new Set(routes.map((route) => route.name));

    expect([...names].sort()).toEqual(
      [
        "changes", "compare", "domain", "governance", "integrations", "model", "models",
        "output", "overview", "problems", "settings", "setup", "skills",
      ].sort(),
    );
  });
});

describe("names that need encoding", () => {
  // Model names come from the user's files, so they are not guaranteed to be URL-safe.
  const awkward = ["a b", "a/b", "a%b", "a?b", "a#b", "üñïçø∂é", "a&b=c"];

  it.each(awkward)("round trips a model named %j", (model) => {
    expect(parseRoute(href({ name: "model", model, tab: "objects" }))).toEqual({
      name: "model",
      model,
      tab: "objects",
    });
  });

  it("keeps a slash in a name from inventing a path segment", () => {
    // The case that would silently reroute: an unencoded `/` turns one segment into two.
    expect(href({ name: "model", model: "a/b", tab: "diagram" })).toBe("/models/a%2Fb");
  });
});

describe("URLs nobody meant to type", () => {
  it("treats a trailing slash as the same route", () => {
    expect(parseRoute("/models/")).toEqual(parseRoute("/models"));
    expect(parseRoute("///")).toEqual(HOME);
  });

  it("falls back to the overview for an unknown path", () => {
    expect(parseRoute("/nonsense")).toEqual(HOME);
    expect(parseRoute("/")).toEqual(HOME);
  });

  it("falls back for an unknown settings section rather than rendering nothing", () => {
    expect(parseRoute("/settings/not-a-section")).toEqual({ name: "settings", section: "general" });
  });

  it("sends a stale model sub-route to the model rather than nowhere", () => {
    expect(parseRoute("/models/shop/was-a-tab-once")).toEqual({
      name: "model",
      model: "shop",
      tab: "diagram",
    });
  });

  it("does not throw on a malformed percent escape", () => {
    /*
      `decodeURIComponent("%")` throws `URIError`, and every segment used to go through it
      unguarded. A single stray `%` in the address bar therefore took down the whole app rather
      than landing on the overview, which is what the fallback in `parseRoute` promises and what
      every other unrecognised URL already did. Reached by a truncated paste or a bad link, and
      the user sees a blank screen with no way back.
    */
    expect(() => parseRoute("/%")).not.toThrow();
    expect(parseRoute("/%")).toEqual(HOME);
    expect(() => parseRoute("/models/%zz")).not.toThrow();
    expect(() => parseRoute("/%E0%A4%A")).not.toThrow();
  });
});

describe("route predicates", () => {
  it("names the model a route is scoped to, and nothing for the rest", () => {
    expect(modelOf({ name: "model", model: "shop", tab: "objects" })).toBe("shop");
    expect(modelOf({ name: "problems" })).toBeUndefined();
    expect(modelOf({ name: "domain", domain: "Sales", tab: "overview" })).toBeUndefined();
  });

  it("claims the full content area only for the diagram tab", () => {
    // The page scaffold switches off its own padding and overflow on the strength of this.
    expect(isCanvasRoute({ name: "model", model: "shop", tab: "diagram" })).toBe(true);
    expect(isCanvasRoute({ name: "model", model: "shop", tab: "objects" })).toBe(false);
    expect(isCanvasRoute({ name: "overview" })).toBe(false);
  });
});
