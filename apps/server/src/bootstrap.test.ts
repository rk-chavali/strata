import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapWorkspace, validateCloneUrl } from "./bootstrap.js";

const exec = promisify(execFile);

/**
 * Clones and checkouts are slow, and slower still on Windows or inside a synced folder.
 *
 * `beforeAll` already asked for 60s; the individual tests were left on vitest's 5s default,
 * which held only while the machine was idle. Under any real load, dev servers running, a
 * browser open, they time out and the suite goes red for reasons that have nothing to do
 * with the code under test.
 */
const GIT_TIMEOUT = 60_000;

/**
 * Bootstrap is tested against a real local repository, not a mock.
 *
 * The whole job of this module is to drive the `git` binary correctly, so a mocked git
 * would only assert that the arguments match what the test author expected, which is the
 * same assumption the implementation makes, tested twice. A bare repo on disk exercises
 * the real thing and still runs offline in under a second.
 */

let origin: string;
let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "strata-bootstrap-"));

  // A source repo with the one file that makes a directory a strata workspace.
  const source = join(scratch, "source");
  await mkdir(source, { recursive: true });
  await git(source, "init", "--quiet", "--initial-branch=main");
  await git(source, "config", "user.email", "test@example.com");
  await git(source, "config", "user.name", "Test");
  await writeFile(join(source, "strata.config.yaml"), "name: test-models\n", "utf8");
  await mkdir(join(source, "models"), { recursive: true });
  await writeFile(join(source, "models", "thing.yaml"), "id: thing\nkind: entity\n", "utf8");
  await git(source, "add", "-A");
  await git(source, "commit", "--quiet", "-m", "initial");

  // A second branch, so branch selection can be tested.
  await git(source, "branch", "release");

  // Clone it bare to act as the "remote". A file:// URL is a real remote to git, which
  // means the clone path under test is the same one a https:// remote takes.
  origin = join(scratch, "origin.git");
  await exec("git", ["clone", "--quiet", "--bare", source, origin]);
}, 60_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

/** `file://` needs forward slashes and a leading slash on Windows drive paths. */
function fileUrl(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  return `file:///${normalised.replace(/^\/+/, "")}`;
}

describe("bootstrapWorkspace", () => {
  it("clones into an empty directory", async () => {
    const workspace = join(scratch, "clone-empty");
    await mkdir(workspace, { recursive: true });

    const result = await bootstrapWorkspace({
      workspace,
      repo: fileUrl(origin),
      log: () => {},
    });

    expect(result.action).toBe("cloned");
    expect(existsSync(join(workspace, "strata.config.yaml"))).toBe(true);
    expect(existsSync(join(workspace, "models", "thing.yaml"))).toBe(true);
  }, GIT_TIMEOUT);

  it("creates the directory when it does not exist at all", async () => {
    const workspace = join(scratch, "nested", "deep", "clone");

    const result = await bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} });

    expect(result.action).toBe("cloned");
    expect(existsSync(join(workspace, "strata.config.yaml"))).toBe(true);
  }, GIT_TIMEOUT);

  it("checks out the requested branch", async () => {
    const workspace = join(scratch, "clone-branch");

    await bootstrapWorkspace({
      workspace,
      repo: fileUrl(origin),
      branch: "release",
      log: () => {},
    });

    const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: workspace });
    expect(stdout.trim()).toBe("release");
  }, GIT_TIMEOUT);

  /**
   * The most important test here.
   *
   * A persisted volume can hold a checkout with uncommitted work someone is midway
   * through. Re-cloning or resetting over it on every pod restart would destroy exactly
   * the work the tool promises is safe.
   */
  it("leaves an existing checkout completely alone", async () => {
    const workspace = join(scratch, "existing");
    await bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} });

    // Simulate work in progress: an uncommitted edit and an untracked file.
    await writeFile(join(workspace, "strata.config.yaml"), "name: locally-edited\n", "utf8");
    await writeFile(join(workspace, "scratch.yaml"), "id: wip\n", "utf8");

    const result = await bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} });

    expect(result.action).toBe("existing");
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: workspace });
    expect(stdout).toContain("strata.config.yaml");
    expect(stdout).toContain("scratch.yaml");
  }, GIT_TIMEOUT);

  it("does nothing when no repo is configured", async () => {
    const workspace = join(scratch, "unconfigured");
    await mkdir(workspace, { recursive: true });

    const result = await bootstrapWorkspace({ workspace, repo: undefined, log: () => {} });

    expect(result.action).toBe("skipped");
  }, GIT_TIMEOUT);

  it("refuses a non-empty directory that is not a checkout", async () => {
    const workspace = join(scratch, "occupied");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "someone-elses-file.txt"), "hello", "utf8");

    await expect(
      bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} }),
    ).rejects.toThrow(/not empty/);
  }, GIT_TIMEOUT);

  /** A volume frequently arrives with `lost+found`; that must not count as occupied. */
  it("treats a volume containing only lost+found as empty", async () => {
    const workspace = join(scratch, "fresh-volume");
    await mkdir(join(workspace, "lost+found"), { recursive: true });

    const result = await bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} });

    expect(result.action).toBe("cloned");
  }, GIT_TIMEOUT);

  /**
   * A deployment may legitimately clone over SSH with a mounted deploy key, so the
   * bootstrap path must accept it, unlike the UI's remote field, which is https-only
   * because the *token* it stores cannot authenticate SSH.
   */
  it("accepts an SSH remote, which a mounted deploy key can authenticate", () => {
    expect(validateCloneUrl("git@github.com:owner/repo.git")).toEqual({
      ok: true,
      url: "git@github.com:owner/repo.git",
    });
    expect(validateCloneUrl("ssh://git@github.com/owner/repo.git").ok).toBe(true);
  }, GIT_TIMEOUT);

  it("rejects a protocol git cannot clone, and says which", () => {
    const result = validateCloneUrl("ftp://example.com/repo.git");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ftp/);
  }, GIT_TIMEOUT);

  it("strips credentials from a URL before using it", () => {
    // Someone will paste a URL copied from a CI config with the token embedded.
    const result = validateCloneUrl("https://x-access-token:ghp_secret@github.com/o/r.git");
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.url).toBe("https://github.com/o/r.git");
  }, GIT_TIMEOUT);

  it("explains a git repo that is not a strata workspace, rather than cloning over it", async () => {
    const workspace = join(scratch, "wrong-repo");
    await mkdir(workspace, { recursive: true });
    await git(workspace, "init", "--quiet");

    await expect(
      bootstrapWorkspace({ workspace, repo: fileUrl(origin), log: () => {} }),
    ).rejects.toThrow(/strata\.config\.yaml/);
  }, GIT_TIMEOUT);

  it("sets a committer identity, without which git commit fails outright", async () => {
    const workspace = join(scratch, "identity");

    await bootstrapWorkspace({
      workspace,
      repo: fileUrl(origin),
      author: { name: "Deploy Bot", email: "deploy@example.com" },
      log: () => {},
    });

    const name = await exec("git", ["config", "user.name"], { cwd: workspace });
    const email = await exec("git", ["config", "user.email"], { cwd: workspace });
    expect(name.stdout.trim()).toBe("Deploy Bot");
    expect(email.stdout.trim()).toBe("deploy@example.com");
  }, GIT_TIMEOUT);

  it("reports a clone failure without leaking the token", async () => {
    const workspace = join(scratch, "bad-remote");

    /**
     * An unreachable local address, not a real GitHub URL.
     *
     * This test previously cloned from `github.com/this-owner-does-not-exist-strata/nope.git`,
     * which made it the only test in the suite needing network access, and its duration
     * GitHub's to decide. It took 36 seconds alone and exceeded its 60-second budget under
     * parallel load, so the suite went red for reasons unrelated to any code.
     *
     * Port 1 refuses instantly, and the code path under test is identical: the clone fails, an
     * error is built from git's stderr, and the token embedded in the URL must not appear in it.
     * What is being verified is the redaction, not GitHub's 404.
     */
    const error = await bootstrapWorkspace({
      workspace,
      repo: "https://127.0.0.1:1/nope.git",
      token: "ghp_supersecrettokenvalue",
      log: () => {},
    }).catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("ghp_supersecrettokenvalue");
  }, GIT_TIMEOUT);
});
