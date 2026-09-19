import { access, mkdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Can this deployment actually create a model repository where it has been pointed?
 *
 * Asked *before* the UI offers the button, which is the part that was missing. `/api/workspace`
 * reported `needsInit: true` on any directory without a config file, whether or not the process
 * could write there, so the setup screen always offered "Create repository" and the operator
 * discovered the truth by pressing it and reading a 500.
 *
 * **The path is a container path, and the person reading it is in a browser.** They cannot `cd`
 * to it, cannot `chmod` it, and cannot pick a different one, so showing it alone is not a
 * diagnosis. What they can act on is the environment variable that produced it, which is why
 * every reason below names `STRATA_WORKSPACE` rather than describing the filesystem.
 *
 * Deliberately **not** something the client may set. A browser choosing a server-side path is
 * arbitrary write, not a convenience feature. Configuration stays in the environment; this
 * module only explains what the environment did.
 */

export interface RootDiagnosis {
  /** Whether a repository could be created here right now. */
  writable: boolean;
  /** Why not, in a sentence an operator can act on. Absent when writable. */
  reason?: string;
  /**
   * A named, certain misconfiguration rather than a guess.
   *
   * Set only when the shape of the path proves what happened. A generic permissions failure has
   * many causes and gets no hint; a Windows drive letter inside a Linux container has one.
   */
  hint?: string;
}

/**
 * A Windows drive letter embedded in a POSIX path.
 *
 * `/app/C:/Program Files/Git/app/examples/quickstart` is not a path anybody typed. It is what
 * Git Bash produces from `-e STRATA_WORKSPACE=/app/examples/quickstart`: MSYS rewrites any
 * argument shaped like a Unix path into a host path before Docker ever sees it.
 *
 * Worth detecting specifically because it is the one failure where the cause is certain and the
 * fix is one character. Everything else here can only report what the filesystem said.
 */
function mangledByShell(root: string): boolean {
  // A drive letter anywhere but the very start: on Linux it cannot be a real path, and on
  // Windows a legitimate root already begins with it.
  return /[/\\][A-Za-z]:[/\\]/.test(root);
}

/** The nearest ancestor that exists, so we can ask whether we may create the rest. */
async function nearestExisting(root: string): Promise<string | undefined> {
  let current = root;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * Check the workspace root, without creating anything the caller did not ask for.
 *
 * Probes with a temporary directory rather than trusting `access(W_OK)` alone. On a container
 * with an unusual uid, or a read-only mount, or an overlay, `access` reports what the mode bits
 * say and the write still fails. The only reliable test of "can I create a directory here" is to
 * create one, so this creates one and removes it.
 */
export async function diagnoseRoot(root: string): Promise<RootDiagnosis> {
  if (!root.trim()) {
    return {
      writable: false,
      reason: "STRATA_WORKSPACE is empty, so there is nowhere to create a repository.",
    };
  }

  if (mangledByShell(root)) {
    return {
      writable: false,
      reason: `STRATA_WORKSPACE resolved to ${root}, which is not a path inside this container.`,
      hint:
        "A Windows drive letter appears in a Linux path, which means a shell rewrote the value. " +
        "Git Bash on Windows expands anything that looks like a Unix path, so " +
        "`-e STRATA_WORKSPACE=/app/examples/quickstart` arrives mangled. Use a relative path, " +
        "`-e STRATA_WORKSPACE=examples/quickstart`, or run the command from PowerShell.",
    };
  }

  const existing = await nearestExisting(root);
  if (!existing) {
    return {
      writable: false,
      reason: `Nothing along ${root} exists, and no parent of it does either.`,
      hint: isAbsolute(root)
        ? "Check STRATA_WORKSPACE, and that the volume you expect is actually mounted."
        : "The path is relative, so it resolves against the container's working directory.",
    };
  }

  const probe = join(existing, `.strata-write-probe-${process.pid}`);
  try {
    await mkdir(probe);
    await rm(probe, { recursive: true, force: true });
    return { writable: true };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    return {
      writable: false,
      reason: `Cannot write to ${existing} (${code}).`,
      hint:
        code === "EACCES" || code === "EPERM"
          ? "The container runs as uid 10001. A bind-mounted host directory keeps the host's " +
            "ownership, so either chown it to 10001 or pass --user with your own uid."
          : code === "EROFS"
            ? "The filesystem is mounted read only."
            : "Check STRATA_WORKSPACE points where you think it does.",
    };
  } finally {
    // Belt and braces: a crash between mkdir and rm must not leave a probe directory behind
    // inside somebody's model repository, where it would show up in `git status`.
    await rm(probe, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether the path is readable at all, used to tell "empty" apart from "unreachable". */
export async function rootReadable(root: string): Promise<boolean> {
  try {
    await access(root, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
