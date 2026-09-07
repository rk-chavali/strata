import { describe, expect, it } from "vitest";

import { isTenantId } from "./tenancy.js";
import {
  CloudError,
  GitHubIdentity,
  apiUrlFor,
  SessionSealer,
  issueState,
  parseRepo,
  roleFromPermissions,
  tenantIdForRepo,
  verifyState,
  type CloudSession,
} from "./cloud.js";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);

const session = (over: Partial<CloudSession> = {}): CloudSession => ({
  user: { id: 42, login: "octocat" },
  token: "gho_livecredential",
  exp: Date.now() + 60_000,
  ...over,
});

describe("roleFromPermissions", () => {
  it("maps GitHub's permissions onto the product's roles", () => {
    expect(roleFromPermissions({ admin: true, push: true, pull: true })).toBe("admin");
    expect(roleFromPermissions({ push: true, pull: true })).toBe("editor");
    expect(roleFromPermissions({ pull: true })).toBe("viewer");
  });

  it("degrades to viewer rather than to write access", () => {
    // If GitHub ever changes this response shape, the failure has to be read-only. Anything that
    // defaulted to `editor` would silently hand out write access to somebody's model repository.
    expect(roleFromPermissions(undefined)).toBe("viewer");
    expect(roleFromPermissions({})).toBe("viewer");
  });
});

describe("tenantIdForRepo", () => {
  it("is stable, so two colleagues reach the same workspace", () => {
    expect(tenantIdForRepo("acme/models", SECRET)).toBe(tenantIdForRepo("acme/models", SECRET));
  });

  it("ignores case, because GitHub does", () => {
    expect(tenantIdForRepo("Acme/Models", SECRET)).toBe(tenantIdForRepo("acme/models", SECRET));
  });

  it("produces something the existing containment checks accept", () => {
    expect(isTenantId(tenantIdForRepo("acme/models", SECRET))).toBe(true);
  });

  it("separates repositories, and separates instances", () => {
    expect(tenantIdForRepo("acme/models", SECRET)).not.toBe(tenantIdForRepo("acme/other", SECRET));
    // Keyed, so knowing the repository name is not enough to work out where it lives.
    expect(tenantIdForRepo("acme/models", SECRET)).not.toBe(tenantIdForRepo("acme/models", OTHER));
  });
});

describe("parseRepo", () => {
  it("accepts owner/name", () => {
    expect(parseRepo("acme/data-models")).toEqual({ owner: "acme", name: "data-models" });
    expect(parseRepo("  acme/models  ")).toEqual({ owner: "acme", name: "models" });
  });

  it("rejects anything that is not exactly one segment each side", () => {
    for (const bad of ["", "acme", "acme/", "/models", "acme/models/extra", "acme models"]) {
      expect(() => parseRepo(bad)).toThrow(CloudError);
    }
  });

  it("rejects path traversal", () => {
    // These reach a directory join, so a `..` segment would escape the tenant root.
    for (const bad of ["../etc", "acme/..", "../../etc/passwd", "./x"]) {
      expect(() => parseRepo(bad)).toThrow(CloudError);
    }
  });
});

describe("SessionSealer", () => {
  it("round trips a session", () => {
    const sealer = new SessionSealer(SECRET);
    const original = session({ repo: "acme/models" });
    const restored = sealer.unseal(sealer.seal(original));

    expect(restored?.user.login).toBe("octocat");
    expect(restored?.repo).toBe("acme/models");
    expect(restored?.token).toBe("gho_livecredential");
  });

  it("does not leave the GitHub token readable in the cookie", () => {
    // The reason this is encrypted rather than signed. A signed token is public to whoever holds
    // it, and what they would be holding is a live credential for the customer's source control.
    const sealed = new SessionSealer(SECRET).seal(session());

    expect(sealed).not.toContain("gho_livecredential");
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain("gho_livecredential");
    expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain("octocat");
  });

  it("rejects a session sealed by a different instance", () => {
    const sealed = new SessionSealer(SECRET).seal(session());
    expect(new SessionSealer(OTHER).unseal(sealed)).toBeUndefined();
  });

  it("rejects tampering rather than throwing", () => {
    const sealer = new SessionSealer(SECRET);
    const sealed = sealer.seal(session());

    const raw = Buffer.from(sealed, "base64url");
    raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 0xff;

    expect(sealer.unseal(raw.toString("base64url"))).toBeUndefined();
  });

  it("rejects malformed and empty input", () => {
    const sealer = new SessionSealer(SECRET);
    for (const bad of [undefined, "", "not-base64url!!", "AAAA"]) {
      expect(sealer.unseal(bad)).toBeUndefined();
    }
  });

  it("rejects an expired session", () => {
    const sealer = new SessionSealer(SECRET);
    expect(sealer.unseal(sealer.seal(session({ exp: Date.now() - 1 })))).toBeUndefined();
  });
});

describe("oauth state", () => {
  it("accepts what it issued", () => {
    expect(verifyState(issueState(SECRET), SECRET)).toBe(true);
  });

  it("rejects a state signed with another secret", () => {
    expect(verifyState(issueState(OTHER), SECRET)).toBe(false);
  });

  it("rejects tampering with the nonce", () => {
    const [, issued, signature] = issueState(SECRET).split(".");
    expect(verifyState(`deadbeef.${issued}.${signature}`, SECRET)).toBe(false);
  });

  it("rejects malformed input", () => {
    for (const bad of [undefined, "", "a", "a.b", "a.b.c.d"]) {
      expect(verifyState(bad, SECRET)).toBe(false);
    }
  });

  it("expires after ten minutes", () => {
    const now = 1_000_000_000_000;
    const state = issueState(SECRET, now);

    expect(verifyState(state, SECRET, now + 9 * 60 * 1000)).toBe(true);
    expect(verifyState(state, SECRET, now + 11 * 60 * 1000)).toBe(false);
  });

  it("rejects a state stamped in the future", () => {
    const now = 1_000_000_000_000;
    expect(verifyState(issueState(SECRET, now + 60_000), SECRET, now)).toBe(false);
  });
});

// ---------------------------------------------------------------- github

const CONFIG = {
  clientId: "cid",
  clientSecret: "csecret",
  baseUrl: "https://strata.example.com/",
};

/** A fetch that answers from a script, and records what it was asked. */
function stubFetch(replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { impl, calls };
}

describe("GitHub Enterprise", () => {
  it("puts an Enterprise Server's API under /api/v3", () => {
    expect(apiUrlFor("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
    // A trailing slash must not become a double slash in every request that follows.
    expect(apiUrlFor("https://ghe.example.com/")).toBe("https://ghe.example.com/api/v3");
  });

  it("leaves the public GitHub on its separate API host", () => {
    // The public instance is the exception: api.github.com, not github.com/api/v3.
    expect(apiUrlFor("https://github.com")).toBe("https://api.github.com");
  });

  it("sends consent and API calls to the Enterprise Server", async () => {
    const config = { ...CONFIG, githubUrl: "https://ghe.example.com" };

    expect(new GitHubIdentity(config).authorizeUrl("st")).toContain(
      "https://ghe.example.com/login/oauth/authorize?",
    );

    const { impl, calls } = stubFetch([{ body: { id: 1, login: "someone" } }]);
    await new GitHubIdentity(config, impl).identify("tok");
    expect(calls[0]?.url).toBe("https://ghe.example.com/api/v3/user");
  });

  it("accepts an explicit API URL for an Enterprise Server that moved it", async () => {
    const { impl, calls } = stubFetch([{ body: { id: 1, login: "someone" } }]);
    await new GitHubIdentity(
      { ...CONFIG, githubUrl: "https://ghe.example.com", apiUrl: "https://api.ghe.example.com" },
      impl,
    ).identify("tok");

    expect(calls[0]?.url).toBe("https://api.ghe.example.com/user");
  });
});

describe("GitHubIdentity", () => {
  it("builds a consent URL that asks for private repositories", () => {
    const url = new URL(new GitHubIdentity(CONFIG).authorizeUrl("st4te"));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st4te");
    // `repo`, not `public_repo`: a company's models are in a private repository.
    expect(url.searchParams.get("scope")).toContain("repo");
    // The trailing slash on baseUrl must not become a double slash.
    expect(url.searchParams.get("redirect_uri")).toBe("https://strata.example.com/api/cloud/callback");
  });

  it("never puts the client secret in the consent URL", () => {
    expect(new GitHubIdentity(CONFIG).authorizeUrl("st4te")).not.toContain("csecret");
  });

  it("exchanges a code for a token", async () => {
    const { impl, calls } = stubFetch([{ body: { access_token: "gho_new" } }]);
    await expect(new GitHubIdentity(CONFIG, impl).exchangeCode("code123")).resolves.toBe("gho_new");
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
  });

  it("treats GitHub's 200-with-an-error as a failed sign-in", async () => {
    // GitHub answers a spent or reused code with 200 and an `error` field, so a plain `ok` check
    // would read that as success and continue with an undefined token.
    const { impl } = stubFetch([
      { status: 200, body: { error: "bad_verification_code", error_description: "code expired" } },
    ]);

    await expect(new GitHubIdentity(CONFIG, impl).exchangeCode("stale")).rejects.toMatchObject({
      status: 401,
      message: "code expired",
    });
  });

  it("reads an identity", async () => {
    const { impl } = stubFetch([
      { body: { id: 7, login: "octocat", name: "Mona", avatar_url: "https://img" } },
    ]);

    await expect(new GitHubIdentity(CONFIG, impl).identify("tok")).resolves.toEqual({
      id: 7,
      login: "octocat",
      name: "Mona",
      avatarUrl: "https://img",
    });
  });

  it("reports a revoked token as an expired sign-in", async () => {
    const { impl } = stubFetch([{ status: 401, body: {} }]);
    await expect(new GitHubIdentity(CONFIG, impl).identify("revoked")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("derives the role from repository permissions", async () => {
    const { impl } = stubFetch([
      {
        body: {
          full_name: "acme/models",
          private: true,
          default_branch: "trunk",
          clone_url: "https://github.com/acme/models.git",
          permissions: { push: true, pull: true },
        },
      },
    ]);

    await expect(new GitHubIdentity(CONFIG, impl).repoAccess("tok", "acme/models")).resolves.toEqual({
      fullName: "acme/models",
      private: true,
      defaultBranch: "trunk",
      cloneUrl: "https://github.com/acme/models.git",
      role: "editor",
    });
  });

  it("reports a repository it cannot see as no access, not as missing", async () => {
    // GitHub answers 404 for a private repository you cannot see. Repeating that distinction back
    // would confirm which private repositories exist to somebody guessing names.
    const { impl } = stubFetch([{ status: 404, body: {} }]);

    await expect(
      new GitHubIdentity(CONFIG, impl).repoAccess("tok", "acme/secret"),
    ).rejects.toMatchObject({ status: 403, message: "no access to `acme/secret`" });
  });

  it("offers only repositories the user can write to", async () => {
    // A read-only repository would produce a workspace where every save fails at the last step.
    const { impl } = stubFetch([
      {
        body: [
          { full_name: "acme/writable", private: false, clone_url: "a", permissions: { push: true } },
          { full_name: "acme/readonly", private: false, clone_url: "b", permissions: { pull: true } },
          { full_name: "acme/owned", private: true, clone_url: "c", permissions: { admin: true } },
        ],
      },
    ]);

    const repos = await new GitHubIdentity(CONFIG, impl).listRepos("tok");

    expect(repos.map((r) => r.fullName)).toEqual(["acme/writable", "acme/owned"]);
    expect(repos.map((r) => r.role)).toEqual(["editor", "admin"]);
    // Absent from the response, so it has to fall back rather than be undefined.
    expect(repos[0]?.defaultBranch).toBe("main");
  });
});
