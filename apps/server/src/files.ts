import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Reading and writing the model repository as files.
 *
 * The tool's central claim is that the model *is* files in a git repository, and until
 * now nothing in the UI ever showed you one. You edited boxes, pressed Propose, and raised
 * a pull request over changes you had never seen. This is what makes the claim inspectable:
 * the same repository, browsable and editable, one toggle away from the diagram.
 *
 * **Every path that arrives here is hostile until proven otherwise.** These endpoints take
 * a caller-supplied path and turn it into a filesystem read or write, which is the classic
 * shape of a directory-traversal bug. `../../../etc/passwd` and an absolute path are the
 * obvious attempts; a symlink pointing out of the tree is the one people forget. The guard
 * below is the only thing standing between a workspace browser and arbitrary file access on
 * the host, so it resolves first and compares afterwards rather than trusting any string.
 */

/** Directories never worth showing, and expensive to walk. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".strata-data", ".strata", "dist", ".next"]);

/** A hard ceiling, so one enormous file cannot wedge the browser or the response. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Resolve a repo-relative path to an absolute one, or refuse.
 *
 * `resolve` collapses `..` segments *before* the comparison, so a traversal attempt is
 * caught by the containment check rather than by pattern-matching the input, which is the
 * difference between a guard that holds and one that loses to `....//`.
 *
 * The trailing separator on `root` matters: without it, a sibling directory named
 * `workspace-evil` passes a naive `startsWith("…/workspace")`.
 */
export function resolveInside(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathError("a path is required");
  }
  // A NUL byte truncates the path at the syscall boundary, so `a.yaml\0.png` can read
  // something other than what was validated.
  if (requested.includes("\0")) throw new PathError("invalid path");

  const base = resolve(root);
  const absolute = resolve(base, requested);

  if (absolute !== base && !absolute.startsWith(base + sep)) {
    throw new PathError(`path escapes the workspace: ${requested}`);
  }
  return absolute;
}

export interface FileEntry {
  /** Repo-relative, always with forward slashes so the client can treat it as an id. */
  path: string;
  name: string;
  type: "file" | "directory";
  /** Bytes, for files only. */
  size?: number;
}

/**
 * Walk the repository.
 *
 * Returns a flat list rather than a nested tree: the client builds whatever shape it wants
 * to render, and a flat list is far easier to filter, sort and diff against git status
 * without walking a structure twice.
 */
export async function listFiles(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(directory: string): Promise<void> {
    let contents;
    try {
      contents = await readdir(directory, { withFileTypes: true });
    } catch {
      // An unreadable directory is not a reason to fail the whole listing.
      return;
    }

    /**
     * Order within this directory only, then recurse immediately.
     *
     * The result has to arrive in depth-first order, because the client renders it as a
     * flat list and infers the tree from path depth. Sorting the *whole* result at the end
     * instead, directories before files globally, put every directory in the repo at the
     * top and every file underneath, which indents like a tree and reads like nonsense.
     */
    contents.sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of contents) {
      if (entry.name.startsWith(".") && entry.name !== ".gitattributes" && entry.name !== ".gitignore") {
        continue;
      }
      if (SKIP_DIRECTORIES.has(entry.name)) continue;

      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");

      if (entry.isDirectory()) {
        entries.push({ path: rel, name: entry.name, type: "directory" });
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      let size: number | undefined;
      try {
        size = (await stat(absolute)).size;
      } catch {
        size = undefined;
      }

      entries.push({
        path: rel,
        name: entry.name,
        type: "file",
        ...(size === undefined ? {} : { size }),
      });
    }
  }

  await walk(resolve(root));

  // Already in depth-first order, with each directory's own children sorted. Re-sorting
  // here would destroy the hierarchy the client reconstructs from path depth.
  return entries;
}

export interface FileContents {
  path: string;
  contents: string;
  size: number;
  /** True when the file is not valid UTF-8 text, in which case `contents` is empty. */
  binary: boolean;
}

export async function readWorkspaceFile(root: string, requested: string): Promise<FileContents> {
  const absolute = resolveInside(root, requested);
  const info = await stat(absolute);

  if (info.isDirectory()) throw new PathError(`${requested} is a directory`);
  if (info.size > MAX_FILE_BYTES) {
    throw new PathError(
      `${requested} is ${Math.round(info.size / 1024)}KB; files over ${MAX_FILE_BYTES / 1024 / 1024}MB are not shown`,
    );
  }

  const raw = await readFile(absolute);

  /**
   * Detect binary by looking for a NUL byte.
   *
   * Crude, and right for this: every file a model repository legitimately contains is
   * text, and rendering a PNG as mojibake in an editor is worse than saying "binary".
   */
  const binary = raw.includes(0);

  return {
    path: requested.split(sep).join("/"),
    contents: binary ? "" : raw.toString("utf8"),
    size: info.size,
    binary,
  };
}

export async function writeWorkspaceFile(
  root: string,
  requested: string,
  contents: string,
): Promise<{ path: string; created: boolean }> {
  const absolute = resolveInside(root, requested);

  let created = false;
  try {
    const info = await stat(absolute);
    if (info.isDirectory()) throw new PathError(`${requested} is a directory`);
  } catch (error) {
    if (error instanceof PathError) throw error;
    created = true;
  }

  await mkdir(dirname(absolute), { recursive: true });

  /**
   * Always LF.
   *
   * `strata init` writes a `.gitattributes` pinning the whole repo to LF for a reason: git on
   * Windows otherwise checks files back out as CRLF, every file reads as modified, and the
   * diffs this tool exists to produce get buried in line-ending noise. A browser textarea
   * hands back CRLF, so normalising here is what keeps that promise.
   */
  await writeFile(absolute, contents.replace(/\r\n/g, "\n"), "utf8");
  return { path: requested.split(sep).join("/"), created };
}
