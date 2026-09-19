import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Button, Callout, Field, Input, Logo } from "../ui";
import { AuthVisual } from "./AuthPage";
import type { InviteCheck } from "../types";

/**
 * Redeeming an invitation.
 *
 * **The person setting the password is the person who will use it.** Creating an account
 * directly means the admin picks the password, so the admin knows it, it usually travels over
 * chat in plain text, and nothing ever forces a change. This screen exists to remove that.
 *
 * **The token comes from the fragment, not the path.** A fragment is never sent to a server, so
 * it stays out of our access logs, out of any reverse proxy in front, and out of the `Referer`
 * header. It is read here and sent in a request body, which `requestLogger` redacts.
 *
 * Rendered before the sign-in gate, because the whole point is that this visitor has no account.
 *
 * Shares the `auth` shell with signing in, because it is the second half of one journey: somebody
 * arrives here either from the link itself or from the switch on that screen, and having the
 * layout change underneath them mid-flow reads as landing on a different product.
 */

/** The shell, so every way in looks like the same way in. */
function Shell({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="auth">
      <div className="auth__form">
        <div className="auth__inner">
          <div className="auth__brand">
            <span className="brand__mark" style={{ width: 26, height: 26 }}>
              <Logo size={20} />
            </span>
            <span>strata</span>
          </div>
          {children}
        </div>
      </div>
      <AuthVisual />
    </div>
  );
}

export function InvitePage(): JSX.Element {
  const [token] = useState(() => window.location.hash.replace(/^#/, ""));
  const [invite, setInvite] = useState<InviteCheck | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setChecked(true);
      setError("This link is missing its invitation code. Check that you copied all of it.");
      return;
    }

    let live = true;
    api
      .inviteCheck(token)
      .then((result) => {
        if (!live) return;
        setInvite(result);
        setUsername(result.username ?? "");
        setDisplayName(result.displayName ?? "");
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (live) setChecked(true);
      });

    return () => {
      live = false;
    };
  }, [token]);

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
      await api.inviteAccept({
        token,
        username,
        password,
        ...(displayName ? { displayName } : {}),
      });
      /*
        A full reload rather than a state update.

        Accepting signs the person in, and every provider above this point read "signed out" when
        the app booted. Reloading is one line and leaves nothing stale; re-deriving the whole
        provider tree by hand would be several, and wrong in a way nobody would notice until a
        later screen showed the wrong role.

        The fragment is dropped on the way, which also takes the spent token out of the address
        bar and out of the browser history entry for the next page.
      */
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!checked) {
    return <div className="boot">Checking your invitation…</div>;
  }

  if (!invite) {
    return (
      <Shell>
        <div className="auth__mode">
          <h1 className="auth__title">That invitation did not work</h1>
          <p className="auth__sub">{error ?? "This invitation is no longer valid."}</p>

          <div className="auth__note">
            <p>
              Invitations work once and expire after seven days. If yours has been used or has run
              out, ask whoever sent it to issue another.
            </p>
            <p>
              Already have an account? <a href="/">Sign in</a>.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="auth__mode" onSubmit={(event) => void submit(event)}>
        <h1 className="auth__title">Create your account</h1>
        <p className="auth__sub">
          You have been invited as {article(invite.role)} <strong>{invite.role}</strong>. Choose a
          password and the account is yours.
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

          <Field
            label="Confirm password"
            {...(mismatch ? { error: "the passwords do not match" } : {})}
          >
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
              username.trim().length === 0 ||
              password.length === 0 ||
              Boolean(tooShort) ||
              Boolean(mismatch)
            }
          >
            Create my account
          </Button>
        </div>

        <div className="auth__note">
          <p>
            <strong>Nobody else sees this password.</strong> It is not sent to whoever invited you,
            and it is stored only as a hash that cannot be turned back into the password.
          </p>
          <p>This invitation expires {new Date(invite.expiresAt).toLocaleDateString()}.</p>
        </div>
      </form>
    </Shell>
  );
}

/** "an admin", "an editor", "a viewer". Small, but the alternative reads as a bug. */
function article(role: string): string {
  return /^[aeiou]/i.test(role) ? "an" : "a";
}
