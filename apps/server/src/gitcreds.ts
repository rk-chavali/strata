import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Let the stored PAT authenticate `git push` and `git fetch`.
 *
 * The obvious approach is to bake the token into the remote URL, * `https://x-access-token:TOKEN@github.com/owner/repo.git`, and it is the wrong one:
 * git writes that URL verbatim into `.git/config`, which is a plaintext credential
 * sitting inside the repository the tool exists to manage. It then leaks into every
 * `git remote -v`, every error message that echoes the URL, and any backup of the
 * working tree.
 *
 * The second-most-obvious is `-c http.extraheader="Authorization: Bearer ..."`, which
 * keeps it out of the config but puts it in the process arguments, where any other
 * process on the host can read it from `ps`.
 *
 * So: `GIT_ASKPASS`. Git runs the named program when it needs a credential, and the
 * token travels in the child process environment instead, readable only by the same
 * user, never persisted, and gone when the process exits. This is the mechanism the
 * GitHub CLI uses for the same reason.
 */

/** The helper script git will call. Written once per process, then reused. */
let helperPath: Promise<string> | undefined;

const POSIX_HELPER = `#!/bin/sh
# Git asks for the username first, then the password. A PAT goes in the password
# slot; the username is ignored by GitHub but must be non-empty.
case "$1" in
  Username*) echo "x-access-token" ;;
  *) echo "$STRATA_GIT_TOKEN" ;;
esac
`;

const WINDOWS_HELPER = `@echo off
echo %~1 | findstr /B /C:"Username" >nul
if %errorlevel%==0 (echo x-access-token) else (echo %STRATA_GIT_TOKEN%)
`;

async function ensureHelper(): Promise<string> {
  if (helperPath) return helperPath;

  helperPath = (async () => {
    const dir = join(tmpdir(), "strata-git");
    await mkdir(dir, { recursive: true });

    const windows = process.platform === "win32";
    const path = join(dir, windows ? "askpass.cmd" : "askpass.sh");
    await writeFile(path, windows ? WINDOWS_HELPER : POSIX_HELPER, "utf8");
    // Owner-only, and executable, git runs this directly.
    if (!windows) await chmod(path, 0o700);
    return path;
  })();

  return helperPath;
}

/**
 * Environment for a git command that may need to authenticate.
 *
 * Returns the ambient environment untouched when there is no token, so a deployment
 * already using an SSH agent, a credential helper or a deploy key keeps working exactly
 * as it did. Supplying a token is an addition, never a replacement.
 */
export async function authEnv(token: string | undefined): Promise<NodeJS.ProcessEnv> {
  if (!token) return process.env;

  return {
    ...process.env,
    GIT_ASKPASS: await ensureHelper(),
    STRATA_GIT_TOKEN: token,
    /**
     * Without this, a rejected token makes git open an interactive prompt on a
     * terminal nobody is watching, and the request hangs until the HTTP client gives
     * up. Failing immediately turns that into a readable error instead.
     */
    GIT_TERMINAL_PROMPT: "0",
    // Same reasoning for the desktop credential helpers, which pop a window on a
    // machine with no one at it.
    GIT_ASKPASS_REQUIRE: "1",
  };
}

/**
 * Strip credentials out of a URL before it is shown or stored.
 *
 * Someone pasting a repo URL will sometimes paste one that already has a token in it,
 * copied from a CI config. Setting that as the remote would put the credential straight
 * into `.git/config`, precisely what the rest of this module avoids, so the userinfo
 * is removed and the token handled through the normal path.
 */
export function stripCredentials(url: string): string {
  const trimmed = url.trim();
  const match = /^(https?:\/\/)([^/@]*@)(.+)$/.exec(trimmed);
  return match ? `${match[1]}${match[3]}` : trimmed;
}

/** A GitHub HTTPS remote we can actually push to and open pull requests against. */
export function validateRemoteUrl(url: string): { ok: true; url: string } | { ok: false; error: string } {
  const clean = stripCredentials(url);
  if (!clean) return { ok: false, error: "a repository URL is required" };

  if (clean.startsWith("git@") || clean.startsWith("ssh://")) {
    return {
      ok: false,
      error: "SSH remotes authenticate with a key, not a token, use the HTTPS URL instead",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return { ok: false, error: "that is not a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "use an https:// URL so the token can authenticate" };
  }
  if (!/^\/[^/]+\/[^/]+/.test(parsed.pathname)) {
    return { ok: false, error: "the URL should look like https://host/owner/repo.git" };
  }

  return { ok: true, url: clean };
}
