import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { Role, User } from "./auth.js";

/**
 * Who else is in the workspace right now, and what they have open.
 *
 * **Why this is not a database.** Presence is worthless the moment it is stale, nobody
 * wants to know who was editing yesterday. It has exactly the lifetime of a TCP
 * connection, so the connection *is* the record. Writing it to Postgres would mean
 * persisting facts whose only correct value is "gone" the instant the process dies,
 * and then writing a reaper to delete them again.
 *
 * **Why server-sent events rather than WebSockets.** Everything here flows one way:
 * the server tells clients what changed, and clients write back over ordinary HTTP
 * they already use. SSE gets automatic reconnection with backoff from the browser for
 * free, survives the corporate proxies that quietly refuse an `Upgrade:` handshake,
 * and needs no dependency. WebSockets would start earning their keep at live cursors
 * or character-by-character co-editing, and we are not building those.
 *
 * **The multi-replica caveat, stated plainly.** This registry is per-process. Run one
 * container and it is exactly right. Run three behind a load balancer and each sees
 * only its own third of the users, and locks stop being visible across replicas. That
 * is the point at which a shared store, Redis, or Postgres `LISTEN/NOTIFY`, starts
 * paying for itself, and not before.
 */

/** How long a lock survives without a renewal. Comfortably longer than the client's renew interval. */
const LOCK_TTL_MS = 2 * 60 * 1000;

/** Comment frames keep proxies from treating an idle stream as dead. */
const HEARTBEAT_MS = 25 * 1000;

/** How often expired locks and dead connections are swept. */
const SWEEP_MS = 15 * 1000;

export interface Peer {
  connectionId: string;
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  /** The model this peer currently has open, when they are on one. */
  model?: string;
  diagram?: string;
  since: string;
}

export interface Lock {
  objectId: string;
  objectName?: string;
  userId: string;
  username: string;
  displayName: string;
  connectionId: string;
  since: string;
  expiresAt: string;
}

/** Raised when someone tries to take a lock another live session already holds. */
export class LockedError extends Error {
  constructor(readonly lock: Lock) {
    super(`${lock.displayName} is editing this`);
    this.name = "LockedError";
  }
}

interface Connection {
  id: string;
  res: Response;
  user: Pick<User, "id" | "username" | "displayName" | "role">;
  model?: string;
  diagram?: string;
  since: number;
}

export class Presence {
  private readonly connections = new Map<string, Connection>();
  private readonly locks = new Map<string, Lock>();
  private timer: NodeJS.Timeout | undefined;

  /**
   * Attach a client to the event stream.
   *
   * Returns the connection id, which the client echoes back on writes so we can avoid
   * telling it about its own changes, otherwise every edit you make bounces back as
   * "the workspace changed, reload".
   */
  open(res: Response, user: User): string {
    const id = `con_${randomBytes(8).toString("hex")}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // nginx buffers proxied responses by default, which holds events until the buffer
    // fills, for a stream that trickles, that means they never arrive.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const connection: Connection = {
      id,
      res,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
      since: Date.now(),
    };
    this.connections.set(id, connection);

    this.send(connection, "hello", { connectionId: id, heartbeatMs: HEARTBEAT_MS });
    this.send(connection, "locks", { locks: this.activeLocks() });
    this.broadcastPeers();
    this.ensureSweeper();

    const close = (): void => this.close(id);
    res.on("close", close);
    res.on("error", close);

    return id;
  }

  private close(id: string): void {
    if (!this.connections.delete(id)) return;

    // Drop whatever this session was holding. A lock outliving the tab that took it is
    // the classic way collaborative editing rots: eventually everything is locked by
    // someone who went home.
    let releasedAny = false;
    for (const [objectId, lock] of this.locks) {
      if (lock.connectionId === id) {
        this.locks.delete(objectId);
        releasedAny = true;
      }
    }

    this.broadcastPeers();
    if (releasedAny) this.broadcastLocks();
    if (this.connections.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Record what a client is looking at, so the peer list can say "also on retail_warehouse". */
  where(connectionId: string, at: { model?: string; diagram?: string }): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    const changed = connection.model !== at.model || connection.diagram !== at.diagram;
    connection.model = at.model;
    connection.diagram = at.diagram;
    if (changed) this.broadcastPeers();
    return true;
  }

  /**
   * How many clients are attached right now.
   *
   * Exposed so the per-tenant store cache can tell whether it is safe to evict this instance.
   * Dropping a `Presence` that still holds open response objects would leave those clients with a
   * connection nothing will ever write to again, which reads as "live updates stopped working"
   * rather than as an error.
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  peers(): Peer[] {
    return [...this.connections.values()]
      .map((connection) => ({
        connectionId: connection.id,
        userId: connection.user.id,
        username: connection.user.username,
        displayName: connection.user.displayName,
        role: connection.user.role,
        ...(connection.model ? { model: connection.model } : {}),
        ...(connection.diagram ? { diagram: connection.diagram } : {}),
        since: new Date(connection.since).toISOString(),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  activeLocks(): Lock[] {
    const now = Date.now();
    return [...this.locks.values()].filter((lock) => Date.parse(lock.expiresAt) > now);
  }

  /**
   * Take an advisory lock on an object.
   *
   * Advisory is the honest word. The model is files in a git repo, a colleague can
   * edit the same YAML in their IDE, or push a branch, and no lock we hold in memory
   * has any say in it. What this buys is the thing people actually want: seeing that
   * someone is already in there *before* spending ten minutes on a change that will
   * collide. The real safety net stays the revision check on write, which turns a
   * genuine conflict into a 409 instead of a silent overwrite.
   */
  claim(objectId: string, connectionId: string, objectName?: string): Lock {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new Error("this session is not connected to the event stream");

    const held = this.locks.get(objectId);
    const now = Date.now();
    if (held && Date.parse(held.expiresAt) > now && held.connectionId !== connectionId) {
      throw new LockedError(held);
    }

    const lock: Lock = {
      objectId,
      ...(objectName ? { objectName } : {}),
      userId: connection.user.id,
      username: connection.user.username,
      displayName: connection.user.displayName,
      connectionId,
      since: held?.connectionId === connectionId ? held.since : new Date(now).toISOString(),
      expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
    };
    this.locks.set(objectId, lock);
    this.broadcastLocks();
    return lock;
  }

  /** Give up a lock. Only the holder can, so a stale tab cannot free someone else's. */
  release(objectId: string, connectionId: string): boolean {
    const held = this.locks.get(objectId);
    if (!held || held.connectionId !== connectionId) return false;
    this.locks.delete(objectId);
    this.broadcastLocks();
    return true;
  }

  /** Who holds this object, if anyone, used to warn before an edit rather than after. */
  heldBy(objectId: string): Lock | undefined {
    const lock = this.locks.get(objectId);
    if (!lock) return undefined;
    return Date.parse(lock.expiresAt) > Date.now() ? lock : undefined;
  }

  /**
   * Tell everyone else that the repo moved under them.
   *
   * Deliberately not a diff or a patch. The server re-reads the workspace from disk on
   * every request anyway, so the only thing a client needs to hear is "refetch"; trying
   * to ship incremental state would mean two sources of truth about the same files.
   */
  announceChange(change: {
    by?: { username: string; displayName: string };
    originConnectionId?: string;
    scope: "objects" | "settings" | "git" | "generated";
  }): void {
    const payload = {
      scope: change.scope,
      at: new Date().toISOString(),
      ...(change.by ? { by: change.by.displayName, username: change.by.username } : {}),
    };
    for (const connection of this.connections.values()) {
      if (connection.id === change.originConnectionId) continue;
      this.send(connection, "changed", payload);
    }
  }

  private broadcastPeers(): void {
    const peers = this.peers();
    for (const connection of this.connections.values()) {
      this.send(connection, "presence", { peers });
    }
  }

  private broadcastLocks(): void {
    const locks = this.activeLocks();
    for (const connection of this.connections.values()) {
      this.send(connection, "locks", { locks });
    }
  }

  private send(connection: Connection, event: string, data: unknown): void {
    try {
      connection.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // The socket went away between the check and the write. The close handler will
      // clean up; swallowing here keeps one dead client from breaking the broadcast
      // loop for everyone still connected.
    }
  }

  private ensureSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();

      let expired = false;
      for (const [objectId, lock] of this.locks) {
        if (Date.parse(lock.expiresAt) <= now) {
          this.locks.delete(objectId);
          expired = true;
        }
      }
      if (expired) this.broadcastLocks();

      for (const connection of this.connections.values()) {
        try {
          connection.res.write(`: ping ${now}\n\n`);
        } catch {
          this.close(connection.id);
        }
      }
    }, Math.min(SWEEP_MS, HEARTBEAT_MS));

    // A bare interval keeps the process alive through an otherwise clean shutdown.
    this.timer.unref?.();
  }
}
