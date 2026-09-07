import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseRoot } from "./workspaceroot.js";

/**
 * Can this deployment create a repository where it has been pointed?
 *
 * The question the setup screen never asked. It reported `needsInit` for any directory without a
 * config file, offered "Create repository" regardless, and let the operator discover the answer
 * by pressing the button and reading a 500.
 *
 * The case that motivated all of it is the last one here: Git Bash on Windows rewrites any
 * argument shaped like a Unix path, so `-e STRATA_WORKSPACE=/app/examples/quickstart` reaches the
 * container as a Windows host path. That is the one failure whose cause is *certain* from the
 * shape of the path alone, which is why it gets a named hint rather than a filesystem error.
 */

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "strata-root-"));
  scratch.push(dir);
  return dir;
}

describe("diagnoseRoot", () => {
  it("accepts a directory it can write to", async () => {
    const dir = await tempDir();
    expect(await diagnoseRoot(dir)).toEqual({ writable: true });
  });

  it("accepts a path that does not exist yet but whose parent is writable", async () => {
    // The ordinary first-run case: an empty mount, and a workspace directory to be created in it.
    const dir = await tempDir();
    const result = await diagnoseRoot(join(dir, "not", "created", "yet"));

    expect(result.writable).toBe(true);
  });

  it("leaves no probe directory behind in somebody's repository", async () => {
    /*
      The check works by creating a directory and removing it, because `access(W_OK)` reports mode
      bits and lies on overlays and unusual uids. A probe left behind would appear in `git status`
      inside a customer's model repo, which is a worse bug than the one being detected.
    */
    const dir = await tempDir();
    await diagnoseRoot(dir);

    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses an empty path rather than treating it as the current directory", async () => {
    const result = await diagnoseRoot("   ");

    expect(result.writable).toBe(false);
    expect(result.reason).toContain("STRATA_WORKSPACE is empty");
  });

  it("refuses a path whose parent is a file, and names the filesystem code", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "notadir");
    await writeFile(blocker, "a file, not a directory", "utf8");

    const result = await diagnoseRoot(join(blocker, "workspace"));

    expect(result.writable).toBe(false);
    // The code is in the reason, so an operator can search for it.
    expect(result.reason).toMatch(/ENOTDIR|EEXIST|ENOENT/);
  });

  it("names shell mangling when a Windows drive letter appears inside the path", async () => {
    /*
      The exact value observed in the wild, from running the documented `docker run` in Git Bash.
      A drive letter mid-path cannot be a real path on Linux and cannot be one on Windows either,
      where a legitimate root already begins with it. So this is diagnosable with certainty, and
      the fix is one character: a relative `STRATA_WORKSPACE`.
    */
    const result = await diagnoseRoot("/app/C:/Program Files/Git/app/examples/quickstart");

    expect(result.writable).toBe(false);
    expect(result.hint).toContain("Git Bash");
    expect(result.hint).toContain("examples/quickstart");
    // Named before anything touches the filesystem: the path is nonsense, not merely unwritable.
    expect(result.reason).toContain("not a path inside this container");
  });

  it("does not mistake a legitimate Windows root for mangling", async () => {
    // `C:\Users\...` on a Windows host is a real path. Only a drive letter *inside* one is not.
    const dir = await tempDir();
    const result = await diagnoseRoot(dir);

    expect(result.writable).toBe(true);
    expect(result.hint).toBeUndefined();
  });
});
