import type { JSX, ReactNode } from "react";
import { Icon, type IconName } from "../ui";
import { linkProps, type Route, type Router } from "./routes";
import { useWorkspace } from "./WorkspaceContext";

/**
 * Primary navigation.
 *
 * This replaces the icon rail *and* the sliding panel it opened. Those were two
 * mechanisms for one job: the rail chose a destination, the panel showed it, and the
 * canvas resized every time you looked something up. Clicking the active rail item closed
 * the panel, so the sidebar's width was a mode you had to manage while working.
 *
 * One always-present sidebar with real destinations is simpler in every way that matters:
 * the width never changes, every item is a link with a URL you can share, and nothing has
 * to be dismissed to get back to the diagram, because the diagram never moved.
 *
 * **Every item here is a destination, and none of them is a set.** This used to hold a tree
 * of every model in the workspace, nested domain → tier. That reads fine with four models
 * and fails completely at the scale the tool is for: three hundred models do not navigate
 * from a 248px column, and collapsing branches only hides the problem. A set that large
 * needs search, filters and sort, which is a page, so `Models` is one line here and the
 * set lives on the page behind it.
 *
 * **And every item here is somewhere you go, not something you do.** A `Review` section once
 * held Problems, Changes, Compare and Generated output. Three of those were views of a single
 * model that had been promoted to global pages because there was nowhere else to put them,
 * and two were already reachable from the status bar, so the sidebar was offering a second
 * door to rooms that already had one. Output is a tab on the model it belongs to, Compare is
 * an action on a model because it needs two of them, and Problems and Changes keep the status
 * bar entries they always had.
 */

export function Sidebar({
  router,
  collapsed,
  onToggleCollapsed,
}: {
  router: Router;
  /** Icons only, at 48px. Owned by the shell so a view can request it. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}): JSX.Element {
  const { workspace, isAdmin, can } = useWorkspace();
  const { route } = router;

  const modelCount = workspace?.models.length ?? 0;

  return (
    <nav className={`nav${collapsed ? " nav--collapsed" : ""}`} aria-label="Main">
      <div className="nav__scroll">
        <NavItem
          router={router}
          route={{ name: "overview" }}
          icon="grid"
          label="Overview"
          on={route.name === "overview"}
        />

        {/*
          One destination, not the whole set.

          This was a tree nesting domain → tier, listing every model in the workspace. That
          reads fine with four and fails at the scale the tool is for, three hundred models
          do not navigate from a 248px column, and collapsing does not save it. The set
          lives on the Models page, which has the search, filters and sort a list that size
          needs. The sidebar holds destinations; this is one.
        */}
        <NavItem
          router={router}
          route={{ name: "models" }}
          icon="layers"
          label="Models"
          on={route.name === "models" || route.name === "model"}
          meta={modelCount > 0 ? <span className="muted small">{modelCount}</span> : null}
        />

        {/*
          Integrations is a destination, not a setting.

          It sits here rather than under Settings because it is about where the model *goes*, the wiki, the channel, the ticket, which is a thing a team looks at and changes, not a
          preference someone sets once and forgets.
        */}
        {/*
          Hidden when the deployment does not permit integrations at all.

          Not disabled, hidden. A disabled control is the right answer when *you* lack a
          permission somebody else has, because it tells you the feature exists and who to ask.
          A feature the deployment has switched off does not exist here for anyone, and showing a
          permanently dead item just costs a click to find that out.
        */}
        {can.integrations ? (
          <NavItem
            router={router}
            route={{ name: "integrations" }}
            icon="flow"
            label="Integrations"
            on={route.name === "integrations"}
          />
        ) : null}

        {/*
          Skills sits beside Integrations for the same reason: both are about what happens
          *around* a change rather than how a model is drawn. Skills gate the proposal on the way
          out; integrations announce it once it lands.
        */}
        {/*
          Two conditions, and they are not the same condition.

          Hidden when the *deployment* does not permit skills, because then the page cannot load
          anything and clicking it produced a red error saying the feature was not enabled. That is
          the dead tab this capability map exists to prevent, and it shipped to the demo.

          Still shown when the feature is on but no model provider key is configured. `check`
          skills are deterministic and run without a key, so hiding the page then would hide the
          rules that *are* running. Only `agent` skills need the key, and they report themselves
          as skipped, which is the honest answer.
        */}
        {can.skills ? (
          <NavItem
            router={router}
            route={{ name: "skills" }}
            icon="shield"
            label="Skills"
            on={route.name === "skills"}
          />
        ) : null}
      </div>

      <div className="nav__foot">
        <NavItem
          router={router}
          route={{ name: "settings", section: isAdmin ? "general" : "appearance" }}
          icon="settings"
          label="Settings"
          on={route.name === "settings"}
        />

        <button
          type="button"
          className="nav__collapse"
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
          <span>Collapse</span>
        </button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- item

function NavItem({
  router,
  route,
  icon,
  label,
  on,
  meta,
}: {
  router: Router;
  route: Route;
  icon?: IconName;
  label: string;
  on: boolean;
  meta?: ReactNode;
}): JSX.Element {
  return (
    <a
      className={`nav__item${on ? " nav__item--on" : ""}`}
      {...(on ? { "aria-current": "page" as const } : {})}
      {...linkProps(router, route)}
    >
      {icon ? <Icon name={icon} size={14} className="nav__item__icon" /> : null}
      <span className="nav__item__label">{label}</span>
      {meta ? <span className="nav__item__meta">{meta}</span> : null}
    </a>
  );
}

