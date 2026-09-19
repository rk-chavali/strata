import { useRef, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Badge, Button, Icon, IconButton, Logo, Menu, useDismiss } from "../ui";
import { linkProps, type Router } from "./routes";
import { useWorkspace } from "./WorkspaceContext";
import type { ModelView, Peer } from "../types";

/**
 * The one persistent bar.
 *
 * What survived the redesign, and why each thing earns its place in 48px:
 *
 *   - **Brand**, goes home, as a logo does everywhere else.
 *   - **Workspace name**, which repo am I editing. Non-obvious and consequential when
 *     someone runs one instance per environment.
 *   - **⌘K**, the primary way to get anywhere. Centred, because it is the main event.
 *   - **Propose**, the action that ends every session of work. Everything else is a
 *     step towards it.
 *   - **Presence**, who else is in here right now.
 *   - **Account**, identity, theme, sign out.
 *
 * What left: the model picker and tier switch (the sidebar tree does that, with URLs), the
 * Compare button (a sidebar destination), the New menu (belongs to the thing being added
 * to, the sidebar section and the page it creates into), and the search field (⌘K).
 */

interface Props {
  router: Router;
  peers: Peer[];
  connectionId: string | undefined;
  /** False while the event stream is retrying, so the peer list is known to be stale. */
  live: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onPropose: () => void;
}

export function TopBar({
  router,
  peers,
  connectionId,
  live,
  theme,
  onToggleTheme,
  onOpenPalette,
  onPropose,
}: Props): JSX.Element {
  const { workspace, git, canEdit, can } = useWorkspace();
  const changeCount = git?.files.length ?? 0;

  return (
    <header className="topbar">
      <a className="brand" {...linkProps(router, { name: "overview" })}>
        <span className="brand__mark">
          <Logo size={17} />
        </span>
        <span>strata</span>
      </a>

      <div className="divider-v" />

      <span className="wslabel" title={workspace?.root}>
        <Icon name="folder" size={14} className="muted" />
        <span className="wslabel__name truncate">{workspace?.name ?? "Workspace"}</span>
      </span>

      <button type="button" className="omni" onClick={onOpenPalette}>
        <Icon name="search" size={14} />
        <span className="omni__text">Search models, objects and commands</span>
        <kbd>{modifierKey()}K</kbd>
      </button>

      {/*
        Propose is the only action in the bar, and it carries its own count so the size of
        what you are about to send is visible before you open the dialog.

        Hidden entirely when the workspace is not a git repository. Proposing is branch, commit,
        push, pull request, and none of those exist without one -- so the button could only ever
        have produced an error. A trial workspace and a plain directory both land here, and both
        are legitimate states rather than broken ones.
      */}
      {can.git ? (
        <Button
          icon="pr"
          variant={changeCount > 0 ? "primary" : "default"}
          disabled={!canEdit || changeCount === 0}
          title={
            changeCount === 0
              ? "Nothing has changed yet"
              : can.remote
                ? `Propose ${changeCount} changed file(s) as a pull request`
                : `Commit ${changeCount} changed file(s). No remote is configured, so nothing is pushed.`
          }
          onClick={onPropose}
        >
          Propose{changeCount > 0 ? ` · ${changeCount}` : ""}
        </Button>
      ) : null}

      <PeerStack peers={peers} connectionId={connectionId} live={live} />

      <AccountMenu router={router} theme={theme} onToggleTheme={onToggleTheme} />
    </header>
  );
}

/** ⌘ on a Mac, Ctrl elsewhere. Showing the wrong one makes the hint useless. */
export function modifierKey(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";
}

/**
 * Who else is in here right now.
 *
 * Collapsed by person, not by connection: two tabs open is not two colleagues, and showing
 * the same initial twice would read as a bug.
 */
function PeerStack({
  peers,
  connectionId,
  live,
}: {
  peers: Peer[];
  connectionId: string | undefined;
  live: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const others = new Map<string, Peer[]>();
  for (const peer of peers) {
    if (peer.connectionId === connectionId) continue;
    const existing = others.get(peer.userId);
    if (existing) existing.push(peer);
    else others.set(peer.userId, [peer]);
  }

  if (others.size === 0) return null;

  const people = [...others.values()];
  const shown = people.slice(0, 3);

  return (
    <div ref={ref} className="peers">
      <button
        type="button"
        className={`peers__stack${live ? "" : " peers__stack--stale"}`}
        aria-label={`${others.size} other people in this workspace`}
        title={
          live
            ? `${others.size} other person(s) here`
            : "Reconnecting, this list may be out of date"
        }
        onClick={() => setOpen((value) => !value)}
      >
        {shown.map((sessions) => {
          const peer = sessions[0];
          if (!peer) return null;
          return (
            <span
              key={peer.userId}
              className="peers__dot"
              style={{ background: colorFor(peer.userId) }}
            >
              {(peer.displayName || peer.username).slice(0, 1).toUpperCase()}
            </span>
          );
        })}
        {people.length > shown.length ? (
          <span className="peers__dot peers__dot--more">+{people.length - shown.length}</span>
        ) : null}
      </button>

      {open ? (
        <Menu
          align="right"
          width={260}
          onClose={() => setOpen(false)}
          entries={[
            { heading: "Also in this workspace" },
            ...people.map((sessions) => {
              const peer = sessions[0];
              const where = [...new Set(sessions.map((session) => session.model).filter(Boolean))];
              return {
                label: `${peer?.displayName ?? "Someone"}${
                  sessions.length > 1 ? ` · ${sessions.length} tabs` : ""
                }`,
                meta: where.join(", ") || "browsing",
              };
            }),
            ...(live ? [] : [{ heading: "Reconnecting…" }]),
          ]}
        />
      ) : null}
    </div>
  );
}

/**
 * A stable colour per person.
 *
 * Hashed from the user id rather than assigned by list position, so someone does not
 * change colour when a colleague closes their tab.
 */
function colorFor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
  }
  return `hsl(${hash % 360} 62% 42%)`;
}

function AccountMenu({
  router,
  theme,
  onToggleTheme,
}: {
  router: Router;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}): JSX.Element {
  const { auth, user, isAdmin, reloadAuth, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  // Auth off is a deployment state worth surfacing permanently: anyone who can reach the
  // port can edit, and that should never be a surprise.
  if (auth && !auth.authEnabled) {
    return (
      <div ref={ref} style={{ position: "relative", flex: "none" }}>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-label="Settings">
          <Badge tone="warn" icon="warn">
            auth off
          </Badge>
        </button>
        {open ? (
          <Menu
            align="right"
            onClose={() => setOpen(false)}
            entries={[
              { heading: "Authentication is disabled" },
              {
                label: theme === "dark" ? "Light theme" : "Dark theme",
                icon: theme === "dark" ? "sun" : "moon",
                onSelect: onToggleTheme,
              },
              {
                label: "Settings",
                icon: "settings",
                onSelect: () => router.go({ name: "settings", section: "general" }),
              },
            ]}
          />
        ) : null}
      </div>
    );
  }

  const initials = (user?.displayName ?? user?.username ?? "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <button
        type="button"
        className="avatar"
        aria-label={`Account: ${user?.displayName ?? "signed in"}`}
        title={user?.username}
        onClick={() => setOpen((value) => !value)}
      >
        {initials}
      </button>

      {open ? (
        <Menu
          align="right"
          width={220}
          onClose={() => setOpen(false)}
          entries={[
            { heading: `${user?.displayName ?? ""} · ${user?.role ?? ""}` },
            {
              label: theme === "dark" ? "Light theme" : "Dark theme",
              icon: theme === "dark" ? "sun" : "moon",
              onSelect: onToggleTheme,
            },
            {
              label: "Settings",
              icon: "settings",
              onSelect: () => router.go({ name: "settings", section: "appearance" }),
            },
            ...(isAdmin
              ? [
                  {
                    label: "Users",
                    icon: "users" as const,
                    onSelect: () => router.go({ name: "settings", section: "users" }),
                  },
                ]
              : []),
            {},
            {
              label: "Sign out",
              icon: "signout",
              onSelect: () => {
                void api.logout().then(() => {
                  void reloadAuth();
                  refresh();
                });
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}

/** Exported for the status bar, which shows the same tier colour. */
export function tierDot(model: ModelView | undefined): JSX.Element | null {
  return model ? <span className={`dot dot--${model.tier}`} /> : null;
}

/** Kept out of the bar itself so the theme toggle can be reused in Settings → Appearance. */
export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "light" | "dark";
  onToggle: () => void;
}): JSX.Element {
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={onToggle}
    />
  );
}
