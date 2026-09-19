/**
 * Administering local accounts.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { ROLES, type Role, clearSessionCookie } from "../auth.js";
import { admins, readers, recordAudit } from "../guards.js";
import { handler } from "../respond.js";
import { auth } from "../services.js";

export const userRoutes = Router();

// ---------------------------------------------------------------- users (admin)

userRoutes.get(
  "/api/users",
  admins,
  handler(async (_req, res) => {
    res.json({ items: await auth.listUsers(), roles: ROLES });
  }),
);

userRoutes.post(
  "/api/users",
  admins,
  handler(async (req, res) => {
    const body = req.body as { username?: string; password?: string; displayName?: string; role?: Role };
    res.status(201).json({
      user: await auth.createUser({
        username: body.username ?? "",
        password: body.password ?? "",
        ...(body.displayName ? { displayName: body.displayName } : {}),
        role: body.role ?? "viewer",
      }),
    });
  }),
);

userRoutes.put(
  "/api/users/:id",
  admins,
  handler(async (req, res) => {
    const body = req.body as { displayName?: string; role?: Role; password?: string; disabled?: boolean };
    res.json({ user: await auth.updateUser(req.params.id ?? "", body) });
  }),
);

userRoutes.delete(
  "/api/users/:id",
  admins,
  handler(async (req, res) => {
    await auth.deleteUser(req.params.id ?? "");
    res.json({ ok: true });
  }),
);


/**
 * Close your own account.
 *
 * Separate from `DELETE /api/users/:id`, which is an administrator removing somebody else and is
 * gated on `admins`. Without this route a viewer or an editor cannot leave: the only way out is
 * to ask an administrator, which is a strange thing to have to do with your own account.
 *
 * `readers`, so anyone signed in can use it, and it can only ever delete the caller. The id comes
 * from the session rather than the request, so there is no parameter to tamper with.
 *
 * The username has to be typed back. A misclick should not end an account, and a confirmation
 * dialog alone is the thing people click through without reading.
 */
userRoutes.delete(
  "/api/account",
  readers,
  handler(async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: "sign in to continue" });
      return;
    }

    const body = req.body as { username?: string };
    if ((body.username ?? "").trim().toLowerCase() !== req.user.username) {
      res.status(422).json({ error: "type your username to confirm" });
      return;
    }

    /*
      `deleteUser` refuses to remove the last remaining administrator, and that guard is what
      stops somebody locking everyone out of their own instance from this screen. Reused rather
      than repeated, so the two routes cannot drift apart on the rule that matters.
    */
    await auth.deleteUser(req.user.id);
    await recordAudit(req, "user.delete", { target: req.user.username, detail: "closed their own account" });

    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

