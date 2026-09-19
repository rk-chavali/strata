import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { authEnv, stripCredentials } from "./gitcreds.js";

const exec = promisify(execFile);

/**
 * Get a model repository onto disk before the server starts reading it.
 *
 * The tool has always assumed the workspace is *already* a git checkout, because the
 * supported shape was a bind mount: you clone the repo on the host, mount it at
 * `/workspace`, and the container reads it. That works for Docker Compose and for anyone
 * with a persistent host filesystem.
 *
 * It does not work for a platform-as-a-service deployment. Render, Cloud Run, Fly and the
 * rest give you a container and a disk, there is no host checkout to mount. So the
 * workspace starts empty, `loadWorkspace` cannot find `strata.config.yaml`, and the app boots
 * straight into "Cannot read the model repo" with no way out from inside the UI.
 *
 * This closes that gap: point `STRATA_MODEL_REPO` at an HTTPS git URL and the container
 * clones it on startup. That is also the shape "bring your own repository" actually takes
 * for a hosted instance, the deployment supplies a repo URL and a token, and everything
 * else follows.
 *
 * Three rules it follows, each one a way this could go wrong:
 *
 *   1. **Never touch an existing checkout.** If the workspace already holds a repo, this
 *      does nothing at all, not even a fetch. On a persisted disk that checkout may
 *      contain uncommitted edits someone is midway through, and silently resetting or
 *      pulling over them would destroy work that the tool's whole premise says is safe.
 *   2. **Refuse a non-empty directory that is not a repo.** Cloning into it would fail
 *      confusingly, or worse, half-succeed. Say so plainly instead.
 *   3. **Never log the token.** The URL is echoed for operators to check, so it is
 *      stripped of credentials first, someone will paste a URL with a token in it.
 */

/**
 * What a *deployment* may clone from, deliberately looser than what the UI may set.
 *
 * `validateRemoteUrl` in gitcreds is https-only, and correctly so: it guards the URL an
 * admin pastes into Settings, which has to be something the stored **token** can
 * authenticate. A token cannot authenticate an SSH remote, so accepting one there would
 * store a remote that fails at the next push with a confusing error.
 *
 * The deployment path has different credentials available. Compose already mounts
 * `~/.ssh` read-only, and the self-hosting guide explicitly promises that an existing SSH
 * agent, deploy key or credential helper keeps working. Applying the strict rule here
 * would break that promise and reject a perfectly good `git@github.com:org/models.git`.
 *
 * So: accept anything git itself can clone, and let git report the failure if the
 * credential is missing. The operator supplying this value is trusted, they wrote the
 * Helm values.
 */
export function validateCloneUrl(
  url: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const clean = stripCredentials(url);
  if (!clean) return { ok: false, error: "a repository URL is required" };

  // scp-style (`git@host:org/repo.git`) and explicit ssh:// both authenticate with a key.
  if (/^[^@\s]+@[^:\s]+:/.test(clean) || clean.startsWith("ssh://")) {
    return { ok: true, url: clean };
  }

  // `file://` is a real remote to git. It is how the tests exercise the actual clone path
  // offline, and it is legitimate for a checkout mounted elsewhere in the same pod.
  if (clean.startsWith("file://")) return { ok: true, url: clean };

  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return { ok: false, error: `\`${clean}\` is not a URL git can clone` };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: `\`${parsed.protocol}\` is not supported, use https://, ssh:// or git@host:org/repo`,
    };
  }
  if (!/^\/[^/]+\/[^/]+/.test(parsed.pathname)) {
    return { ok: false, error: "the URL should look like https://host/owner/repo.git" };
  }

  return { ok: true, url: clean };
}

export interface BootstrapOptions {
  /** Where the checkout should end up. `STRATA_WORKSPACE`. */
  workspace: string;
  /** HTTPS URL of the model repository. `STRATA_MODEL_REPO`. Absent disables bootstrap. */
  repo: string | undefined;
  /** Branch to check out. `STRATA_MODEL_BRANCH`. Absent uses the remote's default. */
  branch?: string | undefined;
  /** Token for a private repository, resolved the same way as everything else. */
  token?: string | undefined;
  /** Committer identity baked into the clone, so `git commit` cannot fail for want of one. */
  author?: { name: string; email: string } | undefined;
  /** Where to report progress. Injected so tests can capture it. */
  log?: (message: string) => void;
}

export type BootstrapResult =
  | { action: "existing"; reason: string }
  | { action: "cloned"; repo: string; branch?: string }
  | { action: "skipped"; reason: string };

/** True when the path holds something that looks like a strata workspace. */
async function isWorkspace(path: string): Promise<boolean> {
  try {
    await stat(`${path}/strata.config.yaml`);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(`${path}/.git`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Entries that do not make a directory meaningfully non-empty.
 *
 * A mounted volume frequently arrives with `lost+found`, and macOS bind mounts bring
 * `.DS_Store`. Treating either as "someone already put something here" would refuse to
 * clone into a perfectly fresh disk.
 */
const IGNORABLE = new Set(["lost+found", ".DS_Store", "Thumbs.db"]);

async function isEffectivelyEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.filter((entry) => !IGNORABLE.has(entry)).length === 0;
  } catch {
    // Missing entirely counts as empty, it will be created.
    return true;
  }
}

export async function bootstrapWorkspace(options: BootstrapOptions): Promise<BootstrapResult> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));

  // Rule 1: an existing checkout is authoritative and untouched.
  if (await isWorkspace(options.workspace)) {
    return { action: "existing", reason: "the workspace already contains strata.config.yaml" };
  }

  if (!options.repo) {
    return {
      action: "skipped",
      reason: "no STRATA_MODEL_REPO is set, and the workspace is not a checkout",
    };
  }

  const validated = validateCloneUrl(options.repo);
  if (!validated.ok) {
    throw new Error(`STRATA_MODEL_REPO is not usable: ${validated.error}`);
  }
  const url = validated.url;
  const safeUrl = stripCredentials(url);

  if (await isGitRepo(options.workspace)) {
    // A repo but no config: either the wrong repository, or a checkout of a branch that
    // predates the config. Both need a human, and cloning over it would lose whatever is
    // there.
    throw new Error(
      `${options.workspace} is a git repository but has no strata.config.yaml at its root. ` +
        `Check that STRATA_MODEL_REPO points at a model repo, or run \`strata init\` in it.`,
    );
  }

  if (!(await isEffectivelyEmpty(options.workspace))) {
    // Rule 2.
    throw new Error(
      `${options.workspace} is not empty and is not a git checkout, so cloning into it ` +
        `would be unsafe. Empty it, or mount an existing clone there instead.`,
    );
  }

  await mkdir(options.workspace, { recursive: true });

  log(`cloning ${safeUrl}${options.branch ? ` (branch ${options.branch})` : ""} into ${options.workspace}`);

  const env = await authEnv(options.token);

  try {
    /**
     * `init` + `fetch` + `checkout`, not `clone`.
     *
     * `git clone` refuses any destination that is not *literally* empty, and a real
     * PersistentVolume rarely is: ext4 gives every volume a `lost+found`, so the very
     * first deploy to a real cluster would fail with "destination path already exists and
     * is not an empty directory". Tolerating that entry above is pointless if git then
     * applies its own stricter rule, which is exactly what the test caught.
     *
     * This sequence produces an identical result and does not care what else is in the
     * directory. The full history is fetched deliberately: a model repo is YAML, so it is
     * cheap, and a shallow clone complicates pushing a branch and opening a pull request
     * from it later.
     */
    await exec("git", ["init", "--quiet", options.workspace], { env });
    await exec("git", ["remote", "add", "origin", url], { cwd: options.workspace, env });
    await exec("git", ["fetch", "--quiet", "origin"], {
      cwd: options.workspace,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });

    /**
     * Resolve the branch to land on.
     *
     * `set-head --auto` asks the remote which branch its HEAD points at, so a repo whose
     * default is `master`, `develop` or anything else works without configuration. Only
     * then fall back to `main`, which is a guess of last resort rather than an assumption.
     */
    let branch = options.branch;
    if (!branch) {
      await exec("git", ["remote", "set-head", "origin", "--auto"], {
        cwd: options.workspace,
        env,
      }).catch(() => {});
      const { stdout } = await exec(
        "git",
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd: options.workspace, env },
      ).catch(() => ({ stdout: "" }));
      branch = stdout.trim().replace(/^origin\//, "") || "main";
    }

    // `-B` so a re-run onto an existing local branch resets it to the remote rather than
    // failing, which matters if a previous boot got part-way through.
    await exec("git", ["checkout", "-B", branch, `origin/${branch}`], {
      cwd: options.workspace,
      env,
    });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = (err.stderr ?? "").trim();
    let message = `could not clone ${safeUrl}: ${stderr || err.message || "git clone failed"}`;

    /**
     * Belt and braces on the token.
     *
     * It should never appear: authentication travels in the environment via GIT_ASKPASS,
     * and the URL is stripped of credentials above. But this string lands in a log an
     * operator will paste into a ticket, so a redaction pass is cheap insurance against a
     * future code path that is less careful.
     *
     * Guarded on the token actually existing. The previous form was
     * `replace(options.token ?? " ", "<token>")`, which on a deployment with no token
     * substituted the first *space* in the message, quietly corrupting every clone error
     * it was supposed to be protecting.
     */
    if (options.token) message = message.split(options.token).join("<redacted>");
    throw new Error(message);
  }

  /**
   * Set a committer identity inside the clone.
   *
   * `git commit` fails outright without one, and a container has no global config worth
   * relying on. Written at repository scope rather than globally so it cannot leak into
   * another checkout on a shared disk. A signed-in user's own name still overrides this
   * per commit via `--author`.
   */
  const author = options.author ?? { name: "strata", email: "strata@localhost" };
  await exec("git", ["config", "user.name", author.name], { cwd: options.workspace });
  await exec("git", ["config", "user.email", author.email], { cwd: options.workspace });

  /**
   * Mark the checkout safe.
   *
   * git refuses to operate on a repository owned by a different uid, which is the normal
   * case for a mounted volume written by the platform and read by an unprivileged
   * container user. Without this every subsequent git call fails with "dubious ownership".
   */
  await exec("git", ["config", "--global", "--add", "safe.directory", options.workspace]).catch(
    () => {
      // Non-fatal: it usually already applies, and failing here would block a boot that
      // would otherwise work fine.
    },
  );

  log(`cloned ${safeUrl}`);
  return {
    action: "cloned",
    repo: safeUrl,
    ...(options.branch ? { branch: options.branch } : {}),
  };
}
