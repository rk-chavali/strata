import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PathError,
  listFiles,
  readWorkspaceFile,
  resolveInside,
  writeWorkspaceFile,
} from "./files.js";

/**
 * The workspace file browser.
 *
 * Most of these tests are about one thing: **a caller-supplied path must never reach
 * outside the workspace**. These endpoints take a string from the browser and turn it into
 * a filesystem read or a write, which is the exact shape of a directory-traversal bug, * and the write side means a mistake is not "you saw a file you should not have", it is
 * "you overwrote a file on the host".
 *
 * So the escape attempts are enumerated rather than sampled. Each one is a real technique:
 * plain `..`, an absolute path, a NUL truncation, and the sibling-prefix trick that beats a
 * naive `startsWith` check.
 */

let root: string;
let outside: string;

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "strata-files-"));
  root = join(scratch, "workspace");
  outside = join(scratch, "secrets");

  await mkdir(join(root, "models", "retail"), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, "strata.config.yaml"), "name: test\n", "utf8");
  await writeFile(join(root, "models", "retail", "customer.yaml"), "id: c\nkind: entity\n", "utf8");
  await writeFile(join(outside, "private.txt"), "do not read me", "utf8");

  // Things the walker must skip rather than surface.
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await mkdir(join(root, "node_modules", "thing"), { recursive: true });
  await writeFile(join(root, "node_modules", "thing", "index.js"), "module.exports={}\n", "utf8");

  // A sibling whose name starts with the workspace's, to catch a naive prefix check.
  await mkdir(`${root}-evil`, { recursive: true });
  await writeFile(join(`${root}-evil`, "gotcha.txt"), "nope", "utf8");
}, 60_000);

afterAll(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true }).catch(() => {});
});

describe("resolveInside", () => {
  it("accepts a path within the workspace", () => {
    expect(resolveInside(root, "models/retail/customer.yaml")).toBe(
      join(root, "models", "retail", "customer.yaml"),
    );
  });

  it("rejects a parent-directory escape", () => {
    expect(() => resolveInside(root, "../secrets/private.txt")).toThrow(PathError);
    expect(() => resolveInside(root, "models/../../secrets/private.txt")).toThrow(PathError);
  });

  it("rejects a deeply nested escape", () => {
    expect(() => resolveInside(root, "../../../../../../etc/passwd")).toThrow(PathError);
  });

  it("rejects an absolute path", () => {
    // `resolve(base, "/etc/passwd")` yields `/etc/passwd`, the base is discarded entirely,
    // which is precisely why the containment check runs on the resolved result.
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(PathError);
    expect(() => resolveInside(root, outside)).toThrow(PathError);
  });

  it("rejects a sibling directory that merely shares the prefix", () => {
    // `${root}-evil` starts with `${root}`, so a `startsWith(root)` check would pass it.
    // The guard compares against `root + separator` for exactly this case.
    expect(() => resolveInside(root, "../workspace-evil/gotcha.txt")).toThrow(PathError);
  });

  it("rejects a NUL byte, which truncates the path at the syscall", () => {
    expect(() => resolveInside(root, "strata.config.yaml\0.png")).toThrow(PathError);
  });

  it("rejects an empty path", () => {
    expect(() => resolveInside(root, "")).toThrow(PathError);
  });

  it("normalises redundant segments rather than refusing them", () => {
    // `./` and doubled slashes are untidy, not hostile; refusing them would break links
    // built by joining strings.
    expect(resolveInside(root, "./models/./retail/customer.yaml")).toBe(
      join(root, "models", "retail", "customer.yaml"),
    );
  });
});

describe("listFiles", () => {
  it("lists model files with repo-relative forward-slash paths", async () => {
    const entries = await listFiles(root);
    const paths = entries.map((entry) => entry.path);

    expect(paths).toContain("strata.config.yaml");
    expect(paths).toContain("models/retail/customer.yaml");
    // Forward slashes even on Windows, because the client treats the path as an id.
    expect(paths.every((path) => !path.includes("\\"))).toBe(true);
  });

  it("skips .git and node_modules", async () => {
    const paths = (await listFiles(root)).map((entry) => entry.path);

    expect(paths.some((path) => path.startsWith(".git"))).toBe(false);
    expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
  });

  it("keeps .gitattributes, which is part of the model repo's contract", async () => {
    // `strata init` writes it to pin LF endings; hiding it would hide why diffs behave.
    await writeFile(join(root, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
    const paths = (await listFiles(root)).map((entry) => entry.path);
    expect(paths).toContain(".gitattributes");
  });

  it("returns depth-first order, so the client can rebuild the tree from path depth", async () => {
    // The client renders a flat list and infers nesting from how many slashes a path has.
    // That only works if a directory is immediately followed by its own contents. Sorting
    // the whole result globally, every directory, then every file, indents like a tree
    // and reads like nonsense, which is exactly what the first version did.
    const entries = await listFiles(root);
    const paths = entries.map((entry) => entry.path);

    const modelsAt = paths.indexOf("models");
    const customerAt = paths.indexOf("models/retail/customer.yaml");

    expect(modelsAt).toBeGreaterThanOrEqual(0);
    expect(customerAt).toBeGreaterThan(modelsAt);

    // Everything between a directory and its descendant belongs to that directory.
    for (const path of paths.slice(modelsAt + 1, customerAt)) {
      expect(path.startsWith("models/")).toBe(true);
    }
  });

  it("puts directories before files within the same parent", async () => {
    await writeFile(join(root, "models", "zzz-file.yaml"), "id: z\nkind: entity\n", "utf8");
    const entries = await listFiles(root);

    const children = entries.filter(
      (entry) => entry.path.startsWith("models/") && entry.path.split("/").length === 2,
    );
    const firstFile = children.findIndex((entry) => entry.type === "file");
    const lastDirectory = children.map((entry) => entry.type).lastIndexOf("directory");

    expect(firstFile).toBeGreaterThanOrEqual(0);
    expect(lastDirectory).toBeLessThan(firstFile);
  });

  it("reports a size for files", async () => {
    const entry = (await listFiles(root)).find((candidate) => candidate.path === "strata.config.yaml");
    expect(entry?.size).toBeGreaterThan(0);
  });
});

describe("readWorkspaceFile", () => {
  it("reads a file inside the workspace", async () => {
    const result = await readWorkspaceFile(root, "models/retail/customer.yaml");
    expect(result.contents).toContain("kind: entity");
    expect(result.binary).toBe(false);
  });

  it("refuses to read outside the workspace", async () => {
    await expect(readWorkspaceFile(root, "../secrets/private.txt")).rejects.toThrow(PathError);
  });

  it("refuses a directory", async () => {
    await expect(readWorkspaceFile(root, "models")).rejects.toThrow(PathError);
  });

  it("reports binary files rather than returning mojibake", async () => {
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47]));
    const result = await readWorkspaceFile(root, "logo.png");

    expect(result.binary).toBe(true);
    expect(result.contents).toBe("");
  });
});

describe("writeWorkspaceFile", () => {
  it("writes a file and reports whether it was created", async () => {
    const first = await writeWorkspaceFile(root, "models/retail/new.yaml", "id: n\nkind: entity\n");
    expect(first.created).toBe(true);

    const second = await writeWorkspaceFile(root, "models/retail/new.yaml", "id: n\nkind: entity\n");
    expect(second.created).toBe(false);
  });

  it("creates missing directories on the way down", async () => {
    await writeWorkspaceFile(root, "models/brand/new/deep.yaml", "id: d\nkind: entity\n");
    const result = await readWorkspaceFile(root, "models/brand/new/deep.yaml");
    expect(result.contents).toContain("kind: entity");
  });

  it("normalises CRLF to LF", async () => {
    // A browser textarea hands back CRLF. Writing it would make every file read as
    // modified on a Windows checkout and bury the diffs this tool exists to produce.
    await writeWorkspaceFile(root, "models/retail/crlf.yaml", "a: 1\r\nb: 2\r\n");
    const result = await readWorkspaceFile(root, "models/retail/crlf.yaml");

    expect(result.contents).toBe("a: 1\nb: 2\n");
    expect(result.contents).not.toContain("\r");
  });

  it("refuses to write outside the workspace", async () => {
    // The one that matters most: a traversal on the write path overwrites host files.
    await expect(
      writeWorkspaceFile(root, "../secrets/private.txt", "overwritten"),
    ).rejects.toThrow(PathError);

    const untouched = await readWorkspaceFile(resolve(root, ".."), "secrets/private.txt");
    expect(untouched.contents).toBe("do not read me");
  });

  it("refuses an absolute path", async () => {
    await expect(
      writeWorkspaceFile(root, join(outside, "private.txt"), "overwritten"),
    ).rejects.toThrow(PathError);
  });
});
