/**
 * Presence and the object locks that ride on it.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { type AuthedRequest } from "../auth.js";
import { editors, readers } from "../guards.js";
import { LockedError } from "../presence.js";
import { handler } from "../respond.js";
import { presence } from "../services.js";

export const presenceRoutes = Router();

// ---------------------------------------------------------------- presence

/**
 * The live event stream.
 *
 * `readers` gates it, so an unauthenticated request gets 401 before any stream opens.
 * `EventSource` cannot set headers, which is exactly why the session is a cookie rather
 * than a bearer token, it rides along automatically.
 */
presenceRoutes.get("/api/events", readers, (req, res) => {
  const user = (req as AuthedRequest).user ?? {
    id: "usr_local",
    username: "local",
    displayName: "Local user",
    role: "admin" as const,
    passwordHash: "",
    createdAt: new Date(0).toISOString(),
  };
  presence().open(res, user);
});

/** Tell the server which model this session is looking at. */
presenceRoutes.post(
  "/api/presence/where",
  readers,
  handler(async (req, res) => {
    const body = req.body as { connectionId?: string; model?: string; diagram?: string };
    if (!body.connectionId) {
      res.status(400).json({ error: "a connectionId is required" });
      return;
    }
    const known = presence().where(body.connectionId, {
      ...(body.model ? { model: body.model } : {}),
      ...(body.diagram ? { diagram: body.diagram } : {}),
    });
    // Not an error: the stream may have reconnected with a new id and the client will
    // pick that up from the next `hello`. Say so rather than failing the request.
    res.json({ ok: known, peers: presence().peers() });
  }),
);

presenceRoutes.get(
  "/api/presence",
  readers,
  handler(async (_req, res) => {
    res.json({ peers: presence().peers(), locks: presence().activeLocks() });
  }),
);

/**
 * Claim an object for editing.
 *
 * Editors only, a viewer cannot write, so letting them lock would be pure denial of
 * service against the people who can.
 */
presenceRoutes.post(
  "/api/locks",
  editors,
  handler(async (req, res) => {
    const body = req.body as { objectId?: string; connectionId?: string; name?: string };
    if (!body.objectId || !body.connectionId) {
      res.status(400).json({ error: "objectId and connectionId are required" });
      return;
    }
    try {
      const lock = presence().claim(body.objectId, body.connectionId, body.name);
      res.json({ lock });
    } catch (error) {
      if (error instanceof LockedError) {
        res.status(409).json({ error: error.message, lock: error.lock });
        return;
      }
      throw error;
    }
  }),
);

presenceRoutes.delete(
  "/api/locks/:objectId",
  editors,
  handler(async (req, res) => {
    const connectionId = String(req.query.connectionId ?? "");
    const released = presence().release(String(req.params.objectId), connectionId);
    res.json({ released });
  }),
);

