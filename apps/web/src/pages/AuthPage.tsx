import { useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Button, Callout, Field, IconButton, Input, Logo } from "../ui";
import { useTheme } from "../app/theme";

/**
 * The way in, on a self-hosted instance.
 *
 * **Three modes, one screen.** From the visitor's side these are the same decision, "get me into
 * this instance", and they differ by a couple of fields. Three separate pages made the two rarer
 * ones unreachable: first-run setup vanished the moment an administrator existed, and somebody
 * holding an invitation link had nowhere to go if they navigated to the root instead of clicking
 * it.
 *
 * **There is deliberately no sign-up.** Strata has exactly three ways to get an account: the
 * first-run administrator, an administrator creating one, and an invitation. Open registration on
 * a tool that holds a company's data model would mean anyone who reaches the URL can let
 * themselves in, which is the hole the administrator seed exists to close. So the second mode is
 * the one that genuinely exists, redeeming an invitation, rather than a sign-up form that would
 * have to be refused.
 */

type Mode = "signin" | "invite";

export function AuthPage({
  needsSetup,
  onSignedIn,
}: {
  needsSetup: boolean;
  onSignedIn: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("signin");
  /*
    The theme is toggleable here, not only once you are inside.

    Before this, `data-theme` was set by the shell, which renders only after sign-in, so every way
    into the product was permanently light. Somebody who works in dark all day met a white screen
    and had no control over it.
  */
  const { theme, toggle } = useTheme();

  return (
    <div className="auth">
      <div className="auth__form">
        <div className="auth__inner">
          <div className="auth__brand">
            <span className="brand__mark" style={{ width: 26, height: 26 }}>
              <Logo size={20} />
            </span>
            <span>strata</span>
            <IconButton
              icon={theme === "dark" ? "sun" : "moon"}
              label={theme === "dark" ? "Switch to light" : "Switch to dark"}
              onClick={toggle}
            />
          </div>

          {needsSetup ? (
            <SetupMode onSignedIn={onSignedIn} />
          ) : mode === "signin" ? (
            <SignInMode onSignedIn={onSignedIn} onSwitch={() => setMode("invite")} />
          ) : (
            <InviteMode onSwitch={() => setMode("signin")} />
          )}
        </div>
      </div>

      <AuthVisual needsSetup={needsSetup} />
    </div>
  );
}

// ---------------------------------------------------------------- modes

function SetupMode({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);

    if (password !== confirm) {
      setError("the passwords do not match");
      return;
    }

    setBusy(true);
    try {
      await api.setup({ username, password, displayName: displayName || username });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="auth__mode" onSubmit={(event) => void submit(event)}>
      <h1 className="auth__title">Set up this instance</h1>
      <p className="auth__sub">
        Nobody has an account here yet, so the first one is yours and it is an administrator.
      </p>

      <div className="stack">
        <Field label="Username">
          {(props) => (
            <Input
              {...props}
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label="Display name" optional hint="Shown on pull requests you propose.">
          {(props) => (
            <Input
              {...props}
              value={displayName}
              placeholder={username || "your name"}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Password"
          {...(tooShort ? { error: "at least 8 characters" } : { hint: "At least 8 characters." })}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        <Field label="Confirm password" {...(mismatch ? { error: "the passwords do not match" } : {})}>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
        </Field>

        {error ? <Callout tone="err">{error}</Callout> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={busy}
          disabled={
            username.trim().length === 0 || password.length === 0 || tooShort || mismatch
          }
        >
          Create administrator
        </Button>
      </div>

      <div className="auth__note">
        <p>
          Accounts live outside the model repository, so password hashes are never committed to the
          repository this tool versions.
        </p>
      </div>
    </form>
  );
}

function SignInMode({
  onSignedIn,
  onSwitch,
}: {
  onSignedIn: () => void;
  onSwitch: () => void;
}): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api.login({ username, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="auth__mode" onSubmit={(event) => void submit(event)}>
      <h1 className="auth__title">Welcome back</h1>
      <p className="auth__sub">Sign in to continue to your model workspace.</p>

      <div className="stack">
        <Field label="Username">
          {(props) => (
            <Input
              {...props}
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        {error ? <Callout tone="err">{error}</Callout> : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={busy}
          disabled={username.trim().length === 0 || password.length === 0}
        >
          Sign in
        </Button>
      </div>

      <p className="auth__switch">
        Been invited?{" "}
        <button type="button" onClick={onSwitch}>
          Redeem your link
        </button>
      </p>
    </form>
  );
}

/**
 * Redeeming an invitation from the root, for somebody who did not click the link.
 *
 * The whole link is pasted rather than a code typed, because the token lives in the URL fragment
 * and there is no short code to read out. Anything with a `#` is accepted, so a link copied from
 * chat works whether or not the person trimmed it.
 */
function InviteMode({ onSwitch }: { onSwitch: () => void }): JSX.Element {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | undefined>();

  const token = link.includes("#") ? link.slice(link.lastIndexOf("#") + 1).trim() : "";

  function go(event: React.FormEvent): void {
    event.preventDefault();
    if (!token) {
      setError("that does not look like an invitation link. It should contain a # near the end.");
      return;
    }
    // Straight to the redemption screen, which is the same page the link itself opens.
    window.location.assign(`/invite#${token}`);
  }

  return (
    <form className="auth__mode" onSubmit={go}>
      <h1 className="auth__title">Redeem an invitation</h1>
      <p className="auth__sub">
        Paste the link you were sent. You will choose your own username and password on the next
        screen, and nobody else ever sees it.
      </p>

      <div className="stack">
        <Field label="Invitation link" hint="It looks like https://.../invite#...">
          {(props) => (
            <Input
              {...props}
              autoFocus
              value={link}
              placeholder="https://strata.example.com/invite#..."
              onChange={(event) => {
                setLink(event.target.value);
                setError(undefined);
              }}
            />
          )}
        </Field>

        {error ? <Callout tone="err">{error}</Callout> : null}

        <Button type="submit" variant="primary" size="lg" block disabled={!token}>
          Continue
        </Button>
      </div>

      <p className="auth__switch">
        Already have an account?{" "}
        <button type="button" onClick={onSwitch}>
          Sign in
        </button>
      </p>

      <div className="auth__note">
        <p>
          Invitations work once and expire after seven days. If yours has been used or run out, ask
          whoever sent it for another.
        </p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the visual

/**
 * Three tables across three tiers, drawing themselves.
 *
 * The product's own subject rather than an abstract pattern: a conceptual idea becomes a logical
 * entity becomes a physical table, which is the thing this tool exists to keep in step. The edges
 * move because the relationship between the tiers is the point, not the boxes.
 */
export function AuthVisual({ needsSetup = false }: { needsSetup?: boolean }): JSX.Element {
  return (
    <div className="auth__visual">
      <svg
        className="auth__art"
        viewBox="0 0 300 210"
        role="img"
        aria-label="One subject modelled across three tiers: a concept, the entity derived from it, and the BigQuery table derived from that."
      >
        <g className="a-in a-in-1">
          <text className="a-tier" x="18" y="14">CONCEPTUAL</text>
          <rect className="a-node" x="18" y="20" width="96" height="34" rx="4" />
          <path className="a-head" d="M18 24a4 4 0 0 1 4-4h88a4 4 0 0 1 4 4v10H18z" />
          <text className="a-title" x="26" y="31">Customer</text>
          <text className="a-row" x="26" y="46">a person who buys</text>
        </g>

        <path className="a-edge" d="M66 54 V78" />

        <g className="a-in a-in-2">
          <text className="a-tier" x="18" y="74">LOGICAL</text>
          <rect className="a-node" x="18" y="80" width="120" height="48" rx="4" />
          <path className="a-head" d="M18 84a4 4 0 0 1 4-4h112a4 4 0 0 1 4 4v10H18z" />
          <text className="a-title" x="26" y="91">customer</text>
          <circle className="a-dot" cx="28" cy="103" r="1.6" />
          <text className="a-row" x="34" y="105">customer_id</text>
          <line className="a-rule" x1="18" y1="109" x2="138" y2="109" />
          <text className="a-row" x="34" y="119">email_address</text>
        </g>

        <path className="a-edge" d="M78 128 V152" />

        <g className="a-in a-in-3">
          <text className="a-tier" x="18" y="148">PHYSICAL</text>
          <rect className="a-node" x="18" y="154" width="150" height="48" rx="4" />
          <path className="a-head" d="M18 158a4 4 0 0 1 4-4h142a4 4 0 0 1 4 4v10H18z" />
          <text className="a-title" x="26" y="165">dim_customer</text>
          <circle className="a-dot" cx="28" cy="177" r="1.6" />
          <text className="a-row" x="34" y="179">customer_id  STRING</text>
          <line className="a-rule" x1="18" y1="183" x2="168" y2="183" />
          <text className="a-row" x="34" y="193">created_at  TIMESTAMP</text>
        </g>
      </svg>

      <div className="auth__caption">
        <strong>
          {needsSetup ? "Your data model, in your git repo" : "One model, three tiers, one history"}
        </strong>
        <span>
          {needsSetup
            ? "Everything this instance stores is files in a repository you control. Nothing phones home."
            : "A change to a table is a commit your team reviews, not a silent edit to a database nobody can audit."}
        </span>
      </div>
    </div>
  );
}
