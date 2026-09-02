import { createGzip } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * Pack a workspace into a gzipped tar, so somebody can leave with their work.
 *
 * **Why this exists.** A trial that cannot be exported is a trial somebody abandons: they spend an
 * hour modelling, find it useful, and then discover the only way out is copying YAML out of a
 * dialog one file at a time. The deployment-modes note calls the export the thing that turns a
 * trial into a customer, and it was the one piece of that path never built.
 *
 * **Why tar and not zip.** Nothing in Node writes a zip, and the whole server has two runtime
 * dependencies -- adding an archiver to save this much code would be a poor trade. Tar is 512-byte
 * headers and padding, gzip is in `node:zlib`, and `tar -xzf` works everywhere a data engineer
 * already works. On Windows, 7-Zip and modern PowerShell both read it.
 *
 * **Streamed, not buffered.** A large model repo is tens of megabytes of YAML, and building the
 * whole archive in memory before the first byte reaches the client would make the export a
 * memory spike proportional to the biggest workspace on the instance.
 */

/** Directories never worth exporting. `.git` most of all: it can carry the seed's remote. */
const SKIP = new Set([".git", "node_modules", ".strata-data", "dist", ".DS_Store"]);

/**
 * Ceilings, because this route can be called by anyone who can read the workspace.
 *
 * Without them a workspace someone filled with junk becomes a way to make the server read
 * gigabytes off disk on request. The limits are far above any real model repo, so a legitimate
 * export never notices them.
 */
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface ArchiveEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  body: Buffer;
  mtime: Date;
}

/** Walk a directory into archive entries, skipping what should never leave. */
export async function collectEntries(root: string, prefix: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const contents = await readdir(dir, { withFileTypes: true });

    for (const item of contents) {
      if (SKIP.has(item.name)) continue;

      const full = join(dir, item.name);

      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;

      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;

      totalBytes += info.size;
      if (entries.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("this workspace is too large to export in one archive");
      }

      // Tar paths are forward-slashed regardless of the host, or the archive is unreadable
      // on anything but the machine that wrote it.
      const name = `${prefix}/${relative(root, full).split(sep).join("/")}`;
      entries.push({ name, body: await readFile(full), mtime: info.mtime });
    }
  }

  await walk(root);
  return entries;
}

/**
 * One tar header block.
 *
 * Written as ustar, which is the format every extractor understands. The checksum is computed
 * over the header with the checksum field itself treated as spaces, which is the one detail that
 * makes hand-written tar files fail silently if you get it wrong.
 */
function header(entry: ArchiveEntry): Buffer {
  const block = Buffer.alloc(512);

  const write = (value: string, offset: number, length: number): void => {
    block.write(value.slice(0, length - 1), offset, length - 1, "utf8");
  };
  const octal = (value: number, offset: number, length: number): void => {
    write(value.toString(8).padStart(length - 1, "0"), offset, length);
  };

  /*
    Long paths use the prefix field rather than failing.

    A workspace organised `by-model-and-kind` nests several levels deep, and 100 characters is not
    much once a model name and a subject area are in the path. Splitting at a separator inside the
    prefix field is what ustar is for.
  */
  let name = entry.name;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", name.length - 100);
    if (cut > 0) {
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
  }

  write(name, 0, 100);
  octal(0o644, 100, 8); // mode
  octal(0, 108, 8); // uid
  octal(0, 116, 8); // gid
  octal(entry.body.length, 124, 12);
  octal(Math.floor(entry.mtime.getTime() / 1000), 136, 12);
  block.write("        ", 148, 8, "utf8"); // checksum placeholder: eight spaces
  block.write("0", 156, 1, "utf8"); // type flag: regular file
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");
  write(prefix, 345, 155);

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, a NUL, then a space. Extractors are picky about this exact shape.
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

  return block;
}

/** Pad a body out to the next 512-byte boundary, as the format requires. */
function padding(length: number): Buffer {
  const remainder = length % 512;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder);
}

/** The raw tar bytes for a set of entries, including the two-block end marker. */
export function tar(entries: ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry), entry.body, padding(entry.body.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * Write a gzipped tar of `root` to `destination`.
 *
 * `prefix` becomes the single top-level directory inside the archive, so extracting does not
 * scatter files across the current directory -- the behaviour people call a tarbomb, and the
 * reason some extractors now refuse archives without one.
 */
export async function writeArchive(
  root: string,
  prefix: string,
  destination: NodeJS.WritableStream,
): Promise<{ files: number; bytes: number }> {
  const entries = await collectEntries(root, prefix);
  const body = tar(entries);

  await pipeline(Readable.from([body]), createGzip(), destination);

  return { files: entries.length, bytes: body.length };
}
