import { randomBytes } from "node:crypto";

/**
 * Object identity.
 *
 * Every model object carries an immutable `id` that never changes for the
 * lifetime of the object, not when it is renamed, not when it is moved to a
 * different file or folder. Identity is what lets us tell a rename apart from a
 * delete-plus-add during a merge, and it is why users can reorganise the repo
 * layout freely without breaking anything.
 *
 * References between objects, by contrast, are written as readable qualified
 * names so that a pull request diff is legible to a human reviewer. See
 * `graph.ts` for how those are resolved.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Short, human-recognisable prefix per object kind. */
export const ID_PREFIXES = {
  model: "mdl",
  subjectArea: "sa",
  glossaryTerm: "term",
  domain: "dom",
  concept: "cpt",
  entity: "ent",
  attribute: "att",
  table: "tbl",
  column: "col",
  relationship: "rel",
  mapping: "map",
  diagram: "dgm",
  namingStandard: "nst",
} as const;

export type IdPrefixKey = keyof typeof ID_PREFIXES;

function encodeTime(time: number, len: number): string {
  let remaining = time;
  let out = "";
  for (let i = 0; i < len; i++) {
    const mod = remaining % 32;
    out = CROCKFORD[mod]! + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CROCKFORD[bytes[i]! % 32]!;
  }
  return out;
}

/**
 * Generate a lexicographically sortable, collision-resistant id.
 *
 * The time prefix means ids sort by creation order, which keeps generated files
 * and diffs stable and makes "what was added most recently" cheap to answer.
 */
export function newId(kind: IdPrefixKey): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(Date.now(), TIME_LEN)}${encodeRandom(RANDOM_LEN)}`;
}

/**
 * Ids are deliberately permissive on read so hand-authored files stay easy to
 * write. We only require a non-empty, path-and-URL-safe token; the generator
 * above produces the canonical form.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Extract the kind prefix from a canonical id, if it has one. */
export function idPrefix(id: string): string | undefined {
  const idx = id.indexOf("_");
  return idx > 0 ? id.slice(0, idx) : undefined;
}
