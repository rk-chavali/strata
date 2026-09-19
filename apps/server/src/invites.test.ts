import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, AuthStore } from "./auth.js";

/**
 * Invitations.
 *
 * These exist to fix one specific weakness in creating accounts directly: the admin picks the
 * password, so the admin knows it, and it usually travels over chat in plain text. An invitation
 * lets the person set their own, and nobody else ever sees it.
 *
 * The properties worth testing are all about what an invitation *stops* being: single use, time
 * boxed, revocable, and unable to grant a role it was not issued for.
 */

const dirs: string[] = [];

async function store(): Promise<AuthStore> {
  const dir = await mkdtemp(join(tmpdir(), "strata-invites-"));
  dirs.push(dir);
  return new AuthStore(dir, false);
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function withAdmin(): Promise<AuthStore> {
  const auth = await store();
  await auth.createUser({ username: "admin", password: "admin-password", role: "admin" });
  return auth;
}

describe("creating an invitation", () => {
  it("returns the token once and keeps only a hash", async () => {
    const auth = await withAdmin();
    const { invite, token } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    expect(token).toBeTruthy();
    expect(invite.status).toBe("pending");
    expect(invite.role).toBe("editor");

    // The listing is what a UI renders, and it must never carry anything redeemable.
    const listed = await auth.listInvites();
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed[0]).not.toHaveProperty("tokenHash");
  });

  it("refuses to invite a username that already exists", async () => {
    const auth = await withAdmin();
    await expect(
      auth.createInvite({ role: "viewer", username: "admin", createdBy: "admin" }),
    ).rejects.toThrow(AuthError);
  });

  it("issues a different token every time", async () => {
    const auth = await withAdmin();
    const a = await auth.createInvite({ role: "viewer", createdBy: "admin" });
    const b = await auth.createInvite({ role: "viewer", createdBy: "admin" });
    expect(a.token).not.toBe(b.token);
  });
});

describe("redeeming an invitation", () => {
  it("creates the account with the password the person chose", async () => {
    const auth = await withAdmin();
    const { token } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    const user = await auth.redeemInvite(token, { username: "dana", password: "chosen-by-dana" });

    expect(user.username).toBe("dana");
    expect(user.role).toBe("editor");
    // The password works, which is the point: the admin never handled it.
    await expect(auth.verify("dana", "chosen-by-dana")).resolves.toMatchObject({ username: "dana" });
  });

  it("takes the role from the invitation, not from the request", async () => {
    // Otherwise anybody holding a viewer invite could ask to be an admin.
    const auth = await withAdmin();
    const { token } = await auth.createInvite({ role: "viewer", createdBy: "admin" });

    const user = await auth.redeemInvite(token, {
      username: "dana",
      password: "chosen-by-dana",
      // @ts-expect-error the shape does not accept a role, and this asserts it stays that way
      role: "admin",
    });

    expect(user.role).toBe("viewer");
  });

  it("cannot be used twice", async () => {
    const auth = await withAdmin();
    const { token } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    await auth.redeemInvite(token, { username: "dana", password: "chosen-by-dana" });
    await expect(
      auth.redeemInvite(token, { username: "sam", password: "chosen-by-sam" }),
    ).rejects.toThrow(AuthError);
  });

  it("survives a failed attempt rather than burning the link", async () => {
    // A mistyped short password must not cost somebody their invitation.
    const auth = await withAdmin();
    const { token } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    await expect(auth.redeemInvite(token, { username: "dana", password: "short" })).rejects.toThrow(
      AuthError,
    );

    const user = await auth.redeemInvite(token, { username: "dana", password: "long-enough" });
    expect(user.username).toBe("dana");
  });

  it("rejects a token that was never issued", async () => {
    const auth = await withAdmin();
    await auth.createInvite({ role: "editor", createdBy: "admin" });

    await expect(
      auth.redeemInvite("not-a-real-token", { username: "dana", password: "chosen-by-dana" }),
    ).rejects.toThrow(AuthError);
  });

  it("expires", async () => {
    const auth = await withAdmin();
    const now = Date.UTC(2026, 0, 1);
    const { token } = await auth.createInvite({ role: "editor", createdBy: "admin", now });

    const sixDays = now + 6 * 24 * 60 * 60 * 1000;
    expect(await auth.inviteForToken(token, sixDays)).toBeDefined();

    const eightDays = now + 8 * 24 * 60 * 60 * 1000;
    expect(await auth.inviteForToken(token, eightDays)).toBeUndefined();
    expect((await auth.listInvites(eightDays))[0]?.status).toBe("expired");
  });
});

describe("revoking an invitation", () => {
  it("stops the link working", async () => {
    const auth = await withAdmin();
    const { invite, token } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    await auth.revokeInvite(invite.id);

    expect(await auth.inviteForToken(token)).toBeUndefined();
    expect((await auth.listInvites())[0]?.status).toBe("revoked");
  });

  it("records rather than deletes, so the trail survives", async () => {
    const auth = await withAdmin();
    const { invite } = await auth.createInvite({ role: "editor", createdBy: "admin" });

    await auth.revokeInvite(invite.id);
    expect(await auth.listInvites()).toHaveLength(1);
  });

  it("will not revoke one that has already been used", async () => {
    // The account exists by then, so revoking would imply an undo it does not perform.
    const auth = await withAdmin();
    const { invite, token } = await auth.createInvite({ role: "editor", createdBy: "admin" });
    await auth.redeemInvite(token, { username: "dana", password: "chosen-by-dana" });

    await expect(auth.revokeInvite(invite.id)).rejects.toThrow(AuthError);
  });

  it("reports an unknown id rather than doing nothing", async () => {
    const auth = await withAdmin();
    await expect(auth.revokeInvite("inv_nope")).rejects.toThrow(AuthError);
  });
});

describe("an auth file written before invites existed", () => {
  it("still loads, and can take its first invitation", async () => {
    // `invites` is optional on the stored shape for exactly this reason. Reading an older file
    // must not throw, or upgrading would lock an operator out of their own instance.
    const auth = await withAdmin();

    expect(await auth.listInvites()).toEqual([]);
    const { token } = await auth.createInvite({ role: "viewer", createdBy: "admin" });
    expect(await auth.inviteForToken(token)).toBeDefined();
  });
});
