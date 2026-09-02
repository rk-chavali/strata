import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { Response } from "express";
import { attributeTitle } from "./git.js";
import { authEnv, stripCredentials, validateRemoteUrl } from "./gitcreds.js";
import { LockedError, Presence } from "./presence.js";
import type { User } from "./auth.js";

/** A response object that records what was written to the stream. */
function fakeResponse(): Response & { frames: string[] } {
  const frames: string[] = [];
  const handlers = new Map<string, () => void>();
  const res = {
    frames,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return res;
    },
    /** Simulate the browser going away. */
    hangUp: () => handlers.get("close")?.(),
  };
  return res as unknown as Response & { frames: string[]; hangUp: () => void };
}

function user(id: string, username: string): User {
  return {
    id,
    username,
    displayName: username[0]!.toUpperCase() + username.slice(1),
    role: "editor",
    passwordHash: "",
    createdAt: new Date(0).toISOString(),
  };
}

/** Pull the parsed payloads for one event type out of a recorded stream. */
function events(res: { frames: string[] }, name: string): unknown[] {
  return res.frames
    .filter((frame) => frame.startsWith(`event: ${name}\n`))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6).trim()));
}

describe("attributeTitle", () => {
  it("stamps the username so a shared bot token does not hide the author", () => {
    expect(attributeTitle("Add customer dimension", "alice")).toBe("Add customer dimension | alice");
  });

  it("does not stamp twice when a branch is reused", () => {
    const once = attributeTitle("Add customer dimension", "alice");
    expect(attributeTitle(once, "alice")).toBe(once);
  });

  it("leaves the title alone when nobody is signed in", () => {
    expect(attributeTitle("Add customer dimension", undefined)).toBe("Add customer dimension");
  });

  it("trims, so a stray space does not push the pipe away from the title", () => {
    expect(attributeTitle("  Add customer dimension  ", "alice")).toBe("Add customer dimension | alice");
  });

  it("still stamps a title that merely contains a pipe", () => {
    expect(attributeTitle("orders | v2 rework", "bob")).toBe("orders | v2 rework | bob");
  });
});

describe("git credentials", () => {
  it("passes the token in the environment, never in the command line", async () => {
    const env = await authEnv("ghp_secret_token");

    expect(env.STRATA_GIT_TOKEN).toBe("ghp_secret_token");
    expect(env.GIT_ASKPASS).toBeTruthy();
    // Set so a rejected token fails fast instead of blocking on a prompt nobody sees.
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("writes an askpass helper that exists on disk and answers both prompts", async () => {
    const env = await authEnv("ghp_secret_token");
    const script = await readFile(env.GIT_ASKPASS!, "utf8");

    // Git asks for the username first; answering with the token for both works on
    // GitHub but not on every host, so the two cases are handled separately.
    expect(script).toMatch(/Username/);
    expect(script).toMatch(/STRATA_GIT_TOKEN/);
  });

  it("leaves the environment alone when there is no token", async () => {
    // A deployment using an SSH agent or a credential helper must keep working.
    const env = await authEnv(undefined);
    expect(env).toBe(process.env);
  });
});

describe("remote URLs", () => {
  it("accepts an ordinary GitHub HTTPS URL", () => {
    expect(validateRemoteUrl("https://github.com/acme/models.git")).toEqual({
      ok: true,
      url: "https://github.com/acme/models.git",
    });
  });

  it("accepts a GitHub Enterprise host", () => {
    const result = validateRemoteUrl("https://git.acme-corp.internal/data/models.git");
    expect(result.ok).toBe(true);
  });

  it("strips a token someone pasted from a CI config", () => {
    // Otherwise it would be written verbatim into .git/config as a plaintext secret.
    const result = validateRemoteUrl("https://x-access-token:ghp_secret@github.com/acme/models.git");
    expect(result).toEqual({ ok: true, url: "https://github.com/acme/models.git" });
  });

  it("strips a bare username too", () => {
    expect(stripCredentials("https://alice@github.com/acme/models.git")).toBe(
      "https://github.com/acme/models.git",
    );
  });

  it("leaves a clean URL untouched", () => {
    expect(stripCredentials("https://github.com/acme/models.git")).toBe(
      "https://github.com/acme/models.git",
    );
  });

  it("rejects SSH, which a token cannot authenticate", () => {
    const result = validateRemoteUrl("git@github.com:acme/models.git");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("HTTPS");
  });

  it("rejects ssh:// as well", () => {
    expect(validateRemoteUrl("ssh://git@github.com/acme/models.git").ok).toBe(false);
  });

  it("rejects plain http, which would send the token in clear", () => {
    expect(validateRemoteUrl("http://github.com/acme/models.git").ok).toBe(false);
  });

  it("rejects a URL with no owner and repo", () => {
    expect(validateRemoteUrl("https://github.com/acme").ok).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(validateRemoteUrl("   ").ok).toBe(false);
  });

  it("rejects something that is not a URL at all", () => {
    expect(validateRemoteUrl("acme/models").ok).toBe(false);
  });
});

describe("presence", () => {
  it("tells a new connection its id, so writes can be excluded from their own broadcast", () => {
    const presence = new Presence();
    const res = fakeResponse();
    const id = presence.open(res, user("usr_a", "alice"));

    const [hello] = events(res, "hello") as { connectionId: string }[];
    expect(hello?.connectionId).toBe(id);
  });

  it("announces peers to everyone when someone joins", () => {
    const presence = new Presence();
    const first = fakeResponse();
    presence.open(first, user("usr_a", "alice"));
    presence.open(fakeResponse(), user("usr_b", "bob"));

    const latest = events(first, "presence").at(-1) as { peers: { username: string }[] };
    expect(latest.peers.map((peer) => peer.username).sort()).toEqual(["alice", "bob"]);
  });

  it("drops a peer when the connection closes", () => {
    const presence = new Presence();
    const alice = fakeResponse();
    presence.open(alice, user("usr_a", "alice"));
    const bob = fakeResponse() as ReturnType<typeof fakeResponse> & { hangUp: () => void };
    presence.open(bob, user("usr_b", "bob"));

    bob.hangUp();

    expect(presence.peers().map((peer) => peer.username)).toEqual(["alice"]);
  });

  it("records what a peer is looking at", () => {
    const presence = new Presence();
    const id = presence.open(fakeResponse(), user("usr_a", "alice"));
    presence.where(id, { model: "retail_warehouse" });

    expect(presence.peers()[0]?.model).toBe("retail_warehouse");
  });

  it("refuses a lock another live session holds", () => {
    const presence = new Presence();
    const alice = presence.open(fakeResponse(), user("usr_a", "alice"));
    const bob = presence.open(fakeResponse(), user("usr_b", "bob"));

    presence.claim("obj_1", alice);

    expect(() => presence.claim("obj_1", bob)).toThrow(LockedError);
  });

  it("lets the holder re-claim, which is how renewal works", () => {
    const presence = new Presence();
    const alice = presence.open(fakeResponse(), user("usr_a", "alice"));

    const first = presence.claim("obj_1", alice);
    const renewed = presence.claim("obj_1", alice);

    // Same claim extended, not a new one, the "since" time is what the UI shows.
    expect(renewed.since).toBe(first.since);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first.expiresAt));
  });

  it("releases every lock a connection held when it closes", () => {
    const presence = new Presence();
    const alice = fakeResponse() as ReturnType<typeof fakeResponse> & { hangUp: () => void };
    const id = presence.open(alice, user("usr_a", "alice"));
    presence.claim("obj_1", id);
    presence.claim("obj_2", id);

    alice.hangUp();

    // Otherwise a closed tab locks an object until someone restarts the server.
    expect(presence.activeLocks()).toEqual([]);
  });

  it("will not let a non-holder release someone else's lock", () => {
    const presence = new Presence();
    const alice = presence.open(fakeResponse(), user("usr_a", "alice"));
    const bob = presence.open(fakeResponse(), user("usr_b", "bob"));
    presence.claim("obj_1", alice);

    expect(presence.release("obj_1", bob)).toBe(false);
    expect(presence.heldBy("obj_1")?.username).toBe("alice");
  });

  it("treats an expired lock as free", () => {
    vi.useFakeTimers();
    try {
      const presence = new Presence();
      const alice = presence.open(fakeResponse(), user("usr_a", "alice"));
      const bob = presence.open(fakeResponse(), user("usr_b", "bob"));
      presence.claim("obj_1", alice);

      // Past the two-minute TTL without a renewal: alice's tab is gone or asleep.
      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(presence.heldBy("obj_1")).toBeUndefined();
      expect(() => presence.claim("obj_1", bob)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not tell the originating connection about its own change", () => {
    const presence = new Presence();
    const alice = fakeResponse();
    const bob = fakeResponse();
    const aliceId = presence.open(alice, user("usr_a", "alice"));
    presence.open(bob, user("usr_b", "bob"));

    presence.announceChange({
      scope: "objects",
      originConnectionId: aliceId,
      by: { username: "alice", displayName: "Alice" },
    });

    expect(events(alice, "changed")).toHaveLength(0);
    expect(events(bob, "changed")).toHaveLength(1);
  });

  it("names who made the change, so the toast can say so", () => {
    const presence = new Presence();
    const bob = fakeResponse();
    presence.open(bob, user("usr_b", "bob"));

    presence.announceChange({ scope: "git", by: { username: "alice", displayName: "Alice Smith" } });

    expect(events(bob, "changed")[0]).toMatchObject({ scope: "git", by: "Alice Smith" });
  });
});
