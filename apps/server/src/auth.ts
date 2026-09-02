import { createHash, randomBytes, createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RequestHandler, Request, Response, NextFunction } from "express";
import type { RequestContext } from "./logging.js";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Authentication and roles.
 *
 * Two deliberate choices worth stating.
 *
 * **Credentials live outside the model repo.** Users and password hashes go in a
 * separate data directory, never in the workspace, committing password hashes to
 * the repo the tool exists to version would be an unforced error.
 *
 * **Sessions are stateless signed tokens, not a server-side session table.** A
 * self-hosted deployment gets restarted, redeployed and scaled, and losing everyone's
 * session on every restart is the kind of small indignity that makes a tool feel
 * unfinished.
 *
 * This is deliberately local-account auth. For a real enterprise rollout the right
 * answer is OIDC/SAML against the customer's IdP, plus SCIM provisioning; the role
 * model here is shaped so that slots in later, with the IdP supplying identity and
 * these roles staying the authorisation layer.
 */

export const ROLES = ["viewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Ascending privilege, so a check is a comparison rather than a lookup table. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  /** `scrypt$<saltHex>$<hashHex>` */
  passwordHash: string;
  createdAt: string;
  lastLoginAt?: string;
  disabled?: boolean;
}

/** What the client is allowed to know about a user. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
  disabled?: boolean;
}

export function toPublicUser(user: User): PublicUser {
  const { passwordHash, ...rest } = user;
  void passwordHash;
  return rest;
}

/**
 * An invitation to create an account.
 *
 * **The link is the invitation, and email is only one way to deliver it.** Requiring a working
 * mail server before anybody can add a second user is one of the most common reasons a
 * self-hosted install stalls, so this works with no mail configuration at all: an admin creates
 * an invite, copies the link, and sends it through whatever the team already uses.
 *
 * It also fixes the real weakness in creating accounts directly, which is that the admin picks
 * the password and therefore knows it. Here the person sets their own, and it is never seen by
 * anyone else.
 */
export interface Invite {
  id: string;
  /**
   * SHA-256 of the token. The token itself is returned once, at creation, and never stored.
   *
   * A plain hash rather than scrypt, deliberately. scrypt is slow on purpose because a password
   * has little entropy and must resist offline guessing. A token is 32 random bytes, so guessing
   * is already impossible and the slowness would only be a way to make redeeming feel broken.
   */
  tokenHash: string;
  role: Role;
  /** Suggested, and editable by the person redeeming it. */
  username?: string;
  displayName?: string;
  /**
   * Where the invitation was emailed, when it was.
   *
   * Recorded so an admin can see who a pending invitation was sent to, which is the question they
   * have a week later. It is not used to authenticate: the token is the credential, and the
   * person redeeming may well sign up under a different username.
   */
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  /** The account it produced, so an admin can see what an invite became. */
  redeemedBy?: string;
  /** Set when an admin revokes it before use. */
  revokedAt?: string;
}

/** What the client may know. Never includes `tokenHash`. */
export interface PublicInvite {
  id: string;
  role: Role;
  username?: string;
  displayName?: string;
  email?: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "redeemed" | "revoked" | "expired";
  redeemedBy?: string;
}

interface AuthFile {
  version: 1;
  sessionSecret: string;
  users: User[];
  /** Absent in files written before invites existed, so every read has to tolerate that. */
  invites?: Invite[];
}

/** Long enough to survive a weekend and a holiday Monday, short enough to expire. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SESSION_COOKIE = "strata_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthStore {
  private file: AuthFile | undefined;

  constructor(
    private readonly dataDir: string,
    /** When true, every request is treated as an admin. For single-user local use. */
    readonly disabled: boolean,
  ) {}

  private get path(): string {
    return join(this.dataDir, "auth.json");
  }

  private async load(): Promise<AuthFile> {
    if (this.file) return this.file;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as AuthFile;
      this.file = parsed;
    } catch {
      // First run: no file yet. A secret is minted now and persisted on first write
      // so that tokens issued before any user exists stay valid.
      this.file = { version: 1, sessionSecret: randomBytes(32).toString("hex"), users: [] };
    }
    return this.file;
  }

  private async persist(): Promise<void> {
    const file = await this.load();
    await mkdir(this.dataDir, { recursive: true });
    // 0o600: the file holds password hashes and the session signing secret.
    await writeFile(this.path, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  /**
   * The secret this instance signs with.
   *
   * Exposed so tenant cookies can be signed with the same key rather than introducing a second
   * one. Two secrets means two things to persist and back up, and the second is always the one an
   * operator forgets, at which case every trial workspace becomes unreachable after a restart.
   */
  async signingSecret(): Promise<string> {
    return (await this.load()).sessionSecret;
  }

  /** True when no account exists yet, so the UI should show first-run setup. */
  async needsSetup(): Promise<boolean> {
    if (this.disabled) return false;
    const { users } = await this.load();
    return users.length === 0;
  }

  /**
   * Create the administrator from configuration, if one is configured and none exists.
   *
   * **This closes a real takeover, not a theoretical one.** First-run setup is unauthenticated by
   * necessity: somebody has to be able to create the first account. The route is closed as soon
   * as an account exists, which is safe right up until the data directory goes away. On
   * Kubernetes `persistence.enabled: false` mounts an `emptyDir`, so every pod restart empties
   * `/data`, `needsSetup()` returns true again, and the next person to reach the ingress becomes
   * administrator with the stored GitHub token and write access to the model repo. The same
   * happens to anyone who forgets the volume in `docker run`.
   *
   * With a seed configured there is never a window: the account exists before the listener opens.
   *
   * **A hash is preferred to a password.** `STRATA_ADMIN_PASSWORD_HASH` holds a scrypt hash, which
   * is safe to put in a Kubernetes Secret, a Helm value or a compose file, because it cannot be
   * replayed anywhere else. `STRATA_ADMIN_PASSWORD` is accepted because a plain password is what
   * somebody trying strata for ten minutes actually has, and refusing it would push them to
   * `STRATA_AUTH=off`, which is worse. Generate a hash with `strata hash-password`.
   *
   * Returns what happened so the caller can log it. Seeding is never silent: an operator who
   * mistypes the variable name needs to find out at boot, not the first time they try to sign in.
   */
  async seedAdmin(seed: {
    username?: string;
    password?: string;
    passwordHash?: string;
  }): Promise<{ action: "created" | "skipped"; reason?: string }> {
    if (this.disabled) return { action: "skipped", reason: "authentication is disabled" };

    const username = seed.username?.trim().toLowerCase();
    if (!username) return { action: "skipped", reason: "no STRATA_ADMIN_USERNAME set" };

    const file = await this.load();
    if (file.users.length > 0) {
      /*
        Deliberately does not reconcile.

        An operator who leaves the seed variables in place after the first boot expects them to be
        inert, not to reset the password on every restart -- which would silently undo a rotation
        somebody did in the UI, and would put the current password back in the environment where
        `kubectl describe pod` can read it.
      */
      return { action: "skipped", reason: "an account already exists" };
    }

    if (seed.passwordHash) {
      const hash = seed.passwordHash.trim();
      if (!/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(hash)) {
        throw new AuthError(
          "STRATA_ADMIN_PASSWORD_HASH is not a scrypt hash. Generate one with `strata hash-password`.",
          422,
        );
      }

      const user: User = {
        id: `usr_${randomBytes(8).toString("hex")}`,
        username,
        displayName: username,
        role: "admin",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      };
      file.users.push(user);
      await this.persist();
      return { action: "created" };
    }

    if (seed.password) {
      await this.createUser({ username, password: seed.password, role: "admin" });
      return { action: "created" };
    }

    throw new AuthError(
      "STRATA_ADMIN_USERNAME is set but neither STRATA_ADMIN_PASSWORD nor STRATA_ADMIN_PASSWORD_HASH is.",
      422,
    );
  }

  async listUsers(): Promise<PublicUser[]> {
    const { users } = await this.load();
    return users.map(toPublicUser);
  }

  async findById(id: string): Promise<User | undefined> {
    const { users } = await this.load();
    return users.find((user) => user.id === id);
  }

  async createUser(input: {
    username: string;
    password: string;
    displayName?: string;
    role: Role;
  }): Promise<PublicUser> {
    const file = await this.load();
    const username = input.username.trim().toLowerCase();

    if (!username) throw new AuthError("a username is required", 422);
    if (input.password.length < 8) {
      throw new AuthError("passwords must be at least 8 characters", 422);
    }
    if (file.users.some((user) => user.username === username)) {
      throw new AuthError(`\`${username}\` already exists`, 409);
    }

    const user: User = {
      id: `usr_${randomBytes(8).toString("hex")}`,
      username,
      displayName: input.displayName?.trim() || username,
      role: input.role,
      passwordHash: await hashPassword(input.password),
      createdAt: new Date().toISOString(),
    };
    file.users.push(user);
    await this.persist();
    return toPublicUser(user);
  }

  async updateUser(
    id: string,
    patch: { displayName?: string; role?: Role; password?: string; disabled?: boolean },
  ): Promise<PublicUser> {
    const file = await this.load();
    const user = file.users.find((candidate) => candidate.id === id);
    if (!user) throw new AuthError("no such user", 404);

    // Refuse to remove the last administrator, or nobody can manage the instance.
    if ((patch.role && patch.role !== "admin") || patch.disabled === true) {
      const otherAdmins = file.users.filter(
        (candidate) => candidate.id !== id && candidate.role === "admin" && !candidate.disabled,
      );
      if (user.role === "admin" && otherAdmins.length === 0) {
        throw new AuthError("this is the only administrator; promote someone else first", 409);
      }
    }

    if (patch.displayName !== undefined) user.displayName = patch.displayName.trim() || user.username;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.disabled !== undefined) user.disabled = patch.disabled;
    if (patch.password !== undefined) {
      if (patch.password.length < 8) throw new AuthError("passwords must be at least 8 characters", 422);
      user.passwordHash = await hashPassword(patch.password);
    }

    await this.persist();
    return toPublicUser(user);
  }

  async deleteUser(id: string): Promise<void> {
    const file = await this.load();
    const user = file.users.find((candidate) => candidate.id === id);
    if (!user) throw new AuthError("no such user", 404);

    const otherAdmins = file.users.filter(
      (candidate) => candidate.id !== id && candidate.role === "admin" && !candidate.disabled,
    );
    if (user.role === "admin" && otherAdmins.length === 0) {
      throw new AuthError("this is the only administrator", 409);
    }

    file.users = file.users.filter((candidate) => candidate.id !== id);
    await this.persist();
  }

  async verify(username: string, password: string): Promise<User> {
    const file = await this.load();
    const user = file.users.find(
      (candidate) => candidate.username === username.trim().toLowerCase(),
    );

    // Verify against a dummy hash when the user is unknown, so a missing account and
    // a wrong password take the same time and cannot be told apart.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) throw new AuthError("incorrect username or password", 401);
    if (user.disabled) throw new AuthError("this account is disabled", 403);

    user.lastLoginAt = new Date().toISOString();
    await this.persist();
    return user;
  }

  async issueToken(user: User): Promise<string> {
    const { sessionSecret } = await this.load();
    const payload = JSON.stringify({ sub: user.id, exp: Date.now() + SESSION_TTL_MS });
    const body = Buffer.from(payload, "utf8").toString("base64url");
    const signature = createHmac("sha256", sessionSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  async userFromToken(token: string | undefined): Promise<User | undefined> {
    if (!token) return undefined;
    const [body, signature] = token.split(".");
    if (!body || !signature) return undefined;

    const { sessionSecret } = await this.load();
    const expected = createHmac("sha256", sessionSecret).update(body).digest("base64url");
    if (!equals(signature, expected)) return undefined;

    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        sub: string;
        exp: number;
      };
      if (payload.exp < Date.now()) return undefined;
      const user = await this.findById(payload.sub);
      return user?.disabled ? undefined : user;
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- invitations

  /**
   * Create an invitation and return its token exactly once.
   *
   * The caller has to surface the link now, because only the hash is kept. Losing it means
   * revoking the invite and issuing another, which is the right trade: a token that could be
   * read back later would sit in the data directory as a reusable credential.
   */
  async createInvite(input: {
    role: Role;
    username?: string;
    displayName?: string;
    email?: string;
    createdBy: string;
    now?: number;
  }): Promise<{ invite: PublicInvite; token: string }> {
    const file = await this.load();
    const now = input.now ?? Date.now();

    const username = input.username?.trim().toLowerCase() || undefined;
    if (username && file.users.some((user) => user.username === username)) {
      throw new AuthError(`\`${username}\` already exists`, 409);
    }

    const token = randomBytes(32).toString("base64url");
    const invite: Invite = {
      id: `inv_${randomBytes(8).toString("hex")}`,
      tokenHash: hashToken(token),
      role: input.role,
      ...(username ? { username } : {}),
      ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      createdBy: input.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };

    file.invites = [...(file.invites ?? []), invite];
    await this.persist();

    return { invite: toPublicInvite(invite, now), token };
  }

  async listInvites(now = Date.now()): Promise<PublicInvite[]> {
    const { invites } = await this.load();
    return (invites ?? []).map((invite) => toPublicInvite(invite, now));
  }

  /** Revoking is recorded rather than deleted, so the audit trail survives. */
  async revokeInvite(id: string, now = Date.now()): Promise<PublicInvite> {
    const file = await this.load();
    const invite = (file.invites ?? []).find((candidate) => candidate.id === id);

    if (!invite) throw new AuthError("no such invitation", 404);
    if (invite.redeemedAt) throw new AuthError("that invitation has already been used", 409);

    invite.revokedAt = new Date(now).toISOString();
    await this.persist();
    return toPublicInvite(invite, now);
  }

  /**
   * The invitation a token refers to, or `undefined` for anything not usable.
   *
   * Deliberately one answer for "wrong token", "already used", "revoked" and "expired". The
   * caller is unauthenticated, so distinguishing them would confirm that a token was once real.
   */
  async inviteForToken(token: string | undefined, now = Date.now()): Promise<Invite | undefined> {
    if (!token) return undefined;

    const { invites } = await this.load();
    const hash = hashToken(token);

    const invite = (invites ?? []).find((candidate) => {
      // Constant time, so the comparison cannot leak a hash a byte at a time.
      if (candidate.tokenHash.length !== hash.length) return false;
      return timingSafeEqual(Buffer.from(candidate.tokenHash), Buffer.from(hash));
    });

    if (!invite) return undefined;
    if (invite.redeemedAt || invite.revokedAt) return undefined;
    if (Date.parse(invite.expiresAt) <= now) return undefined;
    return invite;
  }

  /**
   * Turn an invitation into an account.
   *
   * The person sets their own password here, which is the entire point: nobody else ever knows
   * it. The role comes from the invitation rather than from the request, so somebody redeeming
   * a viewer invite cannot ask to be an admin.
   */
  async redeemInvite(
    token: string,
    input: { username: string; password: string; displayName?: string },
    now = Date.now(),
  ): Promise<PublicUser> {
    const invite = await this.inviteForToken(token, now);
    if (!invite) throw new AuthError("this invitation is no longer valid", 404);

    const user = await this.createUser({
      username: input.username,
      password: input.password,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      role: invite.role,
    });

    /*
      Marked used only after the account exists.

      `createUser` rejects a duplicate username or a short password, and burning the invitation
      before that check would leave somebody holding a dead link because they mistyped.
    */
    invite.redeemedAt = new Date(now).toISOString();
    invite.redeemedBy = user.username;
    await this.persist();

    return user;
  }
}

/** SHA-256, hex. See `Invite.tokenHash` for why this is not scrypt. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function toPublicInvite(invite: Invite, now = Date.now()): PublicInvite {
  const status: PublicInvite["status"] = invite.revokedAt
    ? "revoked"
    : invite.redeemedAt
      ? "redeemed"
      : Date.parse(invite.expiresAt) <= now
        ? "expired"
        : "pending";

  return {
    id: invite.id,
    role: invite.role,
    ...(invite.username ? { username: invite.username } : {}),
    ...(invite.displayName ? { displayName: invite.displayName } : {}),
    ...(invite.email ? { email: invite.email } : {}),
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    status,
    ...(invite.redeemedBy ? { redeemedBy: invite.redeemedBy } : {}),
  };
}


export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Hash a password for storage.
 *
 * Exported so `strata hash-password` can produce a value for `STRATA_ADMIN_PASSWORD_HASH` using exactly
 * this code. A separate implementation in the CLI would be one refactor away from producing
 * hashes the server cannot verify, and the failure would show up as "the seeded admin cannot sign
 * in", which is a miserable thing to debug.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), 64);
  return equals(derived.toString("hex"), hashHex);
}

/** Constant-time string comparison. */
function equals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** A real hash of a random value, used to equalise timing on unknown usernames. */
const DUMMY_HASH = `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`;

/** Parse the Cookie header. Avoids a dependency for what is a one-liner. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** The authenticated user, attached by `attachUser`. */
export interface AuthedRequest extends Request {
  user?: User;
  /** Correlation id, attached by the request logger. See `logging.ts`. */
  context?: RequestContext;
}

export function attachUser(store: AuthStore): RequestHandler {
  return (req: AuthedRequest, _res, next) => {
    if (store.disabled) {
      req.user = {
        id: "usr_local",
        username: "local",
        displayName: "Local user",
        role: "admin",
        passwordHash: "",
        createdAt: new Date(0).toISOString(),
      };
      next();
      return;
    }
    store
      .userFromToken(readCookie(req, SESSION_COOKIE))
      .then((user) => {
        if (user) req.user = user;
        next();
      })
      .catch(() => next());
  };
}

/**
 * Gate a route on a minimum role.
 *
 * Roles are ordered, so `requireRole("editor")` admits editors and admins. A viewer
 * hitting a write endpoint gets 403 rather than a silent no-op, the UI disables
 * those controls, but the server is what actually enforces it.
 */
/**
 * A guard that also says what it guards.
 *
 * The marker is read by the route audit in `routes.test.ts`, which walks the express router and
 * asserts that every `/api` route carries one. Naming the role in a property rather than
 * inferring it from a function name is what lets that test be exhaustive instead of a sample: a
 * route added without a guard fails the suite rather than waiting to be noticed.
 */
export interface GuardHandler extends RequestHandler {
  strataRole?: Role;
  strataFeature?: string;
}

export function requireRole(store: AuthStore, minimum: Role): GuardHandler {
  const guard: GuardHandler = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (store.disabled) {
      next();
      return;
    }
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "sign in to continue" });
      return;
    }
    if (ROLE_RANK[user.role] < ROLE_RANK[minimum]) {
      res.status(403).json({
        error: `this action needs the \`${minimum}\` role; you have \`${user.role}\``,
      });
      return;
    }
    next();
  };

  guard.strataRole = minimum;
  return guard;
}

export function hasRole(user: User | undefined, minimum: Role): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}
