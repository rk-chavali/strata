import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Callout, Icon, Input, Logo } from "../ui";
import type { CloudRepo, CloudState } from "../types";

/**
 * The way in, on a hosted instance.
 *
 * Two steps behind one layout. Signing in and choosing where to work are different decisions, and
 * somebody with forty repositories needs to search rather than scroll a dropdown bolted onto a
 * sign-in button, so they get separate panels rather than one growing form.
 *
 * **The stage on the left is not decoration.** A self-hoster reaching the password screen has
 * already read the documentation and run a container: they are sold, and a bare form is the right
 * amount of ceremony. Somebody arriving here has done none of that. This is the product's first
 * impression and possibly its only one, so it answers "what is this" before asking "who are you",
 * and it answers with the thing that is actually unusual: the diagram and the file are one object.
 */

export function CloudPage({
  cloud,
  onChanged,
}: {
  cloud: CloudState;
  onChanged: () => void;
}): JSX.Element {
  return (
    <div className="cloud">
      <Stage />
      <div className="cloud__panel">
        <div className="cloud__panel-inner">
          {cloud.user ? <RepoPicker user={cloud.user} onChanged={onChanged} /> : <SignIn />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stage

function Stage(): JSX.Element {
  return (
    <div className="cloud__stage">
      <span className="cloud__eyebrow">
        <Logo size={12} />
        strata cloud
      </span>

      <h2 className="cloud__headline">
        Your data model is a <em>git repository</em>.
      </h2>

      <p className="cloud__lede">
        Draw it as a diagram, review it as a pull request. One object seen twice, with no export
        step in between and no copy of your schema living anywhere you cannot see.
      </p>

      <Figure />

      <ul className="cloud__proof">
        <li>
          <Icon name="branch" size={16} />
          <span>
            <strong>Your repository is the workspace.</strong> Models stay where they already are.
            We keep a working copy for the editor to read, and it can be thrown away at any time.
          </span>
        </li>
        <li>
          <Icon name="users" size={16} />
          <span>
            <strong>Access is repository access.</strong> Add a colleague in GitHub and they can
            sign in. No invitations to chase and no second list of people to keep current.
          </span>
        </li>
        <li>
          <Icon name="shield" size={16} />
          <span>
            <strong>Read, write and admin carry over.</strong> Your permission on the repository is
            your permission here, so removing access in one place removes it in both.
          </span>
        </li>
      </ul>
    </div>
  );
}

/**
 * One table, drawn and written.
 *
 * The figure the marketing site leads with, redrawn against the application's own tokens so both
 * themes work with no second palette to maintain. The connector moves because a static dashed line
 * says the two halves correspond, while a moving one shows which way the correspondence runs, and
 * the direction is the part people miss.
 */
function Figure(): JSX.Element {
  return (
    <svg
      className="cloud__figure"
      viewBox="0 0 320 126"
      role="img"
      aria-label="A customer table shown as a diagram beside the YAML file it is stored in"
    >
      <text className="cf-label" x="4" y="8">
        Diagram
      </text>
      <text className="cf-label" x="192" y="8">
        customer.yaml
      </text>

      {/* The table as it appears on the canvas. */}
      <rect className="cf-card" x="4" y="16" width="120" height="94" rx="4" />
      <path className="cf-head" d="M4 20a4 4 0 0 1 4-4h112a4 4 0 0 1 4 4v11H4z" />
      <text className="cf-title" x="12" y="27">
        customer
      </text>
      <line className="cf-rule" x1="4" y1="31" x2="124" y2="31" />

      <text className="cf-row" x="12" y="44">
        <tspan className="cf-key">PK</tspan>
        <tspan dx="5">customer_id</tspan>
      </text>
      <line className="cf-rule" x1="4" y1="50" x2="124" y2="50" />

      <text className="cf-row" x="12" y="63">
        email
      </text>
      <line className="cf-rule" x1="4" y1="69" x2="124" y2="69" />

      <text className="cf-row" x="12" y="82">
        created_at
      </text>
      <line className="cf-rule" x1="4" y1="88" x2="124" y2="88" />

      <text className="cf-row" x="12" y="101">
        loyalty_tier
      </text>

      {/* Neither drives the other. They are the same file. */}
      <path className="cf-link" d="M124 63h68" />

      {/* The file on disk. */}
      <rect className="cf-card" x="192" y="16" width="124" height="94" rx="4" />
      <text className="cf-code" x="200" y="29">
        <tspan className="cf-code-key">kind:</tspan>
        <tspan dx="4">table</tspan>
      </text>
      <text className="cf-code" x="200" y="41">
        <tspan className="cf-code-key">name:</tspan>
        <tspan dx="4">customer</tspan>
      </text>
      <text className="cf-code" x="200" y="53">
        <tspan className="cf-code-key">columns:</tspan>
      </text>
      <text className="cf-code" x="206" y="65">
        - name: customer_id
      </text>
      <text className="cf-code" x="212" y="75">
        type: STRING
      </text>
      <text className="cf-code" x="212" y="85">
        primaryKey: true
      </text>
      <text className="cf-code" x="206" y="97">
        - name: email
      </text>
      <text className="cf-code" x="212" y="107">
        type: STRING
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- sign in

function Brand(): JSX.Element {
  return (
    <div className="cloud__brand">
      <span className="brand__mark" style={{ width: 26, height: 26 }}>
        <Logo size={20} />
      </span>
      <span>strata</span>
    </div>
  );
}

function SignIn(): JSX.Element {
  return (
    <>
      <Brand />
      <h1>Sign in</h1>
      <p className="cloud__sub">
        Continue with the account that already holds your models. Nothing is created until you pick
        a repository.
      </p>

      {/*
        A link, not a button with a fetch. Signing in is a redirect out to GitHub and back, so the
        browser has to navigate. Doing it with fetch would follow the redirect in the background
        and land the consent screen inside a response body nobody ever sees.

        `branch` rather than a GitHub mark, because every icon in this set is stroke-only on a 16px
        grid with no fill. The brand logo is a filled shape and would be the one exception in the
        whole set. The label already names the provider.
      */}
      <a className="btn btn--primary btn--lg btn--block" href="/api/cloud/login">
        <Icon name="branch" size={16} />
        Continue with GitHub
      </a>

      <div className="cloud__note">
        <p>
          strata asks for repository access so it can read your models and raise pull requests for
          your changes.
        </p>
        <p>
          Using GitHub Enterprise? It works the same way. Prefer to keep everything on your own
          infrastructure? Self-hosting is the same product.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- repositories

function RepoPicker({
  user,
  onChanged,
}: {
  user: NonNullable<CloudState["user"]>;
  onChanged: () => void;
}): JSX.Element {
  const [repos, setRepos] = useState<CloudRepo[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  const [opening, setOpening] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    api
      .cloudRepos()
      .then((result) => {
        if (live) setRepos(result.repos);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return repos ?? [];
    return (repos ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [repos, filter]);

  async function choose(repo: CloudRepo): Promise<void> {
    setError(undefined);
    setOpening(repo.fullName);
    try {
      await api.cloudChoose(repo.fullName);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setOpening(undefined);
    }
  }

  return (
    <>
      <Brand />
      <h1>Choose a workspace</h1>
      <p className="cloud__sub">
        Signed in as <strong>{user.login}</strong>. Pick the repository holding your models.
      </p>

      {repos && repos.length > 8 ? (
        <Input
          autoFocus
          placeholder="Filter repositories"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      ) : null}

      {error ? <Callout tone="err">{error}</Callout> : null}

      {!repos && !error ? <p className="muted">Reading your repositories…</p> : null}

      {repos && repos.length === 0 ? (
        <Callout tone="warn">
          No repositories you can write to. A repository you can only read cannot receive a model
          change, so there would be nothing to save into. Ask for write access, or create a
          repository for your models first.
        </Callout>
      ) : null}

      {repos && repos.length > 0 && shown.length === 0 ? (
        <p className="muted">Nothing matches “{filter}”.</p>
      ) : null}

      <div className="cloud__repos">
        {shown.map((repo) => (
          <button
            key={repo.fullName}
            type="button"
            className="cloud__repo"
            disabled={Boolean(opening)}
            onClick={() => void choose(repo)}
          >
            <span className="cloud__repo-name">
              <Icon name={repo.private ? "lock" : "folder"} size={14} />
              <span>{repo.fullName}</span>
            </span>
            <span className="cloud__repo-role">
              {opening === repo.fullName ? "opening" : repo.role}
            </span>
          </button>
        ))}
      </div>

      <div className="cloud__note">
        <p>
          A repository is cloned the first time it is opened, which takes a moment. After that it is
          already here.
        </p>
        <p>
          <button
            type="button"
            className="cloud__signout"
            onClick={() => void api.cloudLogout().then(onChanged)}
          >
            Sign out
          </button>
        </p>
      </div>
    </>
  );
}
