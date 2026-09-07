import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authEnv } from "./gitcreds.js";

const exec = promisify(execFile);

/**
 * Git operations, and raising a pull request.
 *
 * Shelling out to the `git` binary rather than using a JS implementation is a
 * deliberate choice: it inherits the user's existing credential helper, SSH agent,
 * signing config and hooks. A self-hosted enterprise deployment will already have
 * those set up, and reimplementing authentication is a good way to break in
 * exactly the environments we most need to work in.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
    /**
     * Trailing whitespace only, leading whitespace is data.
     *
     * `git status --porcelain` emits `XY PATH`, where an unstaged modification has a
     * *space* in the first column. Trimming the whole output ate that space on the first
     * line, so the parser's fixed `slice(3)` then ate the first character of the path:
     * `models/…` arrived as `odels/…`.
     *
     * The effect was invisible in the Changes panel, which only prints the path, and
     * broke every consumer that matches paths, which is why an edited table never
     * showed as changed in the model tree.
     */
    return stdout.replace(/\s+$/, "");
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const stderr = (err.stderr ?? "").trim();
    throw new GitError(
      stderr || err.message || `git ${args[0]} failed`,
      `git ${args.join(" ")}`,
      // The command is echoed back to the user, so it must never carry the token. It
      // does not: authentication travels in the environment, not in these arguments.
      stderr,
    );
  }
}

/**
 * Turn a directory into a git repository.
 *
 * Used by the setup flow, which offers this rather than assuming it: the directory may
 * already sit inside a parent repository, and creating a nested one there would quietly
 * detach the model files from the history the operator expected them in.
 *
 * `--initial-branch=main` is explicit because git's default depends on the host's
 * `init.defaultBranch`, and a fresh instance branching from `master` on one machine and
 * `main` on another makes the branch names in propose URLs unpredictable.
 *
 * Idempotent: `git init` on an existing repository is a no-op that reports the fact, so
 * a retry after a partial setup does no damage.
 */
export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "--quiet", "--initial-branch=main"]);
}

/** Point `origin` at a repository, adding the remote or replacing the existing one. */
export async function setRemote(cwd: string, url: string): Promise<void> {
  const existing = await git(cwd, ["remote"]).catch(() => "");
  const hasOrigin = existing.split("\n").some((name) => name.trim() === "origin");
  await git(cwd, hasOrigin ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
}

export interface BranchList {
  current: string;
  /** Branches that exist locally, whether or not they have been pushed. */
  local: string[];
  /** Branches that exist on `origin`, without the `origin/` prefix. */
  remote: string[];
  defaultBranch?: string;
}

/**
 * Every branch this repo knows about, local and remote, kept apart.
 *
 * The distinction is the whole point. A branch that exists locally but not on the
 * remote cannot be the base of a pull request until it is pushed, which is exactly the
 * situation a repo gets into when the first thing anyone pushed was a feature branch.
 */
export async function listBranches(cwd: string, defaultBranch?: string): Promise<BranchList> {
  const current = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

  const localRaw = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const local = localRaw.split("\n").map((line) => line.trim()).filter(Boolean);

  const remoteRaw = await git(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin",
  ]).catch(() => "");
  const remote = remoteRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => name.replace(/^origin\//, ""))
    // `origin/HEAD` is a pointer to another branch, not a branch of its own.
    .filter((name) => name !== "HEAD");

  return { current, local, remote, ...(defaultBranch ? { defaultBranch } : {}) };
}

/**
 * Ask GitHub which branch is actually the default.
 *
 * `refs/remotes/origin/HEAD` is the local answer, and it is unreliable: git only writes
 * it during `clone`. A repository connected with `remote add` never has it, so the
 * fallback chain used to land on the literal string `main`, and if the repo has no
 * `main`, every pull request is opened against a branch that does not exist, which
 * GitHub rejects with a message that does not mention the base at all.
 *
 * The API knows. It is one request, and it is authoritative even for a repo whose
 * default is `master`, `develop`, or whatever branch happened to be pushed first.
 */
export async function fetchDefaultBranch(
  github: { owner: string; repo: string; host: string },
  token: string | undefined,
): Promise<string | undefined> {
  if (!token) return undefined;

  const apiBase =
    github.host === "github.com" ? "https://api.github.com" : `https://${github.host}/api/v3`;

  try {
    const response = await fetch(`${apiBase}/repos/${github.owner}/${github.repo}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { default_branch?: string };
    return body.default_branch;
  } catch {
    // Offline, or an enterprise host that blocks the API. The caller falls back.
    return undefined;
  }
}

/** Push a local branch to `origin` without switching to it. */
export async function publishBranch(
  cwd: string,
  branch: string,
  token: string | undefined,
): Promise<void> {
  await git(cwd, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], await authEnv(token));
}

/** Detach `origin`. Used to roll back a remote that turned out to be unreachable. */
export async function removeRemote(cwd: string): Promise<void> {
  await git(cwd, ["remote", "remove", "origin"]).catch(() => undefined);
}

/**
 * Check that the credentials actually reach the remote.
 *
 * `git ls-remote` is the cheapest call that exercises the whole path, network, URL and
 * token, without fetching objects or touching the working tree. Doing it when the
 * remote is set means a bad token is reported while the user is looking at the field
 * they typed it into, rather than three steps later on top of a finished commit.
 */
export async function checkRemoteAccess(
  cwd: string,
  token: string | undefined,
): Promise<{ ok: true; defaultBranch?: string } | { ok: false; error: string }> {
  try {
    const env = await authEnv(token);
    const output = await git(cwd, ["ls-remote", "--symref", "origin", "HEAD"], env);
    const head = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
    return head?.[1] ? { ok: true, defaultBranch: head[1] } : { ok: true };
  } catch (error) {
    const message = error instanceof GitError ? error.stderr || error.message : String(error);
    // Git's own wording here is unusually opaque about the actual cause.
    if (/authentication failed|could not read Username|403/i.test(message)) {
      return {
        ok: false,
        error: "the remote rejected these credentials, check the token has access to this repository",
      };
    }
    if (/not found|repository .* not found|404/i.test(message)) {
      return { ok: false, error: "that repository does not exist, or the token cannot see it" };
    }
    return { ok: false, error: message };
  }
}

export interface ChangedFile {
  path: string;
  /** Porcelain status pair, e.g. ` M`, `??`, `A `. */
  code: string;
  label: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  /** Upstream tracking branch, when one is set. */
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: ChangedFile[];
  remoteUrl?: string;
  /** Parsed `owner/repo` when the remote is a GitHub URL. */
  github?: { owner: string; repo: string; host: string };
  defaultBranch?: string;
}

export async function status(cwd: string): Promise<GitStatus> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false, ahead: 0, behind: 0, clean: true, files: [] };
  }

  /**
   * The branch name, on a repository that may have no commits yet.
   *
   * `rev-parse --abbrev-ref HEAD` resolves a *revision*, so on a freshly initialised
   * repository it fails outright, "ambiguous argument 'HEAD': unknown revision", and
   * took the whole status call down with it as a 400. That state used to be rare enough to
   * miss; now that setup offers `git init`, an empty repository with an unborn HEAD is
   * what every new instance starts as, and the Changes panel and status bar both read this.
   *
   * `symbolic-ref --short HEAD` reads the ref HEAD *points at* without resolving it, which
   * is exactly the question being asked and works before the first commit. It only fails
   * on a genuinely detached HEAD, where falling through to undefined is correct, the
   * status bar already renders that as "detached".
   */
  let branch: string | undefined;
  try {
    branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    // Detached HEAD: no branch to name.
  }

  const porcelain = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = porcelain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseStatusLine);

  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  try {
    upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    behind = Number(behindRaw ?? 0);
    ahead = Number(aheadRaw ?? 0);
  } catch {
    // No upstream yet, normal for a branch that has not been pushed.
  }

  let remoteUrl: string | undefined;
  try {
    remoteUrl = await git(cwd, ["remote", "get-url", "origin"]);
  } catch {
    // No origin configured; commits still work, PRs do not.
  }

  let defaultBranch: string | undefined;
  try {
    const ref = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = ref.replace("refs/remotes/origin/", "");
  } catch {
    // Not always present; the caller falls back to `main`.
  }

  const github = remoteUrl ? parseGitHubRemote(remoteUrl) : undefined;

  return {
    isRepo: true,
    ...(branch ? { branch } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    clean: files.length === 0,
    files,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(github ? { github } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function parseStatusLine(line: string): ChangedFile {
  const code = line.slice(0, 2);
  let path = line.slice(3).trim();
  // Renames are reported as `old -> new`; the new path is what matters here.
  const arrow = path.indexOf(" -> ");
  if (arrow >= 0) path = path.slice(arrow + 4);
  path = path.replace(/^"|"$/g, "");

  const label: ChangedFile["label"] =
    code === "??"
      ? "untracked"
      : code.includes("D")
        ? "deleted"
        : code.includes("R")
          ? "renamed"
          : code.includes("A")
            ? "added"
            : "modified";

  return { path, code, label, staged: code[0] !== " " && code !== "??" };
}

/** Recognise GitHub remotes in both SSH and HTTPS form, including GHE hosts. */
export function parseGitHubRemote(url: string): { owner: string; repo: string; host: string } | undefined {
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return { host: ssh[1]!, owner: ssh[2]!, repo: ssh[3]! };

  const https = /^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (https) return { host: https[1]!, owner: https[2]!, repo: https[3]! };

  return undefined;
}

/**
 * Stamp the proposing user onto a pull request title: `Add customer dimension | alice`.
 *
 * The GitHub token is one shared credential for the whole instance, so on GitHub every
 * pull request this tool opens is authored by the same bot account. Without a stamp,
 * "who changed the customer grain?" has no answer on the PR list, which is exactly
 * where reviewers look.
 *
 * The commit does carry `--author`, but that address is synthesised (`alice@strata.local`)
 * precisely because we must not invent someone's real email, so GitHub shows it as an
 * unlinked name and it never appears in the PR list at all. The title is the one field
 * that is always visible and always searchable: `is:pr "| alice"` returns their work.
 */
export function attributeTitle(title: string, username: string | undefined): string {
  const clean = title.trim();
  if (!username) return clean;

  const stamp = `| ${username}`;
  // Reusing a branch re-proposes onto the same PR, and the client may hand back a title
  // it read from the previous round. Appending again each time would ratchet.
  if (clean.endsWith(stamp)) return clean;
  return `${clean} ${stamp}`;
}

export interface ProposeOptions {
  cwd: string;
  /** Branch to put the changes on. Created if it does not exist. */
  branch: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  /** Base branch for the PR. Defaults to the remote's default branch, then `main`. */
  base?: string;
  /**
   * Push the base branch first when it exists locally but not on the remote.
   *
   * The common case is a repo whose first push was a feature branch: `main` is sitting
   * on disk, GitHub has never seen it, and there is nothing to open a pull request
   * against. Opt-in rather than automatic, because publishing a branch to a shared
   * remote is not something to do on someone's behalf without asking.
   */
  publishBase?: boolean;
  /** Restrict the commit to these paths. Empty means everything that changed. */
  paths?: string[];
  author?: { name: string; email: string };
  githubToken?: string;
}

export interface ProposeResult {
  branch: string;
  base: string;
  commit?: string;
  pushed: boolean;
  /** Set when a PR was created through the API. */
  pullRequestUrl?: string;
  /**
   * Set when we could not create the PR ourselves, the user can click this to
   * open GitHub's own "open a pull request" form with the branches prefilled.
   */
  compareUrl?: string;
  warnings: string[];
}

/**
 * Branch, commit, push and open a pull request.
 *
 * The whole point of a git-native tool: an edit in the UI becomes a reviewable
 * pull request, not a mutation in a database nobody can audit.
 *
 * When no GitHub token is configured we stop after the push and hand back a
 * compare URL rather than failing. Requiring a token to get any value out of this
 * would be a poor trade, the push is the hard part, and opening the PR form is
 * one click.
 */
export async function propose(options: ProposeOptions): Promise<ProposeResult> {
  const { cwd, branch } = options;
  const warnings: string[] = [];

  const current = await status(cwd);
  if (!current.isRepo) {
    throw new GitError("this workspace is not a git repository", "git rev-parse", "");
  }
  if (current.clean) {
    throw new GitError("there is nothing to commit", "git status", "");
  }

  const base = options.base ?? current.defaultBranch ?? "main";
  if (base === branch) {
    throw new GitError(
      `the base and the new branch are both \`${branch}\`, a pull request needs two different branches`,
      "propose",
      "",
    );
  }

  /**
   * Make sure the base exists on the remote before doing any work.
   *
   * Checked up front, not after the commit. Everything below this point is hard to
   * undo, a branch, a commit, a push, and discovering then that there is nothing to
   * merge into leaves the user with a branch they did not want and no pull request.
   */
  const branches = await listBranches(cwd);
  if (!branches.remote.includes(base)) {
    if (!branches.local.includes(base)) {
      throw new GitError(
        `there is no branch \`${base}\` on the remote or locally; pick a different base`,
        "propose",
        "",
      );
    }
    if (!options.publishBase) {
      throw new GitError(
        `\`${base}\` exists locally but has never been pushed, so there is nothing to open a pull request against`,
        "propose",
        "",
      );
    }
    await publishBranch(cwd, base, options.githubToken);
    warnings.push(`pushed \`${base}\` to the remote, since it was not there yet`);
  }

  // Reuse the branch if it already exists, so a second round of edits lands on the
  // same PR rather than orphaning the first.
  const existing = await branchExists(cwd, branch);
  if (existing) {
    if (current.branch !== branch) await git(cwd, ["checkout", branch]);
  } else {
    await git(cwd, ["checkout", "-b", branch]);
  }

  if (options.paths?.length) {
    await git(cwd, ["add", "--", ...options.paths]);
  } else {
    await git(cwd, ["add", "--all"]);
  }

  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (staged.trim().length === 0) {
    throw new GitError("nothing was staged; the changed files may be ignored", "git add", "");
  }

  const commitArgs = ["commit", "-m", options.commitMessage];
  if (options.author) {
    commitArgs.push("--author", `${options.author.name} <${options.author.email}>`);
  }
  await git(cwd, commitArgs);
  const commit = await git(cwd, ["rev-parse", "HEAD"]);

  let pushed = false;
  if (current.remoteUrl) {
    try {
      // The same token that opens the pull request authenticates the push, so a
      // deployment needs one credential rather than a token here and a deploy key or
      // credential helper configured separately inside the container.
      await git(cwd, ["push", "--set-upstream", "origin", branch], await authEnv(options.githubToken));
      pushed = true;
    } catch (error) {
      warnings.push(`push failed: ${error instanceof GitError ? error.message : String(error)}`);
    }
  } else {
    warnings.push("no `origin` remote is configured, so the commit stays local");
  }

  const result: ProposeResult = { branch, base, commit, pushed, warnings };

  if (!pushed || !current.github) return result;

  const compareUrl = `https://${current.github.host}/${current.github.owner}/${current.github.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;

  if (!options.githubToken) {
    warnings.push("no GitHub token configured, so the pull request was not opened automatically");
    return { ...result, compareUrl };
  }

  try {
    const url = await createPullRequest({
      github: current.github,
      token: options.githubToken,
      title: options.prTitle,
      body: options.prBody,
      head: branch,
      base,
    });
    return { ...result, pullRequestUrl: url, compareUrl };
  } catch (error) {
    warnings.push(`could not open the pull request: ${error instanceof Error ? error.message : String(error)}`);
    return { ...result, compareUrl };
  }
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function createPullRequest(args: {
  github: { owner: string; repo: string; host: string };
  token: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<string> {
  // GitHub Enterprise puts the API under /api/v3 on the same host.
  const apiBase =
    args.github.host === "github.com"
      ? "https://api.github.com"
      : `https://${args.github.host}/api/v3`;

  const response = await fetch(`${apiBase}/repos/${args.github.owner}/${args.github.repo}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${args.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      const detail = parsed.errors?.map((e) => e.message).filter(Boolean).join("; ");
      message = detail ? `${parsed.message}: ${detail}` : (parsed.message ?? message);
    } catch {
      // Non-JSON error body; the status line is what we have.
    }
    throw new Error(message);
  }

  const created = (await response.json()) as { html_url?: string };
  if (!created.html_url) throw new Error("GitHub did not return a pull request URL");
  return created.html_url;
}

/** Discard uncommitted changes to the given paths. */
export async function discard(cwd: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  // Tracked files are restored; untracked ones have to be removed explicitly.
  await git(cwd, ["checkout", "--", ...paths]).catch(() => undefined);
  await git(cwd, ["clean", "-fd", "--", ...paths]).catch(() => undefined);
}

/** Unified diff for the working tree, optionally limited to one file. */
export async function diff(cwd: string, path?: string): Promise<string> {
  const args = ["diff", "--no-color", "HEAD"];
  if (path) args.push("--", path);
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- history

/**
 * One landed change, as git recorded it.
 *
 * Deliberately not called a "pull request". A commit that arrived through a PR carries the
 * number in its subject and gets `pullRequest` filled in; a commit someone made directly on
 * the branch does not, and inventing one would be a lie about how the change got there. This
 * type is honest about both, and the UI shows the PR badge only where there is a PR.
 */
export interface HistoryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** ISO 8601, so the client formats it in the reader's locale and timezone. */
  date: string;
  /** PR number, when the commit subject records one. */
  pullRequest?: number;
  /** Link to that PR, when the remote is a GitHub repository we can build a URL for. */
  pullRequestUrl?: string;
  /** Link to the commit itself, same condition. */
  commitUrl?: string;
  /** Which of the paths we asked about this commit touched. */
  files: string[];
  /** True for a merge commit, it has more than one parent. */
  merge: boolean;
}

/**
 * Pull the PR number out of a commit subject.
 *
 * GitHub writes it two ways and both are common in the same repository, because they
 * correspond to the two merge strategies a project can switch between at any time:
 *
 *   Merge pull request #42 from acme/feature   ← merge commit
 *   Add the customer dimension (#42)           ← squash merge
 *
 * A rebase merge records no number at all, which is why the result is optional rather than
 * defaulted, a change with no PR is a normal thing for this function to find, not a
 * parsing failure.
 */
export function pullRequestNumber(subject: string): number | undefined {
  const merge = /^Merge pull request #(\d+)\b/.exec(subject);
  if (merge) return Number(merge[1]);

  // Squash merges put it at the very end. Anchored there so a subject that merely mentions
  // "#42" in passing does not get credited to pull request 42.
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);

  return undefined;
}

/**
 * What changed, most recent first, optionally restricted to a set of paths.
 *
 * **Why paths rather than a directory.** A model's files are wherever the layout put them,
 * and under `by-kind` or `flat` they are not in a directory of their own at all, so
 * "history for this model" cannot be a folder listing. The caller passes the actual file
 * paths of the objects it cares about, which it gets from the workspace index, and that is
 * correct under every layout preset including ones a team invented themselves.
 *
 * Returns an empty list rather than throwing when the directory is not a repository or has
 * no commits yet. Both are ordinary states, a workspace someone just created has no
 * history, and a page that errors instead of saying "nothing yet" makes that look broken.
 */
export async function history(
  cwd: string,
  options: { paths?: readonly string[]; limit?: number } = {},
): Promise<{ entries: HistoryEntry[]; truncated: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
  const paths = options.paths ?? [];

  // Asking for history of an empty path set would return the whole repository's log, which
  // is emphatically not the same question. An empty scope has an empty answer.
  if (options.paths && paths.length === 0) return { entries: [], truncated: false };

  /**
   * A record separator that cannot occur in a commit message.
   *
   * `%x1f` (unit separator) between fields and `%x1e` (record separator) between commits.
   * Splitting on newlines would break on any multi-line subject, and splitting on a
   * printable delimiter breaks the day someone writes it in a commit message, which is the
   * kind of bug that appears once in production and is never reproduced.
   */
  const FIELD = "\x1f";
  const RECORD = "\x1e";
  /**
   * The record separator goes at the *front*, not the end.
   *
   * With `--name-only`, git emits the formatted header, then a newline, then the file list.
   * A trailing separator therefore falls between the header and its own files, so splitting
   * on it pairs each commit's files with the *next* commit's header, and the last commit's
   * files with nothing. The symptom is a log that returns roughly one entry regardless of how
   * many commits there are. Leading it makes each record `header
files`, which is the shape
   * the parser below actually assumes; the empty first record is skipped.
   */
  const format = RECORD + ["%H", "%h", "%s", "%an", "%ae", "%aI", "%P"].join(FIELD);

  let raw: string;
  try {
    raw = await git(cwd, [
      "log",
      `--max-count=${limit + 1}`,
      `--format=${format}`,
      "--name-only",
      // Follow content across renames, which matters here more than usual: renaming a model
      // moves every one of its files, so without this a rename truncates its own history.
      "-M",
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ]);
  } catch {
    // Not a repository, or no commits yet. Both are "nothing to show", not a failure.
    return { entries: [], truncated: false };
  }

  const entries: HistoryEntry[] = [];
  const remote = await githubRemote(cwd);

  for (const record of raw.split(RECORD)) {
    const text = record.replace(/^\s+/, "");
    if (!text) continue;

    const [header, ...rest] = text.split("\n");
    const fields = (header ?? "").split(FIELD);
    if (fields.length < 7) continue;

    const [sha, shortSha, subject, author, authorEmail, date, parents] = fields as string[];
    if (!sha) continue;

    const files = rest.map((line) => line.trim()).filter(Boolean);
    const number = pullRequestNumber(subject ?? "");

    entries.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      merge: (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1,
      files,
      ...(number ? { pullRequest: number } : {}),
      ...(number && remote
        ? { pullRequestUrl: `https://${remote.host}/${remote.owner}/${remote.repo}/pull/${number}` }
        : {}),
      ...(remote
        ? { commitUrl: `https://${remote.host}/${remote.owner}/${remote.repo}/commit/${sha}` }
        : {}),
    });
  }

  // One extra was requested so "there is more" can be reported without a second count.
  const truncated = entries.length > limit;
  return { entries: truncated ? entries.slice(0, limit) : entries, truncated };
}

/** The GitHub repository behind `origin`, when there is one we can build URLs for. */
async function githubRemote(
  cwd: string,
): Promise<{ owner: string; repo: string; host: string } | undefined> {
  try {
    const url = await git(cwd, ["remote", "get-url", "origin"]);
    return parseGitHubRemote(url.trim());
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- revisions

/** How a file changed between two revisions. */
export type FileChange = "added" | "modified" | "removed";

export interface ChangedPath {
  path: string;
  change: FileChange;
}

/**
 * Which files changed between two revisions, and how.
 *
 * `--name-status` rather than `--name-only` because the dispatcher has to tell a dropped
 * table from an edited one: those produce completely different downstream consequences, and a
 * change summary that called a deletion a modification would understate the only thing on it
 * that can break a pipeline.
 *
 * Rename detection is deliberately off (`--no-renames`). Git infers a rename from content
 * similarity, and two tables that share most of their columns look like a rename to it, so a
 * dropped `dim_customer` and an added `dim_customer_v2` would be reported as one rename and the
 * drop would vanish from the summary. Reported as a remove plus an add, the operator sees both.
 *
 * Returns an empty list rather than throwing when either revision is unknown. A workspace whose
 * history has been rewritten, or a first run with no previous sha, is an ordinary state.
 */
export async function changedBetween(
  cwd: string,
  from: string,
  to: string,
): Promise<ChangedPath[]> {
  let output: string;
  try {
    output = await git(cwd, ["diff", "--name-status", "--no-renames", "-z", `${from}..${to}`]);
  } catch {
    return [];
  }

  /*
    NUL-delimited, because a path is allowed to contain a newline.

    `-z` emits `STATUS\0PATH\0STATUS\0PATH\0…`, so the fields pair up two at a time rather
    than one record per line. Parsing this by lines works until the first model file someone
    names with a newline in it, and then fails in a way nobody reproduces.
  */
  const fields = output.split("\0").filter((field) => field.length > 0);
  const changes: ChangedPath[] = [];

  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;

    const change: FileChange | undefined =
      status.startsWith("A") ? "added" : status.startsWith("D") ? "removed" : status.startsWith("M") ? "modified" : undefined;

    // Anything else (type change, unmerged, unknown) is skipped rather than guessed at.
    if (change) changes.push({ path, change });
  }

  return changes;
}

/**
 * The contents of one file as of a revision.
 *
 * Needed to generate an ALTER: the migration is a function of the table *before* and *after*,
 * and the before only exists in history once the change has merged. Reading it out of git is
 * cheaper and far less invasive than checking out a whole second worktree to look at one file.
 *
 * `undefined` when the path did not exist at that revision, which is the normal answer for a
 * newly added file, not an error.
 */
export async function fileAtRevision(
  cwd: string,
  revision: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await git(cwd, ["show", `${revision}:${path}`]);
  } catch {
    return undefined;
  }
}

/** The commit sha a ref currently points at, or `undefined` if the ref is unknown. */
export async function revision(cwd: string, ref: string): Promise<string | undefined> {
  try {
    const sha = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return sha.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Update remote-tracking refs without touching the working tree.
 *
 * `fetch` rather than `pull` on purpose: the merge watcher needs to *observe* that the default
 * branch moved, not to move the operator's checkout onto it. A poller that quietly rebased
 * someone's working branch every thirty seconds would be a genuinely alarming thing to ship.
 *
 * Failure is swallowed. Offline, an expired credential, or a remote that has gone away are all
 * ordinary states for a background poll, and none of them should surface as an error in the UI.
 */
export async function fetchRemote(cwd: string, token?: string): Promise<boolean> {
  try {
    await git(cwd, ["fetch", "--quiet", "origin"], await authEnv(token));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `ancestor` is reachable from `descendant`.
 *
 * The honest test for "has the branch simply moved forward". `rev-parse` is not: a commit that
 * was force-pushed away usually still exists in the local object database as a dangling object,
 * so it resolves happily while being on a branch nobody can reach any more. Diffing from it
 * produces a confident description of a change that never happened.
 */
export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    // Exit code 0 means yes, 1 means no; `git()` throws on non-zero, so the catch is the "no".
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
