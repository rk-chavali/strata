import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initRepo, status } from "./git.js";

const exec = promisify(execFile);

/**
 * `status()` against real repositories on disk.
 *
 * Same reasoning as `bootstrap.test.ts`: this module's entire job is to drive the `git`
 * binary and parse what comes back, so mocking git would assert only that the arguments
 * match what the test author expected, the implementation's own assumption, checked
 * twice. Real repositories are what catch the cases git actually behaves oddly in.
 *
 * The case that motivated this file is the **unborn HEAD**: a repository created but never
 * committed to. `rev-parse --abbrev-ref HEAD` resolves a revision, and there is no
 * revision yet, so it exits non-zero and took the whole status call down as a 400. That
 * used to be an unusual state to be in. Now that first-run setup offers to run `git init`,
 * it is the state *every* new instance starts in, and both the status bar and the Changes
 * panel read this call.
 */

/**
 * These tests shell out to real `git`, several times each.
 *
 * On Windows, and especially inside a OneDrive-synced tree, or on a machine also running
 * dev servers, a single `git` invocation regularly takes over a second, so a test that
 * runs six of them blows straight through vitest's 5s default. That is a slow machine, not
 * a broken assertion, and letting it fail teaches everyone to ignore a red suite.
 *
 * Generous rather than tuned: the number only has to be larger than the worst honest run.
 */
const GIT_TIMEOUT = 60_000;

let scratch: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

async function scratchDir(name: string): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "strata-git-"));
}, 60_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
});

describe("status", () => {
  it("reports a plain directory as not a repository", async () => {
    const dir = await scratchDir("plain");
    await writeFile(join(dir, "strata.config.yaml"), "name: nope\n", "utf8");

    const result = await status(dir);

    expect(result.isRepo).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.clean).toBe(true);
  }, GIT_TIMEOUT);

  it("reads the branch of a repository with no commits yet", async () => {
    const dir = await scratchDir("unborn");
    await initRepo(dir);

    const result = await status(dir);

    // The regression: this threw "ambiguous argument 'HEAD'" and surfaced as a 400.
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  }, GIT_TIMEOUT);

  it("lists untracked files in a repository with no commits yet", async () => {
    const dir = await scratchDir("unborn-files");
    await initRepo(dir);
    await writeFile(join(dir, "strata.config.yaml"), "name: fresh\n", "utf8");
    await mkdir(join(dir, "models"), { recursive: true });
    await writeFile(join(dir, "models", "thing.yaml"), "id: thing\nkind: entity\n", "utf8");

    const result = await status(dir);

    expect(result.clean).toBe(false);
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toEqual(["models/thing.yaml", "strata.config.yaml"]);
    // `--untracked-files=all` matters here: the default collapses the directory to
    // `models/`, which would hide every model file behind one entry in the Changes panel.
    expect(result.files.every((file) => file.label === "untracked")).toBe(true);
  }, GIT_TIMEOUT);

  it("names the branch after a first commit", async () => {
    const dir = await scratchDir("committed");
    await initRepo(dir);
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "user.name", "Test");
    await writeFile(join(dir, "strata.config.yaml"), "name: committed\n", "utf8");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "initial");

    const result = await status(dir);

    expect(result.isRepo).toBe(true);
    expect(result.branch).toBe("main");
    expect(result.clean).toBe(true);
    expect(result.files).toEqual([]);
  }, GIT_TIMEOUT);

  it("reports no branch on a detached HEAD rather than failing", async () => {
    const dir = await scratchDir("detached");
    await initRepo(dir);
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "user.name", "Test");
    await writeFile(join(dir, "strata.config.yaml"), "name: detached\n", "utf8");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "initial");
    await git(dir, "checkout", "--quiet", "--detach", "HEAD");

    const result = await status(dir);

    // Undefined, not a throw: the status bar renders this as "detached".
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBeUndefined();
  }, GIT_TIMEOUT);

  it("has no upstream on a fresh repository", async () => {
    const dir = await scratchDir("no-upstream");
    await initRepo(dir);

    const result = await status(dir);

    expect(result.upstream).toBeUndefined();
    expect(result.remoteUrl).toBeUndefined();
  }, GIT_TIMEOUT);
});

describe("initRepo", () => {
  it("creates a repository on the main branch", async () => {
    const dir = await scratchDir("init-main");
    await initRepo(dir);

    // Pinned explicitly, because git's own default comes from the host's
    // `init.defaultBranch`, so without the flag one machine gets `master` and another
    // `main`, and the branch names in propose URLs stop being predictable.
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir });
    expect(stdout.trim()).toBe("main");
  }, GIT_TIMEOUT);

  it("is safe to run twice", async () => {
    const dir = await scratchDir("init-twice");
    await initRepo(dir);
    await writeFile(join(dir, "keep.yaml"), "id: keep\n", "utf8");

    // A retry after a partially completed setup must not throw or discard work.
    await expect(initRepo(dir)).resolves.toBeUndefined();

    const result = await status(dir);
    expect(result.files.map((file) => file.path)).toContain("keep.yaml");
  }, GIT_TIMEOUT);
});
