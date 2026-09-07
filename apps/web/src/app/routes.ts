import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The route model.
 *
 * Still hand-rolled on the History API rather than pulling in a router, the reasoning
 * from the original holds: there is no data loading, no code splitting and no deep
 * nesting to justify one. What changed is that routes are now a **discriminated union**
 * instead of a bag of booleans.
 *
 * The old shape was `{ home: boolean; compare: boolean; rail: RailTarget | undefined;
 * model: string | undefined }`, which made `{ home: true, compare: true }` and
 * `{ home: true, model: "retail" }` expressible but meaningless. Every consumer then had
 * to know the precedence rules to work out what was actually on screen, and `App.tsx`
 * carried `showStart` and `canvasHidden` derivations to paper over it.
 *
 * A union makes the illegal states unrepresentable and lets rendering be a single switch.
 *
 *   /                                the overview
 *   /models                          every model, grouped by domain
 *   /domains/:domain                 one business domain, its tags, owners and models
 *   /domains/:domain/pulls           that domain, the pull requests that changed it
 *   /models/:model                   a model, diagram of all its objects
 *   /models/:model/objects           a model, its objects as a table
 *   /models/:model/dictionary        a model, every field, editable, for docs and governance
 *   /models/:model/output            a model, the DDL and SQLX it generates
 *   /models/:model/history           a model, what changed, and in which pull request
 *   /models/:model/diagrams/:id      one saved diagram
 *   /problems  /changes  /compare  /output  /integrations  /skills  /governance
 *   /settings/:section
 *   /setup                           first-run wizard
 */

/**
 * The pages *about* one model.
 *
 * `history` is a sibling view rather than a panel inside the studio, for the same reason
 * Harness makes Execution History a tab beside Pipeline Studio: it is a full-width list with
 * its own scroll, and squeezing it beside a canvas would leave neither usable.
 */
/** The views of one domain, as sibling tabs. */
export type DomainTab = "overview" | "pulls";

export type ModelTab = "diagram" | "objects" | "dictionary" | "output" | "history";

export type Route =
  | { name: "overview" }
  | { name: "models" }
  /**
   * A business domain.
   *
   * Its own route rather than a filter on `/models`, because it is a *place*: it carries
   * the domain's tags, its owners and the models inside it, and the breadcrumb has to be
   * able to walk back up to it from a model. A query parameter cannot hold identity that
   * other pages link to.
   */
  | { name: "domain"; domain: string; tab: DomainTab }
  | { name: "model"; model: string; tab: ModelTab; diagram?: string }
  | { name: "problems" }
  | { name: "changes" }
  | { name: "compare" }
  | { name: "output" }
  | { name: "integrations" }
  | { name: "skills" }
  | { name: "governance" }
  | { name: "settings"; section: SettingsSection }
  | { name: "setup" };

/** Mirrors the panes in the settings UI, so a deep link names a real section. */
export const SETTINGS_SECTIONS = [
  "general",
  "conventions",
  "layout",
  "ddl",
  "lint",
  "git",
  "dataform",
  "users",
  "appearance",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where the brand and a failed lookup both land. */
export const HOME: Route = { name: "overview" };

// ---------------------------------------------------------------- parse

export function parseRoute(pathname: string): Route {
  // Trailing slashes are noise; `/models/` and `/models` must not be two routes.
  const path = pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third, fourth] = segments;

  if (!first) return HOME;

  switch (first) {
    case "models": {
      if (!second) return { name: "models" };
      // `/models/:model/diagrams/:id` and `/models/:model/objects` are the only
      // sub-routes; anything else falls back to the model's default view rather than
      // 404ing, because a stale bookmark should still land somewhere useful.
      if (third === "diagrams" && fourth) {
        return { name: "model", model: second, tab: "diagram", diagram: fourth };
      }
      if (third === "objects") return { name: "model", model: second, tab: "objects" };
      if (third === "dictionary") return { name: "model", model: second, tab: "dictionary" };
      if (third === "output") return { name: "model", model: second, tab: "output" };
      if (third === "history") return { name: "model", model: second, tab: "history" };
      return { name: "model", model: second, tab: "diagram" };
    }

    case "domains": {
      if (!second) return { name: "models" };
      if (third === "pulls") return { name: "domain", domain: second, tab: "pulls" };
      return { name: "domain", domain: second, tab: "overview" };
    }

    case "problems":
      return { name: "problems" };
    case "changes":
      return { name: "changes" };
    case "compare":
      return { name: "compare" };
    case "output":
      return { name: "output" };
    case "integrations":
      return { name: "integrations" };
    case "skills":
      return { name: "skills" };
    case "governance":
      return { name: "governance" };
    case "setup":
      return { name: "setup" };

    case "settings": {
      const section = SETTINGS_SECTIONS.find((candidate) => candidate === second);
      return { name: "settings", section: section ?? "general" };
    }

    default:
      // Unknown path: the overview, not a blank page. Someone who mistypes a URL should
      // land somewhere they can act from.
      return HOME;
  }
}

// ---------------------------------------------------------------- build

/**
 * The path for a route.
 *
 * Every navigation goes through this rather than through string literals, so a route's
 * shape is defined in exactly one place and renaming a segment is a single edit instead
 * of a grep.
 */
export function href(route: Route): string {
  const enc = encodeURIComponent;

  switch (route.name) {
    case "overview":
      return "/";
    case "models":
      return "/models";
    case "domain":
      return route.tab === "pulls"
        ? `/domains/${enc(route.domain)}/pulls`
        : `/domains/${enc(route.domain)}`;
    case "model": {
      const base = `/models/${enc(route.model)}`;
      if (route.diagram) return `${base}/diagrams/${enc(route.diagram)}`;
      if (route.tab === "objects") return `${base}/objects`;
      if (route.tab === "dictionary") return `${base}/dictionary`;
      if (route.tab === "output") return `${base}/output`;
      if (route.tab === "history") return `${base}/history`;
      return base;
    }
    case "problems":
      return "/problems";
    case "changes":
      return "/changes";
    case "compare":
      return "/compare";
    case "output":
      return "/output";
    case "integrations":
      return "/integrations";
    case "skills":
      return "/skills";
    case "governance":
      return "/governance";
    case "settings":
      return `/settings/${route.section}`;
    case "setup":
      return "/setup";
  }
}

/** The model a route is scoped to, if any. Drives sidebar highlighting and presence. */
export function modelOf(route: Route): string | undefined {
  return route.name === "model" ? route.model : undefined;
}

/**
 * Whether a route hands its whole content area to a canvas.
 *
 * The canvas manages its own scrolling and must fill the region exactly, so the page
 * scaffold has to switch off the padding and overflow it applies to everything else.
 */
export function isCanvasRoute(route: Route): boolean {
  return route.name === "model" && route.tab === "diagram";
}

// ---------------------------------------------------------------- hook

export interface Router {
  route: Route;
  /** Navigate to a route. `replace` for redirects the user did not ask for. */
  go: (route: Route, options?: { replace?: boolean }) => void;
  /** For `<a href>` on nav items, so middle-click and ⌘-click open a new tab. */
  href: (route: Route) => string;
}

export function useRouter(): Router {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  // The back and forward buttons change the URL without telling React.
  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((route: Route, options?: { replace?: boolean }) => {
    const path = href(route);
    if (path === window.location.pathname) return;
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", path);
    setPathname(path);
  }, []);

  const route = useMemo(() => parseRoute(pathname), [pathname]);

  return { route, go, href };
}

/**
 * An anchor that navigates in-app.
 *
 * Real `href`, so the status bar shows the target, ⌘-click opens a tab and the link is
 * announced as a link. The click handler only takes over for a plain left-click, * intercepting modified clicks is what makes single-page apps feel worse than documents.
 */
export function linkProps(
  router: Router,
  route: Route,
): { href: string; onClick: (event: React.MouseEvent) => void } {
  return {
    href: router.href(route),
    onClick: (event: React.MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      router.go(route);
    },
  };
}
