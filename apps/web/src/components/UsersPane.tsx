import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { useFeedback } from "../ui";
import type { PublicInvite, PublicUser, Role } from "../types";

/**
 * User management.
 *
 * Roles are ordered, viewer reads, editor writes model files, admin also changes
 * settings and accounts. The server enforces this; the UI merely disables what it
 * knows will be refused, because a disabled button is a better explanation than a 403.
 */

const ROLE_HELP: Record<Role, string> = {
  viewer: "Read models and diagrams. Cannot change anything.",
  editor: "Edit models, move boxes, and propose pull requests.",
  admin: "Everything an editor can do, plus settings, file layout and accounts.",
};

export function UsersPane({ currentUser }: { currentUser: PublicUser | null }): JSX.Element {
  const ui = useFeedback();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [roles, setRoles] = useState<Role[]>(["viewer", "editor", "admin"]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.listUsers();
      setUsers(result.items);
      setRoles(result.roles);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="settings__section">
        <h3 className="settings__heading">Accounts</h3>
        <p className="settings__desc">
          Local accounts. For a real rollout the right answer is SSO against your own identity
          provider, that is not built yet, and these roles are the layer it would slot into.
        </p>

        {error ? <div className="callout callout--err">{error}</div> : null}

        <table className="dtable">
          <thead>
            <tr>
              <th>User</th>
              <th style={{ width: 120 }}>Role</th>
              <th style={{ width: 120 }}>Last signed in</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUser?.id;
              return (
                <tr key={user.id}>
                  <td>
                    <div>
                      {user.displayName}
                      {isSelf ? <span className="badge badge--role"> you</span> : null}
                      {user.disabled ? <span className="chip chip--warn"> disabled</span> : null}
                    </div>
                    <div className="mono muted">{user.username}</div>
                  </td>
                  <td>
                    <select
                      className="input"
                      disabled={busy}
                      value={user.role}
                      title={ROLE_HELP[user.role]}
                      onChange={(event) =>
                        void act(() => api.updateUser(user.id, { role: event.target.value as Role }))
                      }
                    >
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="muted small">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "never"}
                  </td>
                  <td>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={busy}
                        onClick={async () => {
                          const next = await ui.prompt({
                            title: `Reset password for ${user.username}`,
                            label: "New password",
                            confirmLabel: "Set password",
                            validate: (value) =>
                              value.length < 8 ? "passwords must be at least 8 characters" : undefined,
                          });
                          if (next) void act(() => api.updateUser(user.id, { password: next }));
                        }}
                      >
                        Reset password
                      </button>
                      {!isSelf ? (
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await ui.confirm({
                              title: `Delete ${user.username}?`,
                              message: "This account will lose access immediately.",
                              confirmLabel: "Delete",
                              danger: true,
                            });
                            if (ok) void act(() => api.deleteUser(user.id));
                          }}
                        >
                          Delete
                        </button>
                      ) : (
                        <span className="muted small">
                          Close your own account below
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {!adding ? (
          <div className="row" style={{ marginTop: "var(--s5)" }}>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              Add user
            </button>
          </div>
        ) : (
          <AddUserForm
            roles={roles}
            busy={busy}
            onCancel={() => setAdding(false)}
            onCreate={(body) =>
              void act(async () => {
                await api.createUser(body);
                setAdding(false);
              })
            }
          />
        )}
      </section>

      <InvitesSection roles={roles} />

      <section className="settings__section">
        <h3 className="settings__heading">Roles</h3>
        <table className="dtable">
          <tbody>
            {roles.map((role) => (
              <tr key={role}>
                <td style={{ width: 90 }}>
                  <span className="badge badge--role">{role}</span>
                </td>
                <td className="muted">{ROLE_HELP[role]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ChangeOwnPassword />
      <CloseMyAccount currentUser={currentUser} />
    </>
  );
}

/**
 * Closing your own account.
 *
 * The administrator table above deliberately has no Delete on your own row, because an
 * administrator removing themselves mid-session from a list of other people is a different
 * action with a different blast radius. This is that action, stated as its own thing.
 *
 * The username has to be typed. A confirmation dialog is the thing people click through without
 * reading, and this one cannot be undone from inside the product.
 */
function CloseMyAccount({ currentUser }: { currentUser: PublicUser | null }): JSX.Element | null {
  const ui = useFeedback();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Auth off: there is no account to close, so the section would be an empty threat.
  if (!currentUser) return null;

  const matches = typed.trim().toLowerCase() === currentUser.username.toLowerCase();

  async function close(): Promise<void> {
    if (!currentUser) return;

    const ok = await ui.confirm({
      title: "Close your account?",
      message:
        "You will be signed out immediately and lose access to this workspace. Your models are " +
        "not affected: they live in the git repository, and the commits you have already made " +
        "keep your name on them.",
      confirmLabel: "Close my account",
      danger: true,
    });
    if (!ok) return;

    setBusy(true);
    try {
      await api.closeMyAccount(currentUser.username);
      // A full reload rather than a state update: every provider above this point believes there
      // is a signed-in user, and the honest way back to the sign-in screen is to start over.
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="settings__section">
      <h3 className="settings__heading">Close your account</h3>
      <p className="muted small">
        Removes <strong>{currentUser.username}</strong> from this instance and signs you out. Your
        models are untouched: they are files in the git repository, not rows that belong to an
        account.
      </p>

      {error ? <p className="err-text small">{error}</p> : null}

      <div className="stack" style={{ marginTop: "var(--s5)" }}>
        <label className="field field--inline">
          <span className="field__label">Type your username</span>
          <input
            className="input"
            placeholder={currentUser.username}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <div className="row">
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy || !matches}
            onClick={() => void close()}
          >
            Close my account
          </button>
          {currentUser.role === "admin" ? (
            <span className="muted small">
              If you are the only administrator, this is refused rather than locking everyone out.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}



/**
 * Invitations.
 *
 * The reason to prefer these over adding a user directly: creating an account here means the
 * admin chooses the password, so the admin knows it, and it usually reaches the person over chat
 * in plain text. An invitation lets them set their own, which nobody else ever sees.
 *
 * No email is required, and that is deliberate. Insisting on a working mail server before anyone
 * can add a second user is one of the most common reasons a self-hosted install stalls. The link
 * is the invitation; send it however the team already talks.
 */
function InvitesSection({ roles }: { roles: Role[] }): JSX.Element {
  const ui = useFeedback();
  const [invites, setInvites] = useState<PublicInvite[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<Role>("editor");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  /** Undefined until asked. Decides whether the email field is worth offering at all. */
  const [mail, setMail] = useState<{ configured: boolean; from?: string } | undefined>();

  /*
    The link for the invitation just created, held only in this component's state.

    It cannot be fetched again: the server stores a hash and returns the token exactly once, so
    if this is dismissed before it is copied the only remedy is to revoke and issue another. The
    panel below says so, because otherwise the first person to close it will assume otherwise.
  */
  const [link, setLink] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setInvites((await api.listInvites()).items);
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Failing quietly is right: no mail configuration simply means the link is the only route,
    // which is the supported default rather than a degraded state.
    api.mailStatus().then(setMail).catch(() => setMail({ configured: false }));
  }, [load]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      await load();
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pending = invites.filter((invite) => invite.status === "pending");

  return (
    <section className="settings__section">
      <h3 className="settings__heading">Invitations</h3>
      <p className="muted small">
        {mail?.configured
          ? "Enter an email address and the invitation is sent for you. Leave it blank to copy the link and send it yourself. Either way, they choose their own password."
          : "Send someone a link and they choose their own password. Configure a mail server under Git and secrets to have invitations email themselves."}
      </p>

      {error ? <p className="err-text small">{error}</p> : null}

      {link ? (
        <div className="invite-link">
          <p>
            <strong>Copy this link now.</strong> It is shown once and cannot be retrieved later.
          </p>
          <div className="row">
            <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(link);
                ui.toast({ message: "Invitation link copied" });
              }}
            >
              Copy
            </button>
            <button type="button" className="btn" onClick={() => setLink(undefined)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <table className="dtable" style={{ marginTop: "var(--s5)" }}>
          <tbody>
            {pending.map((invite) => (
              <tr key={invite.id}>
                <td>{invite.username ?? <span className="muted">anyone with the link</span>}</td>
                <td style={{ width: 90 }}>
                  <span className="badge badge--role">{invite.role}</span>
                </td>
                <td className="muted small">
                  expires {new Date(invite.expiresAt).toLocaleDateString()}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void act(() => api.revokeInvite(invite.id))}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div className="row" style={{ marginTop: "var(--s5)" }}>
        {mail?.configured ? (
          <input
            className="input"
            type="email"
            placeholder="Email (optional)"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        ) : null}
        <input
          className="input"
          placeholder="Username (optional)"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <select
          className="input"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
        >
          {roles.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const created = await api.createInvite({
                role,
                ...(username.trim() ? { username: username.trim() } : {}),
                ...(email.trim() ? { email: email.trim() } : {}),
              });

              /*
                The link is shown even when the email went out.

                Sending is best effort: the invitation exists either way, and an admin who is told
                "sent" with no link has nothing to fall back on when it turns out the address was
                wrong or the message went to junk.
              */
              setLink(created.link);
              if (created.emailed) {
                ui.toast({ message: `Invitation emailed to ${email.trim()}`, tone: "success" });
              } else if (created.emailError) {
                ui.toast({
                  message: `Invitation created, but the email failed: ${created.emailError}`,
                  tone: "error",
                });
              }

              setUsername("");
              setEmail("");
            })
          }
        >
          Create invitation
        </button>
      </div>
    </section>
  );
}

function AddUserForm({
  roles,
  busy,
  onCancel,
  onCreate,
}: {
  roles: Role[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (body: { username: string; password: string; displayName: string; role: Role }) => void;
}): JSX.Element {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("editor");

  return (
    <div className="stack" style={{ marginTop: "var(--s5)" }}>
      <label className="field field--inline">
        <span className="field__label">Username</span>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field field--inline">
        <span className="field__label">Display name</span>
        <input
          className="input"
          value={displayName}
          placeholder="optional"
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <label className="field field--inline">
        <span className="field__label">Password</span>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="field field--inline">
        <span className="field__label">Role</span>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roles.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || username.trim().length === 0 || password.length < 8}
          onClick={() => onCreate({ username, password, displayName, role })}
        >
          Create
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        {password.length > 0 && password.length < 8 ? (
          <span className="muted small">passwords must be at least 8 characters</span>
        ) : null}
      </div>
    </div>
  );
}

function ChangeOwnPassword(): JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [status, setStatus] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setStatus({});
    try {
      await api.changePassword({ current, next });
      setStatus({ ok: "password changed" });
      setCurrent("");
      setNext("");
    } catch (err) {
      setStatus({ error: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings__section">
      <h3 className="settings__heading">Your password</h3>
      <div className="stack">
        <label className="field field--inline">
          <span className="field__label">Current</span>
          <input
            className="input"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field field--inline">
          <span className="field__label">New</span>
          <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <div className="row">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || current.length === 0 || next.length < 8}
            onClick={() => void submit()}
          >
            Change password
          </button>
          {status.error ? <span className="err-text small">{status.error}</span> : null}
          {status.ok ? <span className="muted small">{status.ok}</span> : null}
        </div>
      </div>
    </section>
  );
}
